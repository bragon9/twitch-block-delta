"use strict";
// Stage 1 blocking. Rewrites the page's media playlists in flight: stitched ads
// are replaced with the same live segments from other logged-in "embed" playback
// sessions of the same rendition (backups), and client ad markers are removed.
// The player is never paused, reloaded or resumed, so hidden tabs behave exactly
// like visible ones.
//
// No backup is assumed to be ad-free: Twitch can put an ad into any session, at
// that session's own time. So each channel keeps a small pool of backups, all
// merged, and opens another whenever none of them can supply the live edge.

const BACKUP_PLAYER_TYPE = "embed";
const BACKUP_FETCH_TIMEOUT_MS = 3_000;
// A backup nothing has used for this long is closed; its token may have expired.
const BACKUP_IDLE_MS = 5 * 60_000;
// Upper bound on backups per channel, and on how often a new one is opened.
const MAX_BACKUPS = 6;
const BACKUP_OPEN_INTERVAL_MS = 3_000;
// A backup whose newest segment has been an ad this long is closed, to free its slot.
const BACKUP_STUCK_MS = 60_000;

// channel -> { backups: [...], lastOpenedAt } for that channel's backup sessions.
const backupPools = new Map();
let nextBackupId = 1;
// Media playlist URL -> splice memory.
const splicedStreams = new Map();
// Playback sessions (one per master playlist) that have had a stitched ad, ->
// the live sequence ranges lost in that session. From then on every rendition
// of the session is numbered by live sequence, minus what was lost, so a
// quality switch after a blocked ad lands on consistent numbers.
const splicedSessions = new Map();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function backupPool(channel) {
  if (!backupPools.has(channel)) backupPools.set(channel, { backups: [], lastOpenedAt: 0 });
  return backupPools.get(channel);
}

// Starts a new playback session for the channel. Returns at once; `ready`
// settles when its master playlist is in.
function openBackup(pool, channel, usherParams, reason) {
  const backup = { id: nextBackupId++, openedAt: Date.now(), lastUsedAt: Date.now(), ready: null, settled: false, adSince: null, reason };
  backup.ready = (async () => {
    const oauth = await getTwitchOAuth();
    const token = await fetchAccessToken(channel, BACKUP_PLAYER_TYPE, oauth);
    const master = parseMaster(await fetchText(buildUsherUrl(channel, token, usherParams)));
    return { master, auth: oauth ? "user" : "anon" };
  })();
  backup.ready.then(
    () => (backup.settled = true),
    () => closeBackup(pool, backup),
  );
  pool.backups.push(backup);
  pool.lastOpenedAt = Date.now();
  return backup;
}

function closeBackup(pool, backup) {
  const i = pool.backups.indexOf(backup);
  if (i !== -1) pool.backups.splice(i, 1);
}

async function fetchFromBackup(backup, variant) {
  const { master, auth } = await backup.ready;
  const backupVariant = pickVariant(master.variants, variant);
  if (!backupVariant) throw new Error(`backup has no ${variant.name} (${variant.codecs})`);
  const text = await fetchText(backupVariant.url);
  return { text, url: backupVariant.url, variant: backupVariant.name, auth };
}

// Fetches this rendition from every backup in the channel's pool. A backup still
// starting up is only waited for when no other backup is ready, so opening one
// never delays the player.
async function fetchBackups(variant, usherParams, events) {
  const pool = backupPool(variant.channel);
  const now = Date.now();
  for (const backup of [...pool.backups]) {
    if (now - backup.lastUsedAt > BACKUP_IDLE_MS) {
      closeBackup(pool, backup);
      events.push({ closed: backup.id, reason: "idle" });
    }
  }
  const poll = (backups) =>
    Promise.all(
      backups.map(async (backup) => {
        // Ad time only counts while the backup is in use, not across breaks.
        if (now - backup.lastUsedAt > BACKUP_STUCK_MS) backup.adSince = null;
        backup.lastUsedAt = now;
        try {
          return { backup, ...(await withTimeout(fetchFromBackup(backup, variant), BACKUP_FETCH_TIMEOUT_MS, "backup")) };
        } catch (err) {
          return { backup, text: null, error: String(err?.message || err) };
        }
      }),
    );
  const fresh = () => {
    const backup = openBackup(pool, variant.channel, usherParams, pool.backups.length ? "every backup failed" : "none open");
    events.push({ opened: backup.id, reason: backup.reason });
    return poll([backup]);
  };
  if (pool.backups.length === 0) return fresh();
  const anyReady = pool.backups.some((b) => b.settled);
  const results = await poll(pool.backups.filter((b) => b.settled || !anyReady));
  // Every backup failed, typically because their sessions expired: retry once
  // with a new one, so the player still gets a backup this time.
  if (results.every((r) => r.error)) return [...results, ...(await fresh())];
  return results;
}

// Decides what to do with a channel's pool after a poll. `polled`: one
// { backup, error, liveAtEdge } per backup fetched. Updates each backup's
// ad timer; returns the backups to close and whether to open another.
function planPool(pool, polled, nativeLiveAtEdge, now) {
  const close = [];
  for (const { backup, error, liveAtEdge } of polled) {
    // Usually an expired session; a fresh one replaces it if needed.
    if (error) {
      close.push({ backup, reason: error });
      continue;
    }
    if (liveAtEdge) backup.adSince = null;
    else backup.adSince ??= now;
    if (backup.adSince !== null && now - backup.adSince > BACKUP_STUCK_MS) close.push({ backup, reason: "stuck in an ad" });
  }
  // Any source that can supply the live edge right now is enough.
  const covered = nativeLiveAtEdge || polled.some((p) => !p.error && p.liveAtEdge);
  const open = !covered && pool.backups.length - close.length < MAX_BACKUPS && now - pool.lastOpenedAt >= BACKUP_OPEN_INTERVAL_MS;
  return { close, open };
}

function tendPool(variant, usherParams, results, stats, events) {
  const pool = backupPool(variant.channel);
  const polled = results.map((r, i) => ({ backup: r.backup, error: r.error ?? null, liveAtEdge: stats.backups[i]?.liveAtEdge ?? false }));
  const { close, open } = planPool(pool, polled, stats.nativeLiveAtEdge, Date.now());
  for (const { backup, reason } of close) {
    closeBackup(pool, backup);
    events.push({ closed: backup.id, reason });
  }
  if (!open) return;
  const backup = openBackup(pool, variant.channel, usherParams, "no source live at the edge");
  events.push({ opened: backup.id, reason: backup.reason });
}

// Returns { text, action, ... }. Actions:
//   pass            untouched
//   strip-markers   client ad markers removed, nothing else changed
//   splice          ad segments replaced with backup live segments
//   drop-ad         ad dropped and the backups had nothing to add: at a break's edges
//                   the ad is only past the live edge, or already over
//   renumber        no ad right now; renumbered to stay continuous after an earlier splice
//   strip-ad        ad dropped but no backup came through; the player waits at the live edge
//   fallback-native nothing live to serve (e.g. pre-roll with no backup); the ad plays
async function rewriteMediaPlaylist(url, nativeText, variant, usherParams) {
  const analysis = analyzeMedia(nativeText);
  // Empty or non-playlist bodies (aborted requests, errors) pass through and
  // must not change any state.
  if (!analysis.valid) return { text: nativeText, action: "pass-invalid", analysis };
  let memory = splicedStreams.get(url);
  const sessionSpliced = variant ? splicedSessions.has(variant.session) : false;
  if (!memory && !sessionSpliced && analysis.adKind !== "stitched") {
    if (analysis.adKind === "client") return { text: stripAdMarkers(nativeText).text, action: "strip-markers", analysis };
    return { text: nativeText, action: "pass", analysis };
  }
  if (variant) remember(splicedSessions, variant.session, splicedSessions.get(variant.session) ?? []);
  if (!memory) {
    memory = newSpliceMemory(variant ? splicedSessions.get(variant.session) : []);
    remember(splicedStreams, url, memory);
  }

  let results = [];
  let error = null;
  const poolEvents = [];
  if (analysis.adKind === "stitched") {
    if (variant) results = await fetchBackups(variant, usherParams, poolEvents);
    else error = "rendition unknown (its master playlist was not seen)";
  }

  const { text, stats } = spliceMediaPlaylist(nativeText, results.map((r) => r.text), memory);
  if (variant && results.length) tendPool(variant, usherParams, results, stats, poolEvents);
  const fetched = results.filter((r) => r.text);
  // Only an error when no backup came through; one failing among several is routine.
  if (!error && results.length && !fetched.length) error = [...new Set(results.map((r) => r.error))].join("; ");
  const base = {
    analysis,
    stats,
    error,
    backupVariant: fetched[0]?.variant ?? null,
    backupAuth: fetched[0]?.auth ?? null,
    // Every backup playlist this rewrite used, so any splice can be replayed exactly.
    backups: results.map(({ backup, text: backupText, url: backupUrl, variant: name, auth, error: backupError }, i) => ({
      id: backup.id,
      variant: name ?? null,
      auth: auth ?? null,
      url: backupUrl ?? null,
      text: backupText ?? null,
      error: backupError ?? null,
      liveAtEdge: stats.backups[i]?.liveAtEdge ?? null,
    })),
    pool: results.length ? { size: backupPool(variant.channel).backups.length, events: poolEvents } : null,
  };
  if (text === null) return { ...base, text: nativeText, action: "fallback-native" };
  // The output always ends at the newest live segment any playlist has, so with
  // a backup in hand nothing live is missing even when it supplied no segments.
  let action = "renumber";
  if (stats.fromBackup > 0) action = "splice";
  else if (analysis.adKind === "stitched") action = fetched.length ? "drop-ad" : "strip-ad";
  return { ...base, text, action };
}

"use strict";
// Stage 1 blocking. Rewrites the page's media playlists in flight: stitched ads
// are replaced with the same live segments from a logged-in backup session (see
// BACKUP_PLAYER_TYPES) of the same rendition, and client ad markers are removed. The player is never
// paused, reloaded or resumed, so hidden tabs behave exactly like visible ones.

// Player types asked for the backup, best first. Twitch decides per player type
// and account whether a session gets ads, and that changes: "embed" was ad-free in
// every ad captured until it wasn't. So when the backup carries ads too, the
// others are tried and the one that works is remembered for the channel.
// picture-by-picture only offers low renditions, so it only helps there.
const BACKUP_PLAYER_TYPES = ["embed", "popout", "site", "autoplay", "picture-by-picture"];
const BACKUP_MASTER_TTL_MS = 5 * 60_000;
const BACKUP_FETCH_TIMEOUT_MS = 3_000;
// With every backup carrying ads, searching again on each poll would hit Twitch
// five times every 2s for nothing.
const BACKUP_SEARCH_INTERVAL_MS = 10_000;

// `${channel}:${playerType}` -> { fetchedAt, promise } for that backup session's master playlist.
const backupMasters = new Map();
// channel -> the player type whose backup was last ad-free.
const preferredBackupTypes = new Map();
// channel -> when the other player types were last tried and none was clean.
const failedBackupSearches = new Map();
// Media playlist URL -> splice memory.
const splicedStreams = new Map();
// Playback sessions (one per master playlist) that have had a stitched ad. From
// then on every rendition of the session is numbered by live sequence, so a
// quality switch after a blocked ad lands on consistent numbers.
const splicedSessions = new Map();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getBackupMaster(channel, playerType, usherParams, refresh) {
  const key = `${channel}:${playerType}`;
  const cached = backupMasters.get(key);
  if (!refresh && cached && Date.now() - cached.fetchedAt < BACKUP_MASTER_TTL_MS) return cached.promise;
  const promise = (async () => {
    const oauth = await getTwitchOAuth();
    const token = await fetchAccessToken(channel, playerType, oauth);
    const master = parseMaster(await fetchText(buildUsherUrl(channel, token, usherParams)));
    return { master, auth: oauth ? "user" : "anon", token: summarizeToken(JSON.parse(token.value)) };
  })();
  backupMasters.set(key, { fetchedAt: Date.now(), promise });
  promise.catch(() => {
    if (backupMasters.get(key)?.promise === promise) backupMasters.delete(key);
  });
  return promise;
}

async function fetchBackupPlaylist(variant, usherParams, playerType) {
  // A cached backup session can expire; retry once with a fresh one.
  for (const refresh of [false, true]) {
    const { master, auth } = await getBackupMaster(variant.channel, playerType, usherParams, refresh);
    const backupVariant = pickVariant(master.variants, variant);
    if (!backupVariant) throw new Error(`${playerType} backup has no ${variant.name} (${variant.codecs})`);
    try {
      return { text: await fetchText(backupVariant.url), url: backupVariant.url, variant: backupVariant.name, auth, playerType };
    } catch (err) {
      if (refresh) throw err;
    }
  }
}

function backupHasAds(backup) {
  return parseMediaPlaylist(backup.text).segments.some((s) => !s.isLive);
}

// The first player type (the channel's last good one first) whose backup carries
// no ads. If none is clean, the one with the fewest ad segments, so the splice
// still gets what live segments it can; throws only if nothing could be fetched.
async function fetchBackup(variant, usherParams) {
  const channel = variant.channel;
  const preferred = preferredBackupTypes.get(channel);
  const order = preferred ? [preferred, ...BACKUP_PLAYER_TYPES.filter((t) => t !== preferred)] : BACKUP_PLAYER_TYPES;
  const attempt = (playerType) =>
    withTimeout(fetchBackupPlaylist(variant, usherParams, playerType), BACKUP_FETCH_TIMEOUT_MS, `${playerType} backup`).catch((error) => ({ error }));
  const results = [await attempt(order[0])];
  if (!results[0].text || backupHasAds(results[0])) {
    const searchedAt = failedBackupSearches.get(channel) ?? 0;
    if (Date.now() - searchedAt >= BACKUP_SEARCH_INTERVAL_MS) results.push(...(await Promise.all(order.slice(1).map(attempt))));
  }
  const usable = results.filter((r) => r.text);
  const clean = usable.find((r) => !backupHasAds(r));
  if (clean) {
    failedBackupSearches.delete(channel);
    remember(preferredBackupTypes, channel, clean.playerType);
    return clean;
  }
  if (results.length > 1) remember(failedBackupSearches, channel, Date.now());
  if (usable.length === 0) throw results[0].error;
  return usable.reduce((best, r) => (backupAdCount(r) < backupAdCount(best) ? r : best));
}

function backupAdCount(backup) {
  return parseMediaPlaylist(backup.text).segments.filter((s) => !s.isLive).length;
}

// Returns { text, action, ... }. Actions:
//   pass            untouched
//   strip-markers   client ad markers removed, nothing else changed
//   splice          ad segments replaced with backup live segments
//   drop-ad         ad dropped and the backup had nothing to add: at a break's edges
//                   the ad is only past the live edge, or already over
//   renumber        no ad right now; renumbered to stay continuous after an earlier splice
//   strip-ad        ad dropped but no backup available; the player waits at the live edge
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
  if (!memory) {
    memory = newSpliceMemory();
    remember(splicedStreams, url, memory);
  }
  if (variant) remember(splicedSessions, variant.session, true);

  let backup = null;
  let error = null;
  if (analysis.adKind === "stitched") {
    try {
      if (!variant) throw new Error("rendition unknown (its master playlist was not seen)");
      backup = await withTimeout(fetchBackup(variant, usherParams), 2 * BACKUP_FETCH_TIMEOUT_MS, "backup");
    } catch (err) {
      error = String(err?.message || err);
    }
  }

  const { text, stats } = spliceMediaPlaylist(nativeText, backup?.text ?? null, memory);
  const base = {
    analysis,
    stats,
    error,
    backupVariant: backup?.variant ?? null,
    backupAuth: backup?.auth ?? null,
    backupPlayerType: backup?.playerType ?? null,
    backupUrl: backup?.url ?? null,
    backupText: backup?.text ?? null,
  };
  if (text === null) return { ...base, text: nativeText, action: "fallback-native" };
  if (stats.backupAdSegments > 0) base.error ??= `backup also had ${stats.backupAdSegments} ad segments`;
  // The output always ends at the newest live segment either playlist has, so with
  // a backup in hand nothing live is missing even when it supplied no segments.
  let action = "renumber";
  if (stats.fromBackup > 0) action = "splice";
  else if (analysis.adKind === "stitched") action = backup ? "drop-ad" : "strip-ad";
  return { ...base, text, action };
}

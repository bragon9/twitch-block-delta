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
// channel -> the player type whose lower rendition was last ad-free.
const loweredBackupTypes = new Map();
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

// `lowered`: take the best lower rendition of the same codec family instead of
// the page's own, for when no session has an ad-free copy of that.
async function fetchBackupPlaylist(variant, usherParams, playerType, lowered = false) {
  // A cached backup session can expire; retry once with a fresh one.
  for (const refresh of [false, true]) {
    const { master, auth } = await getBackupMaster(variant.channel, playerType, usherParams, refresh);
    const backupVariant = lowered ? pickLowerVariant(master.variants, variant) : pickVariant(master.variants, variant);
    if (!backupVariant) throw new Error(`${playerType} backup has no ${lowered ? `rendition below ${variant.name}` : variant.name} (${variant.codecs})`);
    try {
      return { text: await fetchText(backupVariant.url), url: backupVariant.url, variant: backupVariant.name, auth, playerType, lowered };
    } catch (err) {
      if (refresh) throw err;
    }
  }
}

function backupHasAds(backup) {
  return parseMediaPlaylist(backup.text).segments.some((s) => !s.isLive);
}

// The backup to splice from, best first:
//   1. an ad-free copy of the page's rendition (the channel's last good player type
//      first, the others only if it is not clean)
//   2. an ad-free lower rendition, which plays at lower quality for the break
//   3. the page-rendition backup with the fewest ad segments, for what live
//      segments it has
// Throws only if nothing could be fetched.
async function fetchBackup(variant, usherParams) {
  const channel = variant.channel;
  const preferred = preferredBackupTypes.get(channel);
  const order = preferred ? [preferred, ...BACKUP_PLAYER_TYPES.filter((t) => t !== preferred)] : BACKUP_PLAYER_TYPES;
  const attempt = (playerType, lowered = false) =>
    withTimeout(fetchBackupPlaylist(variant, usherParams, playerType, lowered), BACKUP_FETCH_TIMEOUT_MS, `${playerType} backup`).catch((error) => ({ error }));
  const isClean = (r) => Boolean(r.text) && !backupHasAds(r);

  const results = [await attempt(order[0])];
  if (isClean(results[0])) return results[0];
  const searching = Date.now() - (failedBackupSearches.get(channel) ?? 0) >= BACKUP_SEARCH_INTERVAL_MS;
  if (searching) results.push(...(await Promise.all(order.slice(1).map((t) => attempt(t)))));
  const clean = results.find(isClean);
  if (clean) {
    failedBackupSearches.delete(channel);
    remember(preferredBackupTypes, channel, clean.playerType);
    return clean;
  }

  // Between searches only the lower-rendition type that worked last time is asked.
  const lowTypes = searching ? order : loweredBackupTypes.has(channel) ? [loweredBackupTypes.get(channel)] : [];
  const lowResults = await Promise.all(lowTypes.map((t) => attempt(t, true)));
  const lowClean = lowResults.find(isClean);
  if (searching) remember(failedBackupSearches, channel, Date.now());
  if (lowClean) {
    remember(loweredBackupTypes, channel, lowClean.playerType);
    return lowClean;
  }

  const usable = results.filter((r) => r.text);
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
//   hold            nothing new live to serve mid-break; the previous playlist again,
//                   so the player waits at the live edge instead of seeing the ad
//   fallback-native nothing live to serve and nothing to hold (e.g. pre-roll with no
//                   backup); the ad plays
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
      backup = await withTimeout(fetchBackup(variant, usherParams), 3 * BACKUP_FETCH_TIMEOUT_MS, "backup");
    } catch (err) {
      error = String(err?.message || err);
    }
  }

  const { text, stats } = spliceMediaPlaylist(nativeText, backup?.text ?? null, memory, { backupLowered: Boolean(backup?.lowered) });
  const base = {
    analysis,
    stats,
    error,
    backupVariant: backup?.variant ?? null,
    backupAuth: backup?.auth ?? null,
    backupPlayerType: backup?.playerType ?? null,
    backupLowered: Boolean(backup?.lowered),
    backupUrl: backup?.url ?? null,
    backupText: backup?.text ?? null,
  };
  if (text === null) {
    if (memory.lastOutput && analysis.adKind === "stitched") return { ...base, text: memory.lastOutput, action: "hold" };
    return { ...base, text: nativeText, action: "fallback-native" };
  }
  memory.lastOutput = text;
  if (stats.backupAdSegments > 0) base.error ??= `backup also had ${stats.backupAdSegments} ad segments`;
  // The output always ends at the newest live segment either playlist has, so with
  // a backup in hand nothing live is missing even when it supplied no segments.
  let action = "renumber";
  if (stats.fromBackup > 0) action = "splice";
  else if (analysis.adKind === "stitched") action = backup ? "drop-ad" : "strip-ad";
  return { ...base, text, action };
}

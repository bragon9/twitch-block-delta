"use strict";
// Stage 1 blocking. Rewrites the page's media playlists in flight: stitched ads
// are replaced with the same live segments from a logged-in "embed" session of
// the same rendition, and client ad markers are removed. The player is never
// paused, reloaded or resumed, so hidden tabs behave exactly like visible ones.

const BACKUP_PLAYER_TYPE = "embed";
const BACKUP_MASTER_TTL_MS = 5 * 60_000;
const BACKUP_FETCH_TIMEOUT_MS = 3_000;

// channel -> { fetchedAt, promise } for the backup session's master playlist.
const backupMasters = new Map();
// Media playlist URL -> splice memory. Once a stream has had a stitched ad, every
// later playlist for it is rewritten so its numbering stays continuous.
const splicedStreams = new Map();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getBackupMaster(channel, usherParams, refresh) {
  const cached = backupMasters.get(channel);
  if (!refresh && cached && Date.now() - cached.fetchedAt < BACKUP_MASTER_TTL_MS) return cached.promise;
  const promise = (async () => {
    const oauth = await getTwitchOAuth();
    const token = await fetchAccessToken(channel, BACKUP_PLAYER_TYPE, oauth);
    const master = parseMaster(await fetchText(buildUsherUrl(channel, token, usherParams)));
    return { master, auth: oauth ? "user" : "anon", token: summarizeToken(JSON.parse(token.value)) };
  })();
  backupMasters.set(channel, { fetchedAt: Date.now(), promise });
  promise.catch(() => {
    if (backupMasters.get(channel)?.promise === promise) backupMasters.delete(channel);
  });
  return promise;
}

async function fetchBackupPlaylist(variant, usherParams) {
  // A cached backup session can expire; retry once with a fresh one.
  for (const refresh of [false, true]) {
    const { master, auth } = await getBackupMaster(variant.channel, usherParams, refresh);
    const backupVariant = pickVariant(master.variants, variant);
    if (!backupVariant) throw new Error(`backup has no ${variant.name} (${variant.codecs})`);
    try {
      return { text: await fetchText(backupVariant.url), variant: backupVariant.name, auth };
    } catch (err) {
      if (refresh) throw err;
    }
  }
}

// Returns { text, action, ... }. Actions:
//   pass            untouched
//   strip-markers   client ad markers removed, nothing else changed
//   splice          ad segments replaced with backup live segments
//   renumber        no ad right now; renumbered to stay continuous after an earlier splice
//   strip-ad        ad dropped but no backup available; the player waits at the live edge
//   fallback-native nothing live to serve (e.g. pre-roll with no backup); the ad plays
async function rewriteMediaPlaylist(url, nativeText, variant, usherParams) {
  const analysis = analyzeMedia(nativeText);
  let memory = splicedStreams.get(url);
  if (!memory && analysis.adKind !== "stitched") {
    if (analysis.adKind === "client") return { text: stripAdMarkers(nativeText).text, action: "strip-markers", analysis };
    return { text: nativeText, action: "pass", analysis };
  }
  if (!memory) {
    memory = newSpliceMemory();
    remember(splicedStreams, url, memory);
  }

  let backup = null;
  let error = null;
  if (analysis.adKind === "stitched") {
    try {
      if (!variant) throw new Error("rendition unknown (its master playlist was not seen)");
      backup = await withTimeout(fetchBackupPlaylist(variant, usherParams), BACKUP_FETCH_TIMEOUT_MS, "backup");
    } catch (err) {
      error = String(err?.message || err);
    }
  }

  const { text, stats } = spliceMediaPlaylist(nativeText, backup?.text ?? null, memory);
  const base = { analysis, stats, error, backupVariant: backup?.variant ?? null, backupAuth: backup?.auth ?? null };
  if (text === null) return { ...base, text: nativeText, action: "fallback-native" };
  if (stats.backupAdSegments > 0) base.error ??= `backup also had ${stats.backupAdSegments} ad segments`;
  const action = stats.fromBackup > 0 ? "splice" : analysis.adKind === "stitched" ? "strip-ad" : "renumber";
  return { ...base, text, action };
}

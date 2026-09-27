"use strict";
// Intercepts Twitch's master (usher) and media playlist responses with
// filterResponseData. In "block" mode media playlists are rewritten by blocker.js;
// in "observe" mode every byte passes through unchanged and ad breaks are probed.
// What gets recorded depends on the log mode below.

// "off" (default): record nothing. "problems": keep the last couple of minutes in
// memory and write a file only when something goes wrong. "always": persist every
// capture to storage.
const LOG_MODES = ["off", "problems", "always"];
let logMode = "off";
const log = (...args) => logMode !== "off" && console.log("[delta]", ...args);

const USHER_URLS = ["*://usher.ttvnw.net/api/*"];
const MEDIA_URLS = [
  "*://*.playlist.ttvnw.net/v1/playlist/*",
  "*://*.playlist.live-video.net/v1/playlist/*",
  "*://*.hls.ttvnw.net/v1/playlist/*",
];
const MAX_TRACKED_URLS = 500;
const REQUEST_LOG_LIMIT = 20_000;
const SECOND_PROBE_DELAY_MS = 15_000;
const MIN_PROBE_INTERVAL_MS = 10_000;
// Players Twitch opens alongside the main one: the small live window it shows
// beside an ad, and hover/front-page previews. They never own the tab's ad state.
const SECONDARY_PLAYER_TYPES = new Set(["picture-by-picture", "autoplay", "frontpage", "thumbnail"]);

// Media playlist URL -> the variant the master playlist described.
const variants = new Map();
// Media playlist URL -> { signature, isAd, text } of its previous response.
const streams = new Map();
// tabId -> observation state shown in the popup.
const tabs = new Map();
let mode = "block";
// Timing of every media playlist request, kept in memory and added to exports.
// Shows whether a stall came from Twitch, an aborted request, or our rewriting.
const requestLog = [];
const pendingRequests = new Map();

function finishRequest(requestId, fields) {
  const record = pendingRequests.get(requestId);
  if (!record) return;
  Object.assign(record, fields(record));
  pendingRequests.delete(requestId);
  if (logMode === "off") return;
  requestLog.push(record);
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.splice(0, requestLog.length - REQUEST_LOG_LIMIT);
}

function sinceStart(record) {
  return record ? Date.now() - record.at : null;
}
// Each master playlist response starts a playback session; its renditions share it.
let nextSessionId = 1;

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_URLS) map.delete(map.keys().next().value);
}

function getTab(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      tabId,
      channel: null,
      playerType: null,
      quality: null,
      topVariant: null,
      masters: 0,
      mediaResponses: 0,
      lastMasterAt: null,
      lastMediaAt: null,
      requestTypes: [],
      adActive: false,
      adKind: null,
      adStartedAt: null,
      adBreaks: 0,
      lastAdReasons: [],
      lastProbe: null,
      lastAction: null,
      lastBlock: null,
      actionCounts: {},
      usherParams: null,
    });
  }
  return tabs.get(tabId);
}

const POST_PROBLEM_MS = 15_000;
const DUMP_COOLDOWN_MS = 60_000;
const MAX_DUMPS_PER_RUN = 25;
const SLOW_REWRITE_MS = 2_000;
// { reasons, timer } while a dump is waiting for the seconds after a problem.
let pendingDump = null;
let lastDumpAt = 0;
let dumpCount = 0;
let lastDump = null;

async function record(entry) {
  if (logMode === "always") return Capture.add(entry);
  if (logMode === "problems") Ring.add(entry);
}

// Something went wrong. Note it, then write the ring to a file once the seconds
// after the problem are in it too. Rate-limited so a broken stream can't flood
// the Downloads folder.
function anomaly(reason, detail = {}) {
  if (logMode === "off") return;
  log(`problem: ${reason}`, detail.error ?? "");
  record({ kind: "anomaly", reason, ...detail }).catch((err) => console.error("[delta]", err));
  if (logMode !== "problems") return;
  if (pendingDump) {
    if (!pendingDump.reasons.includes(reason)) pendingDump.reasons.push(reason);
    return;
  }
  if (Date.now() - lastDumpAt < DUMP_COOLDOWN_MS || dumpCount >= MAX_DUMPS_PER_RUN) return;
  pendingDump = { reasons: [reason], timer: setTimeout(flushDump, POST_PROBLEM_MS) };
}

async function flushDump() {
  const { reasons } = pendingDump;
  pendingDump = null;
  lastDumpAt = Date.now();
  dumpCount++;
  try {
    lastDump = { at: Date.now(), reasons, entries: await writeDump(reasons) };
  } catch (err) {
    lastDump = { at: Date.now(), reasons, error: String(err?.message || err) };
    console.error("[delta] problem dump failed", err);
  }
}

async function writeDump(reasons) {
  const entries = Ring.snapshot();
  const since = entries.length > 0 ? Date.parse(entries[0].at) : Date.now();
  const requests = [...requestLog, ...pendingRequests.values()].filter((r) => r.at >= since);
  await saveJson(
    { exportedAt: new Date().toISOString(), version: browser.runtime.getManifest().version, encoding: EXPORT_ENCODING, reasons, requests, entries },
    `twitch-block-delta/problem-${fileStamp()}.json`,
    false,
  );
  return entries.length;
}

function setLogMode(next) {
  if (!LOG_MODES.includes(next)) return;
  logMode = next;
  if (logMode === "off") requestLog.length = 0;
  if (logMode !== "problems") {
    clearTimeout(pendingDump?.timer);
    pendingDump = null;
    Ring.clear();
  }
}

function isOwnRequest(details) {
  return (details.originUrl || "").startsWith("moz-extension:");
}

function teeBody(requestId, onText) {
  const filter = browser.webRequest.filterResponseData(requestId);
  const decoder = new TextDecoder();
  let text = "";
  filter.ondata = (event) => {
    filter.write(event.data);
    text += decoder.decode(event.data, { stream: true });
  };
  filter.onstop = () => {
    filter.close();
    text += decoder.decode();
    Promise.resolve()
      .then(() => onText(text))
      .catch((err) => console.error("[delta]", err));
  };
  filter.onerror = () => log("filter error:", filter.error);
}

// Buffers the whole response so it can be replaced. Any failure sends the
// original bytes, so a bug here can never break playback outright.
// `record` is this request's timing entry; the object stays valid even after
// onCompleted has moved it from pendingRequests to requestLog.
function rewriteBody(requestId, record, transform) {
  const filter = browser.webRequest.filterResponseData(requestId);
  const chunks = [];
  filter.ondata = (event) => {
    if (record && record.firstByteMs === undefined) record.firstByteMs = sinceStart(record);
    chunks.push(event.data);
  };
  filter.onstop = async () => {
    if (record) record.bodyDoneMs = sinceStart(record);
    const original = new Uint8Array(await new Blob(chunks).arrayBuffer());
    if (record) record.bytesIn = original.length;
    let output = original;
    try {
      const text = new TextDecoder().decode(original);
      const rewritten = await transform(text);
      if (typeof rewritten === "string" && rewritten !== text) output = new TextEncoder().encode(rewritten);
    } catch (err) {
      console.error("[delta] rewrite failed; sending original", err);
      anomaly("rewrite-exception", { error: String(err?.message || err) });
    }
    filter.write(output);
    filter.close();
    if (record) {
      record.forwardedMs = sinceStart(record);
      record.bytesOut = output.length;
    }
  };
  filter.onerror = () => {
    if (record) record.filterError = filter.error;
    log("filter error:", filter.error);
  };
}

function parseUsherUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/\/channel\/hls\/([^/]+)\.m3u8$/i);
  let token = null;
  try {
    token = JSON.parse(url.searchParams.get("token"));
  } catch {}
  return {
    channel: match ? decodeURIComponent(match[1]).toLowerCase() : null,
    token,
    params: Object.fromEntries(url.searchParams),
  };
}

async function describeTab(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);
    return { active: tab.active, windowFocused: win.focused, hidden: tab.hidden, discarded: tab.discarded };
  } catch {
    return null;
  }
}

const BADGE_RED = "#c0392b";
const BADGE_GREEN = "#1e8449";

function setBadge(tabId, text, color = BADGE_RED) {
  if (tabId < 0) return;
  browser.browserAction.setBadgeText({ tabId, text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function onMaster(details, text) {
  const { channel, token, params } = parseUsherUrl(details.url);
  const master = parseMaster(text);
  const playerType = token?.player_type ?? null;
  const isSecondary = SECONDARY_PLAYER_TYPES.has(playerType);
  const tab = getTab(details.tabId);
  if (!isSecondary) {
    tab.channel = channel;
    tab.playerType = playerType;
    tab.usherParams = params;
    const top = master.variants.filter((v) => v.resolution).sort((a, c) => (c.bandwidth || 0) - (a.bandwidth || 0))[0];
    tab.topVariant = top ? { name: top.name, stableId: top.stableId, codecs: top.codecs } : null;
  }
  tab.masters++;
  tab.lastMasterAt = Date.now();

  const session = nextSessionId++;
  for (const v of master.variants) {
    remember(variants, v.url, {
      session,
      channel,
      playerType,
      name: v.name,
      stableId: v.stableId,
      resolution: v.resolution,
      codecs: v.codecs,
    });
  }

  log(`master ${channel} (${playerType}${isSecondary ? ", secondary" : ""}) tab=${details.tabId}:`, master.variants.map((v) => v.name).join(", "));
  await record({
    kind: "master",
    tabId: details.tabId,
    channel,
    secondary: isSecondary,
    requestType: details.type,
    token: summarizeToken(token),
    sessionData: { ...master.sessionData, "USER-IP": undefined },
    variants: master.variants.map(({ url, attrs, ...rest }) => rest),
    media: master.media,
    text: redactMaster(text),
  });
}

// Returns the text to send to the player. Recording happens afterwards so
// storage writes never delay playback.
async function onMedia(details, text, record) {
  const variant = variants.get(details.url) ?? null;
  let outcome = null;
  if (mode === "block") {
    const started = performance.now();
    outcome = await rewriteMediaPlaylist(details.url, text, variant, getTab(details.tabId).usherParams);
    outcome.rewriteMs = Math.round(performance.now() - started);
  }
  if (record) {
    Object.assign(record, {
      channel: variant?.channel ?? null,
      variant: variant?.name ?? null,
      action: outcome?.action ?? "observe",
      rewriteMs: outcome?.rewriteMs ?? null,
      window: outcome?.stats?.window ?? null,
      mediaSequenceIn: Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? NaN) || null,
      adKind: outcome?.analysis?.adKind ?? null,
    });
  }
  observeMedia(details, text, variant, outcome).catch((err) => console.error("[delta]", err));
  return outcome?.text ?? text;
}

async function observeMedia(details, text, variant, outcome) {
  const tab = getTab(details.tabId);
  if (!text.startsWith("#EXTM3U")) {
    await record({ kind: "invalid-response", tabId: details.tabId, channel: variant?.channel ?? null, variant: variant?.name ?? null, bytes: text.length, head: text.slice(0, 200) });
    // Empty bodies are aborted requests, and a stream that sent #EXT-X-ENDLIST
    // 404s once it's gone. Neither is a problem.
    if (text.length > 0 && !streams.get(details.url)?.ended) anomaly("invalid-response", { channel: variant?.channel ?? null, variant: variant?.name ?? null, bytes: text.length });
    return;
  }
  // Secondary players and previews share the tab. Only playlists from the main
  // player's master drive the tab's ad state; unknown URLs are recorded only.
  const isPageStream = Boolean(variant && variant.channel === tab.channel && variant.playerType === tab.playerType);
  if (variant && isPageStream) tab.quality = { name: variant.name, stableId: variant.stableId, codecs: variant.codecs };
  tab.mediaResponses++;
  tab.lastMediaAt = Date.now();
  if (!tab.requestTypes.includes(details.type)) tab.requestTypes.push(details.type);

  const analysis = analyzeMedia(text);
  const signature = playlistSignature(analysis);
  const previous = streams.get(details.url);
  remember(streams, details.url, { signature, isAd: analysis.isAd, ended: analysis.ended, text });

  const base = {
    tabId: details.tabId,
    channel: variant?.channel ?? tab.channel,
    variant: variant?.name ?? null,
    playerType: variant?.playerType ?? null,
    knownVariant: Boolean(variant),
    pageStream: isPageStream,
  };
  if (analysis.isAd && previous && !previous.isAd) {
    await record({ kind: "media", reason: "pre-ad", ...base, analysis: analyzeMedia(previous.text), chain: `native:${details.url}`, text: previous.text });
  }
  const reason = !previous ? "first" : previous.signature !== signature ? "markup-changed" : analysis.isAd ? "ad" : null;
  if (reason) await record({ kind: "media", reason, ...base, analysis, chain: `native:${details.url}`, text });

  if (outcome && outcome.action !== "pass") {
    if (isPageStream) {
      tab.lastAction = outcome.action;
      tab.actionCounts[outcome.action] = (tab.actionCounts[outcome.action] || 0) + 1;
      tab.lastBlock = { at: Date.now(), action: outcome.action, stats: outcome.stats ?? null, error: outcome.error ?? null, backupVariant: outcome.backupVariant ?? null, rewriteMs: outcome.rewriteMs };
      tab.maxRewriteMs = Math.max(tab.maxRewriteMs || 0, outcome.rewriteMs);
    }
    // Keep every rewrite made during an ad, plus the first of each other kind per stream.
    const previousAction = previous?.action ?? null;
    if (analysis.isAd || outcome.action !== previousAction) {
      await record({
        kind: "rewrite",
        ...base,
        action: outcome.action,
        stats: outcome.stats ?? null,
        error: outcome.error ?? null,
        backupVariant: outcome.backupVariant ?? null,
        backupAuth: outcome.backupAuth ?? null,
        rewriteMs: outcome.rewriteMs,
        chain: `output:${details.url}`,
        text: outcome.text,
      });
      // The backup playlist this rewrite used, so any splice can be replayed exactly.
      if (outcome.backupText) {
        await record({
          kind: "backup",
          ...base,
          backupVariant: outcome.backupVariant,
          backupAuth: outcome.backupAuth,
          chain: `backup:${outcome.backupUrl}`,
          text: outcome.backupText,
        });
      }
    }
    if (outcome.error) log(`${outcome.action} ${base.channel} ${base.variant}: ${outcome.error}`);
    if (isPageStream) {
      const detail = { channel: base.channel, variant: base.variant, action: outcome.action, error: outcome.error ?? null, rewriteMs: outcome.rewriteMs };
      if (outcome.error) anomaly("rewrite-error", detail);
      // The player got the ad, or nothing live to play.
      if (outcome.action === "fallback-native") anomaly("ad-not-blocked", detail);
      if (outcome.action === "strip-ad") anomaly("no-live-segments", detail);
      if (outcome.rewriteMs > SLOW_REWRITE_MS) anomaly("slow-rewrite", detail);
    }
  }
  streams.get(details.url).action = outcome?.action ?? null;

  if (isPageStream) await updateAdState(tab, analysis, outcome);
}

// Green while an ad is being replaced cleanly, red when the player can see it or
// is waiting on it.
function badgeFor(analysis, outcome) {
  if (!outcome) return { text: BADGE_BY_AD_KIND[analysis.adKind], color: BADGE_RED };
  const clean = ["splice", "drop-ad", "strip-markers"].includes(outcome.action);
  return { text: BADGE_BY_AD_KIND[analysis.adKind], color: clean && !outcome.error ? BADGE_GREEN : BADGE_RED };
}

const BADGE_BY_AD_KIND = { stitched: "AD", client: "MAF" };

async function updateAdState(tab, analysis, outcome) {
  if (analysis.isAd) {
    const badge = badgeFor(analysis, outcome);
    setBadge(tab.tabId, badge.text, badge.color);
  }
  if (analysis.adKind === tab.adKind) return;
  const now = Date.now();
  const tabInfo = await describeTab(tab.tabId);
  if (analysis.isAd) {
    // A client-marker break can turn into a stitched one; record that as its own start.
    const escalated = tab.adActive;
    tab.adActive = true;
    tab.adKind = analysis.adKind;
    tab.adStartedAt = now;
    if (!escalated) tab.adBreaks++;
    tab.lastAdReasons = analysis.adReasons;
    log(`ad start (${analysis.adKind}) ${tab.channel} tab=${tab.tabId}:`, analysis.adReasons.join("; "));
    await record({
      kind: "event",
      event: "ad-start",
      adKind: analysis.adKind,
      escalated,
      tabId: tab.tabId,
      channel: tab.channel,
      quality: tab.quality,
      reasons: analysis.adReasons,
      adDateRanges: analysis.adDateRanges,
      mode,
      action: outcome?.action ?? null,
      tabInfo,
    });
    // Probes open extra sessions; they're for learning, not needed while blocking.
    if (mode === "observe") runProbes(tab, tab.adStartedAt);
  } else {
    const durationMs = now - tab.adStartedAt;
    const endedKind = tab.adKind;
    tab.adActive = false;
    tab.adKind = null;
    setBadge(tab.tabId, "");
    log(`ad end ${tab.channel} tab=${tab.tabId} after ${Math.round(durationMs / 1000)}s`);
    await record({ kind: "event", event: "ad-end", adKind: endedKind, tabId: tab.tabId, channel: tab.channel, durationMs, tabInfo });
  }
}

// One probe as the break starts and one mid-break, since an alternate player
// type may pick up the ad a few seconds later than the page's player did.
async function runProbes(tab, breakStartedAt) {
  if (Date.now() - (tab.lastProbeStartedAt || 0) < MIN_PROBE_INTERVAL_MS) return;
  tab.lastProbeStartedAt = Date.now();
  const target = () => ({ tabId: tab.tabId, channel: tab.channel, quality: tab.quality, topVariant: tab.topVariant, usherParams: tab.usherParams });
  try {
    tab.lastProbe = { at: Date.now(), round: 1, results: await probeAdBreak({ ...target(), round: 1 }) };
    await new Promise((resolve) => setTimeout(resolve, SECOND_PROBE_DELAY_MS));
    if (!tab.adActive || tab.adStartedAt !== breakStartedAt) return;
    tab.lastProbe = { at: Date.now(), round: 2, results: await probeAdBreak({ ...target(), round: 2 }) };
  } catch (err) {
    console.error("[delta] probe failed", err);
  }
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (isOwnRequest(details) || !/\/channel\/hls\/[^/]+\.m3u8/i.test(details.url)) return {};
    teeBody(details.requestId, (text) => onMaster(details, text));
    return {};
  },
  { urls: USHER_URLS },
  ["blocking"],
);

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (isOwnRequest(details) || !/\.m3u8(?:$|\?)/i.test(details.url)) return {};
    const record = { at: Date.now(), tabId: details.tabId, url: details.url.slice(-24) };
    pendingRequests.set(details.requestId, record);
    rewriteBody(details.requestId, record, (text) => onMedia(details, text, record));
    return {};
  },
  { urls: MEDIA_URLS },
  ["blocking"],
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const record = pendingRequests.get(details.requestId);
    if (record) Object.assign(record, { status: details.statusCode, headersMs: sinceStart(record) });
  },
  { urls: MEDIA_URLS },
);
browser.webRequest.onCompleted.addListener(
  (details) => finishRequest(details.requestId, (record) => ({ completedMs: sinceStart(record), fromCache: details.fromCache })),
  { urls: MEDIA_URLS },
);
browser.webRequest.onErrorOccurred.addListener(
  (details) => finishRequest(details.requestId, (record) => ({ error: details.error, errorMs: sinceStart(record) })),
  { urls: MEDIA_URLS },
);

browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function saveJson(payload, filename, saveAs) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  try {
    await browser.downloads.download({ url, filename, saveAs, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function exportCaptures() {
  const entries = await Capture.all();
  const requests = [...requestLog, ...pendingRequests.values()];
  // Entries are exported in stored form; tools/expand_export.py restores texts.
  const payload = {
    exportedAt: new Date().toISOString(),
    version: browser.runtime.getManifest().version,
    encoding: EXPORT_ENCODING,
    requests,
    entries,
  };
  await saveJson(payload, `twitch-block-delta-${fileStamp()}.json`, true);
  return entries.length;
}

browser.runtime.onMessage.addListener(async (message) => {
  switch (message?.type) {
    case "state":
      return {
        mode,
        logMode,
        ring: { count: Ring.items.length, bytes: Ring.bytes },
        lastDump,
        captures: await Capture.count(),
        storage: await Capture.stats(),
        tabs: [...tabs.values()].map(({ usherParams, ...rest }) => rest),
      };
    case "export":
      return { exported: await exportCaptures() };
    case "clear":
      await Capture.clear();
      return { cleared: true };
    case "setMode":
      if (message.mode !== "block" && message.mode !== "observe") return { mode };
      mode = message.mode;
      await browser.storage.local.set({ mode });
      log(`mode: ${mode}`);
      return { mode };
    case "setLogMode":
      setLogMode(message.logMode);
      await browser.storage.local.set({ logMode });
      log(`log mode: ${logMode}`);
      return { logMode };
    case "dumpNow":
      if (logMode !== "problems") return { entries: 0 };
      return { entries: await writeDump(["manual"]) };
  }
});

Promise.all([Capture.load(), browser.storage.local.get(["mode", "logMode"])]).then(([, stored]) => {
  setLogMode(stored.logMode);
  if (stored.mode === "observe" || stored.mode === "block") mode = stored.mode;
  log(`ready (${mode} mode)`);
});

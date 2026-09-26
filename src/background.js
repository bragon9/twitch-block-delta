"use strict";
// Intercepts Twitch's master (usher) and media playlist responses with
// filterResponseData. In "block" mode media playlists are rewritten by blocker.js;
// in "observe" mode every byte passes through unchanged and ad breaks are probed.
// Both modes record the playlists Twitch actually sent.

const log = (...args) => console.log("[delta]", ...args);

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
  await Capture.add({
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
    await Capture.add({ kind: "invalid-response", tabId: details.tabId, channel: variant?.channel ?? null, variant: variant?.name ?? null, bytes: text.length, head: text.slice(0, 200) });
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
  remember(streams, details.url, { signature, isAd: analysis.isAd, text });

  const base = {
    tabId: details.tabId,
    channel: variant?.channel ?? tab.channel,
    variant: variant?.name ?? null,
    playerType: variant?.playerType ?? null,
    knownVariant: Boolean(variant),
    pageStream: isPageStream,
  };
  if (analysis.isAd && previous && !previous.isAd) {
    await Capture.add({ kind: "media", reason: "pre-ad", ...base, analysis: analyzeMedia(previous.text), chain: `native:${details.url}`, text: previous.text });
  }
  const reason = !previous ? "first" : previous.signature !== signature ? "markup-changed" : analysis.isAd ? "ad" : null;
  if (reason) await Capture.add({ kind: "media", reason, ...base, analysis, chain: `native:${details.url}`, text });

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
      await Capture.add({
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
        await Capture.add({
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
  }
  streams.get(details.url).action = outcome?.action ?? null;

  if (isPageStream) await updateAdState(tab, analysis, outcome);
}

// Green while an ad is being replaced cleanly, red when the player can see it or
// is waiting on it.
function badgeFor(analysis, outcome) {
  if (!outcome) return { text: BADGE_BY_AD_KIND[analysis.adKind], color: BADGE_RED };
  const clean = outcome.action === "splice" || outcome.action === "strip-markers";
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
    await Capture.add({
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
    await Capture.add({ kind: "event", event: "ad-end", adKind: endedKind, tabId: tab.tabId, channel: tab.channel, durationMs, tabInfo });
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
  const blob = new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await browser.downloads.download({ url, filename: `twitch-block-delta-${stamp}.json`, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return entries.length;
}

browser.runtime.onMessage.addListener(async (message) => {
  switch (message?.type) {
    case "state":
      return {
        mode,
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
  }
});

Promise.all([Capture.load(), browser.storage.local.get("mode")]).then(([, stored]) => {
  if (stored.mode === "observe" || stored.mode === "block") mode = stored.mode;
  log(`ready (${mode} mode)`);
});

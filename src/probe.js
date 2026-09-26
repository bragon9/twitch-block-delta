"use strict";
// During an ad break, asks Twitch for the same stream as other player types and
// records whether their media playlists carry ads. That tells us which backup
// source the blocker can splice from. The page's player is never touched.

const GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch's public web client ID
const PROBE_PLAYER_TYPES = ["site", "embed", "popout", "autoplay", "picture-by-picture"];
const TOKEN_QUERY = `query($login: String!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) { value signature }
}`;
// Usher params that identify the page's own playback session; probes must not reuse them.
const PAGE_ONLY_USHER_PARAMS = new Set(["sig", "token", "p", "play_session_id"]);
const DEFAULT_USHER_PARAMS = {
  allow_source: "true",
  allow_audio_only: "true",
  platform: "web",
  player_backend: "mediaplayer",
  supported_codecs: "av1,h265,h264",
  playlist_include_framerate: "true",
};

async function getTwitchOAuth() {
  try {
    const cookie = await browser.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

async function fetchAccessToken(channel, playerType, oauth) {
  const headers = { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" };
  if (oauth) headers.Authorization = `OAuth ${oauth}`;
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers,
    credentials: "omit",
    body: JSON.stringify({ query: TOKEN_QUERY, variables: { login: channel, playerType } }),
  });
  const json = await res.json();
  const token = json?.data?.streamPlaybackAccessToken;
  if (!token) throw new Error(`token: ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
  return token;
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.text();
}

function buildUsherUrl(channel, token, pageParams) {
  const url = new URL(`https://usher.ttvnw.net/api/v2/channel/hls/${channel}.m3u8`);
  const params = pageParams ?? DEFAULT_USHER_PARAMS;
  for (const [key, value] of Object.entries(params)) {
    if (!PAGE_ONLY_USHER_PARAMS.has(key)) url.searchParams.set(key, value);
  }
  url.searchParams.set("sig", token.signature);
  url.searchParams.set("token", token.value);
  url.searchParams.set("p", String(Math.floor(Math.random() * 1e7)));
  return url.href;
}

async function probeRendition(master, wanted, target, playerType, authLabel) {
  const variant = pickVariant(master.variants, wanted);
  if (!variant) return { wanted: wanted?.name ?? null, error: `no rendition matching ${wanted?.name} (${wanted?.codecs})` };
  try {
    const text = await fetchText(variant.url);
    const analysis = analyzeMedia(text);
    const { tabId, channel, round } = target;
    await Capture.add({ kind: "probe", round, tabId, channel, playerType, auth: authLabel, variant: variant.name, codecs: variant.codecs, analysis, text });
    return { wanted: wanted.name, variant: variant.name, codecs: variant.codecs, isAd: analysis.isAd, adKind: analysis.adKind, adReasons: analysis.adReasons };
  } catch (err) {
    return { wanted: wanted.name, variant: variant.name, error: String(err?.message || err) };
  }
}

// Tests both the rendition the page player is currently downloading and the
// stream's top rendition, since the player may drop to another one during ads.
async function probeOne(target, playerType, authLabel, oauth) {
  const result = { playerType, auth: authLabel, renditions: [] };
  try {
    const token = await fetchAccessToken(target.channel, playerType, oauth);
    result.token = summarizeToken(JSON.parse(token.value));
    const master = parseMaster(await fetchText(buildUsherUrl(target.channel, token, target.usherParams)));
    result.variants = master.variants.map((v) => v.name);
    const wanted = [target.quality, target.topVariant].filter(Boolean);
    const unique = wanted.filter((w, i) => wanted.findIndex((o) => o.stableId === w.stableId && o.codecs === w.codecs) === i);
    result.renditions = await Promise.all(unique.map((w) => probeRendition(master, w, target, playerType, authLabel)));
  } catch (err) {
    result.error = String(err?.message || err);
  }
  return result;
}

async function probeAdBreak(target) {
  const oauth = await getTwitchOAuth();
  const auths = oauth ? [["user", oauth], ["anon", null]] : [["anon", null]];
  const jobs = [];
  for (const playerType of PROBE_PLAYER_TYPES) {
    for (const [label, token] of auths) jobs.push(probeOne(target, playerType, label, token));
  }
  const results = await Promise.all(jobs);
  await Capture.add({
    kind: "event",
    event: "probe-summary",
    round: target.round,
    tabId: target.tabId,
    channel: target.channel,
    quality: target.quality,
    topVariant: target.topVariant,
    results,
  });
  return results;
}

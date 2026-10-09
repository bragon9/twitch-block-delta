"use strict";
// Pure helpers for Twitch HLS playlists. No browser APIs (not even URL), so
// test/run.sh can load this file under osascript.

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
const LIVE_SEGMENT_TITLE = "live";

// Tags seen on ordinary live playlists. Anything else is reported in
// `unknownTags` so new markup shows up in captures without code changes.
const KNOWN_MEDIA_TAGS = new Set([
  "#EXTM3U",
  "#EXT-X-VERSION",
  "#EXT-X-TARGETDURATION",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-TWITCH-LIVE-SEQUENCE",
  "#EXT-X-TWITCH-ELAPSED-SECS",
  "#EXT-X-TWITCH-TOTAL-SECS",
  "#EXT-X-DATERANGE",
  "#EXT-X-MAP",
  "#EXT-X-PROGRAM-DATE-TIME",
  "#EXTINF",
  "#EXT-X-TWITCH-PREFETCH",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  // The broadcast is over; the playlist URL 404s shortly after.
  "#EXT-X-ENDLIST",
]);

// Matches "twitch-stitched-ad", "stitched-ad-123", "twitch-maf-ad", but not the
// ordinary "twitch-session" / "twitch-trigger" / "twitch-stream-source".
const AD_NAME_RE = /stitched|(?:^|-)ad(?:-|$)/i;
const AD_ATTRIBUTE_RE = /^X-(?:TV-TWITCH|TTV-MAF)-AD/;

function parseAttributes(text) {
  const attrs = {};
  for (const [, key, raw] of text.matchAll(ATTR_RE)) {
    attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

function splitTag(line) {
  const i = line.indexOf(":");
  return i === -1 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
}

function isAbsoluteUrl(s) {
  return /^https?:\/\//i.test(s);
}

function parseMaster(text) {
  const sessionData = {};
  const media = [];
  const variants = [];
  let pending = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("#")) {
      // Twitch always sends absolute variant URLs; a relative one is worth seeing.
      if (pending) variants.push({ ...pending, url: line, relative: !isAbsoluteUrl(line) });
      pending = null;
      continue;
    }
    const [tag, value] = splitTag(line);
    if (tag === "#EXT-X-SESSION-DATA") {
      const a = parseAttributes(value);
      if (a["DATA-ID"]) sessionData[a["DATA-ID"]] = a.VALUE ?? a.URI ?? "";
    } else if (tag === "#EXT-X-MEDIA") {
      media.push(parseAttributes(value));
    } else if (tag === "#EXT-X-STREAM-INF") {
      const a = parseAttributes(value);
      pending = {
        name: a["IVS-NAME"] || a["STABLE-VARIANT-ID"] || a.VIDEO || a.RESOLUTION || "unknown",
        stableId: a["STABLE-VARIANT-ID"] || null,
        resolution: a.RESOLUTION || null,
        codecs: a.CODECS || null,
        frameRate: a["FRAME-RATE"] ? Number(a["FRAME-RATE"]) : null,
        bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : null,
        attrs: a,
      };
    }
  }
  return { sessionData, media, variants };
}

function analyzeMedia(text) {
  const result = {
    valid: text.startsWith("#EXTM3U"),
    mediaSequence: null,
    targetDuration: null,
    segments: 0,
    prefetch: 0,
    discontinuities: 0,
    mapCount: 0,
    titles: {},
    dateRangeClasses: {},
    streamSources: [],
    adAttributes: [],
    adDateRanges: [],
    unknownTags: [],
    adReasons: [],
    ended: false,
    // "stitched": ad video is in the playlist. "client": only an ad marker; the
    // live segments continue and Twitch's page is expected to render the ad.
    adKind: null,
    isAd: false,
    // Whether the newest segment is in an ad, i.e. Twitch is serving one now.
    // isAd stays true while an ad's markers linger after it, often ~30s.
    adAtLiveEdge: false,
  };
  if (!result.valid) return result;

  const maps = new Set();
  const sources = new Set();
  const adAttributes = new Set();
  const unknownTags = new Set();
  const reasons = new Set();
  const adDateRanges = new Map();
  let stitched = false;
  // A discontinuity after the last segment announces a switch (at an ad break,
  // to the ad) whose segments are only in the prefetch hints so far.
  let discontinuityAfterLastSegment = false;
  let newestTitle = null;
  let newestStart = NaN;
  let nextStart = NaN;
  // Client ad markers as [start ms, end ms]; a marker with no span makes the
  // whole playlist count as an ad, as does a cue tag or adsquared URL.
  const clientSpans = [];
  let untimedMarker = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("#")) continue;
    const [tag, value] = splitTag(line);
    if (!KNOWN_MEDIA_TAGS.has(tag)) unknownTags.add(tag);
    if (tag === "#EXT-X-ENDLIST") result.ended = true;
    if (/SCTE35|CUE-OUT|CUE-IN/.test(line)) {
      reasons.add(`cue tag ${tag}`);
      stitched = true;
      untimedMarker = true;
    }
    if (line.includes("/adsquared/")) {
      reasons.add("adsquared url");
      stitched = true;
      untimedMarker = true;
    }

    switch (tag) {
      case "#EXT-X-MEDIA-SEQUENCE":
        result.mediaSequence = Number(value);
        break;
      case "#EXT-X-TARGETDURATION":
        result.targetDuration = Number(value);
        break;
      case "#EXT-X-DISCONTINUITY":
        result.discontinuities++;
        discontinuityAfterLastSegment = true;
        break;
      case "#EXT-X-PROGRAM-DATE-TIME":
        nextStart = Date.parse(value);
        break;
      case "#EXT-X-TWITCH-PREFETCH":
        result.prefetch++;
        break;
      case "#EXT-X-MAP":
        maps.add(parseAttributes(value).URI);
        break;
      case "#EXTINF": {
        result.segments++;
        discontinuityAfterLastSegment = false;
        const title = value.slice(value.indexOf(",") + 1);
        newestTitle = title;
        newestStart = nextStart;
        nextStart = newestStart + Number(value.slice(0, value.indexOf(","))) * 1000;
        result.titles[title] = (result.titles[title] || 0) + 1;
        if (title !== LIVE_SEGMENT_TITLE) {
          reasons.add(`segment title "${title}"`);
          stitched = true;
        }
        break;
      }
      case "#EXT-X-DATERANGE": {
        const attrs = parseAttributes(value);
        const cls = attrs.CLASS || "(none)";
        result.dateRangeClasses[cls] = (result.dateRangeClasses[cls] || 0) + 1;
        const adKeys = Object.keys(attrs).filter((k) => AD_ATTRIBUTE_RE.test(k));
        for (const key of adKeys) adAttributes.add(key);
        if (AD_NAME_RE.test(cls)) reasons.add(`daterange class "${cls}"`);
        if (AD_NAME_RE.test(attrs.ID || "")) reasons.add(`daterange id "${attrs.ID}"`);
        if (AD_NAME_RE.test(cls) || AD_NAME_RE.test(attrs.ID || "") || adKeys.length > 0) {
          adDateRanges.set(attrs.ID, {
            id: attrs.ID || null,
            class: cls,
            plannedDuration: attrs["PLANNED-DURATION"] ? Number(attrs["PLANNED-DURATION"]) : null,
            primaryPod: attrs["X-TTV-MAF-AD-PRIMARY-POD"] ?? null,
            fallbackFormats: attrs["X-TTV-MAF-AD-FALLBACK-FORMATS"] ?? null,
          });
          // Stitched ads are judged by their segments instead.
          if (!/stitched/i.test(cls)) {
            const start = Date.parse(attrs["START-DATE"]);
            const seconds = Number(attrs.DURATION ?? attrs["PLANNED-DURATION"]);
            if (Number.isFinite(start) && seconds > 0) clientSpans.push([start, start + seconds * 1000]);
            else untimedMarker = true;
          }
        }
        if (/stitched/i.test(cls)) stitched = true;
        const source = attrs["X-TV-TWITCH-STREAM-SOURCE"];
        if (source) {
          sources.add(source);
          if (source !== "live") {
            reasons.add(`stream source "${source}"`);
            stitched = true;
          }
        }
        break;
      }
    }
  }
  if (adAttributes.size > 0) reasons.add("ad attributes on a daterange");
  if (discontinuityAfterLastSegment) {
    reasons.add("discontinuity after the last segment");
    stitched = true;
  }

  result.mapCount = maps.size;
  result.streamSources = [...sources];
  result.adAttributes = [...adAttributes].sort();
  result.adDateRanges = [...adDateRanges.values()];
  result.unknownTags = [...unknownTags].sort();
  result.adReasons = [...reasons];
  result.adKind = stitched ? "stitched" : reasons.size > 0 ? "client" : null;
  result.isAd = result.adKind !== null;
  result.adAtLiveEdge =
    result.isAd &&
    (untimedMarker ||
      newestTitle === null ||
      newestTitle !== LIVE_SEGMENT_TITLE ||
      discontinuityAfterLastSegment ||
      clientSpans.some(([start, end]) => !Number.isFinite(newestStart) || (newestStart >= start && newestStart < end)));
  return result;
}

// Two playlists with the same signature differ only in which segments they list,
// so there is nothing new to capture.
function playlistSignature(analysis) {
  return JSON.stringify([
    Object.keys(analysis.titles).sort(),
    Object.keys(analysis.dateRangeClasses).sort(),
    [...analysis.streamSources].sort(),
    analysis.adAttributes,
    analysis.unknownTags,
    analysis.discontinuities > 0,
    analysis.adKind,
    analysis.ended,
  ]);
}

// Token fields that matter for ads and quality; drops user_id, user_ip, device_id.
function summarizeToken(token) {
  if (!token) return null;
  const keys = [
    "channel",
    "player_type",
    "platform",
    "server_ads",
    "show_ads",
    "hide_ads",
    "turbo",
    "subscriber",
    "maximum_resolution",
    "maximum_resolution_reasons",
    "maximum_video_bitrate_kbps",
  ];
  return Object.fromEntries(keys.filter((k) => k in token).map((k) => [k, token[k]]));
}

function redactMaster(text) {
  return text.replace(/(DATA-ID="USER-IP",VALUE=")[^"]*/g, "$1redacted");
}

// Multitrack masters can list the same resolution in several codecs, so match on
// the stable id and codecs together; name-only is a fallback. Returns null rather
// than an arbitrary rendition, since splicing a different codec breaks playback.
function pickVariant(variants, wanted) {
  if (!wanted) return variants[0] || null;
  const sameId = (v) => (wanted.stableId && v.stableId === wanted.stableId) || v.name === wanted.name;
  return (
    variants.find((v) => sameId(v) && v.codecs === wanted.codecs) ||
    variants.find(sameId) ||
    null
  );
}

// The best rendition below `wanted` in the same video codec family, for when no
// ad-free session has the wanted one. Different families can't share a stream.
function pickLowerVariant(variants, wanted) {
  const pixels = (v) => {
    const [w, h] = (v.resolution || "").split("x").map(Number);
    return w > 0 && h > 0 ? w * h : null;
  };
  const family = (v) => (v.codecs || "").split(",")[0].split(".")[0];
  const limit = wanted && pixels(wanted);
  if (!limit) return null;
  return (
    variants
      .filter((v) => pixels(v) !== null && pixels(v) < limit && family(v) === family(wanted))
      .sort((a, b) => pixels(b) - pixels(a) || (b.bandwidth || 0) - (a.bandwidth || 0))[0] || null
  );
}

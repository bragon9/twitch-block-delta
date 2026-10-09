"use strict";
// Pure playlist splicing (depends on playlist.js). Every live segment is keyed by
// its global live sequence number: the number, timing and even the bytes of a live
// segment are identical in every playback session. So ad segments in the page's
// playlist can be replaced with the same-numbered live segments from an ad-free
// backup session, and the player sees one continuous live stream.
//
// Once a stream has been spliced, its output is always numbered by live sequence,
// because Twitch's own numbering for that session is offset by the ad segments.
//
// When no ad-free backup has the page's rendition, a lower rendition of the same
// stream fills in instead. Those segments have their own init segment and
// resolution, so each switch to or from them is marked with a discontinuity.

const MAX_WINDOW_SEGMENTS = 20;
const REGENERATED_HEADER_TAGS = new Set([
  "#EXTM3U",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-TWITCH-LIVE-SEQUENCE",
  "#EXT-X-DISCONTINUITY-SEQUENCE",
  "#EXT-X-TARGETDURATION",
  // Ad playlists ask the player to start at the first (ad) segment.
  "#EXT-X-START",
]);

function isAdDateRange(line) {
  const attrs = parseAttributes(splitTag(line)[1]);
  if (AD_NAME_RE.test(attrs.CLASS || "") || AD_NAME_RE.test(attrs.ID || "")) return true;
  const source = attrs["X-TV-TWITCH-STREAM-SOURCE"];
  if (source && source !== LIVE_SEGMENT_TITLE) return true;
  return Object.keys(attrs).some((key) => AD_ATTRIBUTE_RE.test(key));
}

// Removes ad markers but leaves everything else byte-for-byte. Used on streams
// with no stitched ad, so client-rendered ads (twitch-maf-ad) never trigger.
function stripAdMarkers(text) {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !(line.startsWith("#EXT-X-DATERANGE") && isAdDateRange(line)));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}

// `assumeFreshSession`: a backup session has never had an ad, so its media
// sequence is the live sequence even without an explicit tag.
function parseMediaPlaylist(text, { assumeFreshSession = false } = {}) {
  const header = [];
  const dateRanges = [];
  const segments = [];
  const prefetch = [];
  let mediaSequence = 0;
  let targetDuration = 0;
  let nextLiveSeq = null;
  let map = null;
  let pending = { pdt: null, extinf: null, discontinuity: false };
  let seenSegment = false;
  let seenAd = false;
  let ended = false;
  // Anything between the last segment and the prefetch hints (a discontinuity,
  // a new init segment, an ad marker) means the hints point at what comes next,
  // which at an ad boundary is the ad itself.
  let changedAfterLastSegment = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("#")) {
      if (pending.extinf === null) continue;
      const title = pending.extinf.slice(pending.extinf.indexOf(",") + 1);
      const isLive = title === LIVE_SEGMENT_TITLE;
      let liveSeq = null;
      if (isLive) {
        if (nextLiveSeq === null && assumeFreshSession && !seenAd) nextLiveSeq = mediaSequence + segments.length;
        liveSeq = nextLiveSeq;
        if (nextLiveSeq !== null) nextLiveSeq++;
      } else {
        seenAd = true;
        nextLiveSeq = null;
      }
      segments.push({
        index: mediaSequence + segments.length,
        liveSeq,
        isLive,
        title,
        extinf: pending.extinf,
        pdt: pending.pdt,
        discontinuity: pending.discontinuity,
        map,
        url: line,
      });
      pending = { pdt: null, extinf: null, discontinuity: false };
      seenSegment = true;
      changedAfterLastSegment = false;
      continue;
    }
    const [tag, value] = splitTag(line);
    switch (tag) {
      case "#EXT-X-MEDIA-SEQUENCE":
        mediaSequence = Number(value);
        break;
      case "#EXT-X-TARGETDURATION":
        targetDuration = Number(value);
        break;
      case "#EXT-X-TWITCH-LIVE-SEQUENCE":
        nextLiveSeq = Number(value);
        break;
      case "#EXT-X-MAP":
        map = parseAttributes(value).URI;
        changedAfterLastSegment = true;
        break;
      case "#EXT-X-DISCONTINUITY":
        pending.discontinuity = true;
        changedAfterLastSegment = true;
        break;
      case "#EXT-X-PROGRAM-DATE-TIME":
        pending.pdt = value;
        break;
      case "#EXTINF":
        pending.extinf = value;
        break;
      case "#EXT-X-TWITCH-PREFETCH":
        prefetch.push(value);
        break;
      case "#EXT-X-ENDLIST":
        ended = true;
        break;
      case "#EXT-X-DATERANGE":
        dateRanges.push(line);
        if (isAdDateRange(line)) changedAfterLastSegment = true;
        break;
      default:
        if (!seenSegment && !REGENERATED_HEADER_TAGS.has(tag)) header.push(line);
    }
  }
  const prefetchSafe = seenSegment && !changedAfterLastSegment;
  return { header, dateRanges, segments, prefetch, prefetchSafe, mediaSequence, targetDuration, ended };
}

// Fills in live sequence numbers for page-playlist segments that have no tag,
// using the offset between Twitch's session numbering and live numbering. That
// offset only changes when an ad adds segments, and every ad ends with a tag.
function resolveNativeLiveSeqs(native, memory) {
  for (const seg of native.segments) {
    if (seg.isLive && seg.liveSeq !== null) memory.nativeOffset = seg.liveSeq - seg.index;
  }
  let unresolved = 0;
  for (const seg of native.segments) {
    if (!seg.isLive || seg.liveSeq !== null) continue;
    if (memory.nativeOffset === null) unresolved++;
    else seg.liveSeq = seg.index + memory.nativeOffset;
  }
  return unresolved;
}

// memory: per-stream state kept across calls, created by newSpliceMemory().
// lowSeqs: live sequences served from a lower rendition. boundaries: live
// sequences that start after a switch between renditions, so each keeps its
// discontinuity (and the sequence number counting them) in every later playlist.
// lastOutput: the last playlist produced, which the blocker repeats if nothing new is live.
function newSpliceMemory() {
  return { nativeOffset: null, liveInit: null, lowSeqs: new Set(), boundaries: new Set(), lastOutput: null };
}

// `backupLowered`: the backup is a lower rendition than the page's.
function spliceMediaPlaylist(nativeText, backupText, memory, { backupLowered = false } = {}) {
  const native = parseMediaPlaylist(nativeText);
  const backup = backupText ? parseMediaPlaylist(backupText, { assumeFreshSession: true }) : null;
  const unresolved = resolveNativeLiveSeqs(native, memory);

  const lastNativeLive = native.segments.filter((s) => s.isLive && s.liveSeq !== null).at(-1);
  if (lastNativeLive) memory.liveInit = lastNativeLive.map;
  else if (!memory.liveInit) memory.liveInit = backup?.segments.find((s) => s.isLive)?.map ?? null;

  // Native segments win; backup fills the numbers the ad took.
  const bySeq = new Map();
  for (const seg of backup?.segments ?? []) {
    if (seg.isLive && seg.liveSeq !== null) bySeq.set(seg.liveSeq, { seg, source: "backup" });
  }
  for (const seg of native.segments) {
    if (!seg.isLive || seg.liveSeq === null) continue;
    // Once a number came from the lower rendition it stays there, so the player
    // is never handed a different segment for a number it already has.
    if (backupLowered && memory.lowSeqs.has(seg.liveSeq) && bySeq.has(seg.liveSeq)) continue;
    bySeq.set(seg.liveSeq, { seg, source: "native" });
  }

  const stats = {
    adSegmentsDropped: native.segments.filter((s) => !s.isLive).length,
    backupAdSegments: backup ? backup.segments.filter((s) => !s.isLive).length : null,
    unresolvedNative: unresolved,
    fromNative: 0,
    fromBackup: 0,
    fromLowered: 0,
    window: null,
    gapTrimmed: false,
  };
  if (bySeq.size === 0) return { text: null, stats };

  // The longest contiguous run ending at the newest segment, so the player never
  // sees a hole. Anything older than a gap is dropped from the front.
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  let start = seqs.length - 1;
  while (start > 0 && seqs[start - 1] === seqs[start] - 1) start--;
  stats.gapTrimmed = start > 0;
  const window = seqs.slice(Math.max(start, seqs.length - MAX_WINDOW_SEGMENTS));
  stats.window = [window[0], window.at(-1)];

  const out = ["#EXTM3U"];
  out.push(...(native.header.length ? native.header : backup?.header ?? []));
  const targetDuration = Math.max(native.targetDuration, backup?.targetDuration ?? 0, 1);
  out.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
  out.push(`#EXT-X-MEDIA-SEQUENCE:${window[0]}`);
  out.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${window[0]}`);
  if (backupLowered) for (const seq of window) if (bySeq.get(seq).source === "backup") memory.lowSeqs.add(seq);
  const isLow = (seq) => memory.lowSeqs.has(seq);
  for (const seq of window.slice(1)) if (isLow(seq) !== isLow(seq - 1)) memory.boundaries.add(seq);
  const discontinuitiesBefore = [...memory.boundaries].filter((seq) => seq <= window[0]).length;
  if (discontinuitiesBefore > 0) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitiesBefore}`);
  out.push(...native.dateRanges.filter((line) => !isAdDateRange(line)));

  let currentMap = null;
  for (const seq of window) {
    const { seg, source } = bySeq.get(seq);
    // Backup init segments of the page's rendition are byte-identical to the
    // page's, so reuse the page's. A lower rendition needs its own.
    const lowered = source === "backup" && isLow(seq);
    const map = source === "native" || lowered ? seg.map : memory.liveInit ?? seg.map;
    if (seq > window[0] && memory.boundaries.has(seq)) {
      out.push("#EXT-X-DISCONTINUITY");
      currentMap = null;
    }
    if (map && map !== currentMap) {
      out.push(`#EXT-X-MAP:URI="${map}"`);
      currentMap = map;
    }
    if (seg.pdt) out.push(`#EXT-X-PROGRAM-DATE-TIME:${seg.pdt}`);
    out.push(`#EXTINF:${seg.extinf}`, seg.url);
    if (source === "native") stats.fromNative++;
    else stats.fromBackup++;
    if (lowered) stats.fromLowered++;
  }

  // Prefetch hints describe the segments after a playlist's newest one, so they
  // are only valid if that playlist supplied our newest segment and nothing
  // (like the start of an ad) sits between that segment and the hints.
  const tail = bySeq.get(window.at(-1));
  const tailSource = tail.source === "native" ? native : backup;
  const tailLowered = tail.source === "backup" && isLow(window.at(-1));
  stats.prefetch = !tailLowered && tailSource.segments.at(-1) === tail.seg && tailSource.prefetchSafe && !native.ended ? tail.source : "dropped";
  if (stats.prefetch !== "dropped") {
    for (const url of tailSource.prefetch) out.push(`#EXT-X-TWITCH-PREFETCH:${url}`);
  }
  // Without it the player keeps polling a finished stream until the URL 404s.
  if (native.ended) out.push("#EXT-X-ENDLIST");

  return { text: `${out.join("\n")}\n`, stats };
}

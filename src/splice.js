"use strict";
// Pure playlist splicing (depends on playlist.js). Every live segment is keyed by
// its global live sequence number: the number, timing and even the bytes of a live
// segment are identical in every playback session. So ad segments in the page's
// playlist can be replaced with the same-numbered live segments from other
// playback sessions ("backups"), and the player sees one continuous live stream.
// Backups get ads too, at their own times, so any number of them can be merged.
//
// Once a stream has been spliced, its output is always numbered by live sequence,
// because Twitch's own numbering for that session is offset by the ad segments.

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

// Live segments that no source had before newer ones arrived, e.g. when every
// source was in an ad at once, are lost for good. Up to this many are bridged
// with a discontinuity; a longer hole means the player fell behind (paused, tab
// asleep), so the output jumps ahead instead.
const MAX_LOST_SEGMENTS = 30;
// A hole only counts as lost if the player was given a playlist this recently;
// after a longer pause it just fell behind.
const LOSS_POLL_GAP_MS = 10_000;

// What the player has been given in one playback session, across all of its
// renditions: the player can switch quality at any time, so a hole in one
// rendition's history may have been filled by another. `gaps` lists lost live
// sequence ranges [first, last]; `newestOut` is the newest live sequence
// delivered and `lastOutAt` when the last playlist was.
function newSpliceSession() {
  return { gaps: [], newestOut: null, lastOutAt: null };
}

// memory: per-stream state kept across calls, created by newSpliceMemory().
// Pass the same session to every rendition of a playback session.
function newSpliceMemory(session = newSpliceSession()) {
  return { nativeOffset: null, liveInit: null, session };
}

function lostBefore(gaps, seq) {
  let n = 0;
  for (const [first, last] of gaps) if (first < seq) n += Math.min(last, seq - 1) - first + 1;
  return n;
}

function isLost(gaps, seq) {
  return gaps.some(([first, last]) => seq >= first && seq <= last);
}

// True when every number strictly between a and b is lost.
function bridged(gaps, a, b) {
  for (let seq = a + 1; seq < b; seq++) if (!isLost(gaps, seq)) return false;
  return true;
}

function addGap(gaps, first, last) {
  gaps.push([first, last]);
  gaps.sort((a, b) => a[0] - b[0]);
  for (let i = gaps.length - 1; i > 0; i--) {
    if (gaps[i][0] <= gaps[i - 1][1] + 1) {
      gaps[i - 1][1] = Math.max(gaps[i - 1][1], gaps[i][1]);
      gaps.splice(i, 1);
    }
  }
}

// Start of the newest run of numbers with no hole, counting lost numbers as no hole.
function runStart(seqs, gaps) {
  let start = seqs.length - 1;
  while (start > 0 && bridged(gaps, seqs[start - 1], seqs[start])) start--;
  return start;
}

// Whether a playlist's newest segment is live with nothing (an ad marker, a
// discontinuity) queued after it, i.e. it can supply the live edge right now.
function liveAtEdge(parsed) {
  const newest = parsed.segments.at(-1);
  return Boolean(newest?.isLive && parsed.prefetchSafe && !parsed.ended);
}

// `backupTexts`: playlists of the same rendition from other playback sessions
// (null, one, or an array; entries may be null). None is assumed ad-free: each
// contributes whatever live segments it has. `now`: the time in ms, or null to
// skip the check that the player has been polling.
function spliceMediaPlaylist(nativeText, backupTexts, memory, now = null) {
  const texts = Array.isArray(backupTexts) ? backupTexts : [backupTexts];
  const native = parseMediaPlaylist(nativeText);
  const backups = texts.map((text) => (text ? parseMediaPlaylist(text, { assumeFreshSession: true }) : null));
  const usable = backups.filter(Boolean);
  const unresolved = resolveNativeLiveSeqs(native, memory);
  const { session } = memory;
  const { gaps } = session;

  const lastNativeLive = native.segments.filter((s) => s.isLive && s.liveSeq !== null).at(-1);
  if (lastNativeLive) memory.liveInit = lastNativeLive.map;
  else if (!memory.liveInit) memory.liveInit = usable.flatMap((b) => b.segments).find((s) => s.isLive)?.map ?? null;

  // Native segments win; backups fill the numbers the ad took, earlier backups first.
  const bySeq = new Map();
  for (const backup of [...usable].reverse()) {
    for (const seg of backup.segments) {
      if (seg.isLive && seg.liveSeq !== null) bySeq.set(seg.liveSeq, { seg, source: backup });
    }
  }
  for (const seg of native.segments) {
    if (seg.isLive && seg.liveSeq !== null) bySeq.set(seg.liveSeq, { seg, source: native });
  }
  // A number declared lost stays lost, even if a source turns up with it later,
  // so the output's numbering never changes under the player.
  for (const seq of [...bySeq.keys()]) if (isLost(gaps, seq)) bySeq.delete(seq);

  const stats = {
    adSegmentsDropped: native.segments.filter((s) => !s.isLive).length,
    backupAdSegments: usable.length ? usable.reduce((n, b) => n + b.segments.filter((s) => !s.isLive).length, 0) : null,
    backups: backups.map((b) => (b ? { adSegments: b.segments.filter((s) => !s.isLive).length, liveAtEdge: liveAtEdge(b) } : null)),
    nativeLiveAtEdge: liveAtEdge(native),
    unresolvedNative: unresolved,
    fromNative: 0,
    fromBackup: 0,
    window: null,
    outWindow: null,
    gapTrimmed: false,
    lost: 0,
  };
  if (bySeq.size === 0) return { text: null, stats };

  // The newest run with no hole, so the player never waits on a segment that
  // doesn't exist. A hole right after what the player already has means no
  // source had those segments: they are declared lost and bridged. Older holes
  // are trimmed from the front.
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  let start = runStart(seqs, gaps);
  const polling = now === null || session.lastOutAt === null || now - session.lastOutAt <= LOSS_POLL_GAP_MS;
  const hole = session.newestOut === null ? 0 : seqs[start] - session.newestOut - 1;
  if (hole > 0 && hole <= MAX_LOST_SEGMENTS && polling) {
    addGap(gaps, session.newestOut + 1, seqs[start] - 1);
    stats.lost = hole;
    start = runStart(seqs, gaps);
  }
  stats.gapTrimmed = start > 0;
  const window = seqs.slice(Math.max(start, seqs.length - MAX_WINDOW_SEGMENTS));
  stats.window = [window[0], window.at(-1)];
  // The newest number the player has been given, in any rendition. It never
  // moves back, even when a source briefly drops out and the window ends
  // earlier than last time.
  session.newestOut = Math.max(session.newestOut ?? -Infinity, window.at(-1));
  session.lastOutAt = now;

  // Output numbers skip lost numbers, so they stay contiguous across a loss.
  const outSeq = (seq) => seq - lostBefore(gaps, seq);
  stats.outWindow = [outSeq(window[0]), outSeq(window.at(-1))];
  // A discontinuity sits before the first segment after each loss; the count of
  // those that have scrolled out of the window is the discontinuity sequence.
  const afterLoss = (seq) => gaps.some(([, last]) => last === seq - 1);
  const discontinuitySequence = gaps.filter(([, last]) => last + 1 < window[0]).length;

  const out = ["#EXTM3U"];
  const header = native.header.length ? native.header : usable.find((b) => b.header.length)?.header ?? [];
  out.push(...header);
  const targetDuration = Math.max(native.targetDuration, ...usable.map((b) => b.targetDuration), 1);
  out.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
  out.push(`#EXT-X-MEDIA-SEQUENCE:${outSeq(window[0])}`);
  out.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${outSeq(window[0])}`);
  if (discontinuitySequence > 0) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`);
  out.push(...native.dateRanges.filter((line) => !isAdDateRange(line)));

  let currentMap = null;
  for (const seq of window) {
    const { seg, source } = bySeq.get(seq);
    if (afterLoss(seq)) {
      out.push("#EXT-X-DISCONTINUITY");
      currentMap = null;
    }
    // Backup init segments are byte-identical to the page's, so reuse the page's.
    const map = source === native ? seg.map : memory.liveInit ?? seg.map;
    if (map && map !== currentMap) {
      out.push(`#EXT-X-MAP:URI="${map}"`);
      currentMap = map;
    }
    if (seg.pdt) out.push(`#EXT-X-PROGRAM-DATE-TIME:${seg.pdt}`);
    out.push(`#EXTINF:${seg.extinf}`, seg.url);
    if (source === native) stats.fromNative++;
    else stats.fromBackup++;
  }

  // Prefetch hints describe the segments after a playlist's newest one, so they
  // are only valid if that playlist supplied our newest segment and nothing
  // (like the start of an ad) sits between that segment and the hints.
  const tail = bySeq.get(window.at(-1));
  const tailOk = tail.source.segments.at(-1) === tail.seg && tail.source.prefetchSafe && !native.ended;
  stats.prefetch = !tailOk ? "dropped" : tail.source === native ? "native" : "backup";
  if (tailOk) {
    for (const url of tail.source.prefetch) out.push(`#EXT-X-TWITCH-PREFETCH:${url}`);
  }
  // Without it the player keeps polling a finished stream until the URL 404s.
  if (native.ended) out.push("#EXT-X-ENDLIST");

  return { text: `${out.join("\n")}\n`, stats };
}

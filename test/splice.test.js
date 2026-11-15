// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const lib = (0, eval)(
  `${read("src/playlist.js")}\n${read("src/splice.js")}\n;({ analyzeMedia, parseMediaPlaylist, spliceMediaPlaylist, newSpliceMemory, newSpliceSession, stripAdMarkers })`,
);

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
const fixture = (name) => read(`test/fixtures/splice/${name}.m3u8`);

// Checks the invariants the player relies on: no ad markup, live titles only,
// and segment numbers that match the declared media sequence.
function assertCleanContinuous(text) {
  const analysis = lib.analyzeMedia(text);
  eq(analysis.isAd, false, "output has no ad markup");
  const parsed = lib.parseMediaPlaylist(text);
  eq(parsed.segments.every((s) => s.liveSeq !== null), true, "every segment numbered");
  eq(parsed.segments.map((s) => s.liveSeq), parsed.segments.map((_, i) => parsed.mediaSequence + i), "contiguous numbering");
  eq(text.includes("#EXT-X-DISCONTINUITY"), false, "no discontinuity");
  eq(text.includes("#EXT-X-START"), false, "no start offset");
  return parsed;
}

test("parser numbers live segments by live sequence, not session index", () => {
  const post = lib.parseMediaPlaylist(fixture("post-ad-native"));
  const live = post.segments.filter((s) => s.isLive);
  eq(live.map((s) => s.liveSeq), [3494, 3495], "live seqs");
  eq(live[0].index - live[0].liveSeq, 3, "session numbering runs ahead by the ad segments");
});

test("mid-ad: an all-ad page playlist becomes the backup's live segments", () => {
  const memory = lib.newSpliceMemory();
  memory.liveInit = "https://native.example/live-init.mp4";
  const { text, stats } = lib.spliceMediaPlaylist(fixture("mid-ad-native"), fixture("mid-ad-backup"), memory);
  const out = assertCleanContinuous(text);
  eq(stats.window, [3459, 3472], "window");
  eq([stats.fromNative, stats.fromBackup], [0, 14], "sources");
  eq(out.segments.every((s) => s.url.startsWith("https://backup.example/")), true, "backup urls");
  eq(out.segments.every((s) => s.map === "https://native.example/live-init.mp4"), true, "page init reused");
  eq(stats.adSegmentsDropped > 0, true, "ads dropped");
});

test("post-ad: backup fills the gap and hands over to the page's live segments", () => {
  const { text, stats } = lib.spliceMediaPlaylist(fixture("post-ad-native"), fixture("post-ad-backup"), lib.newSpliceMemory());
  const out = assertCleanContinuous(text);
  eq(stats.window, [3481, 3495], "window");
  eq([stats.fromNative, stats.fromBackup], [2, 13], "sources");
  eq(out.segments.slice(-2).every((s) => s.url.startsWith("https://native.example/")), true, "newest from page");
  eq(new Set(out.segments.map((s) => s.map)).size, 1, "single init segment");
  eq(text.includes("#EXT-X-TWITCH-PREFETCH:https://native.example/"), true, "page prefetch kept");
});

test("after an ad, untagged page segments keep live numbering via the remembered offset", () => {
  const memory = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(fixture("post-ad-native"), fixture("post-ad-backup"), memory);
  eq(memory.nativeOffset, -3, "offset");
  // A later page playlist with the ad scrolled out and no live-sequence tag.
  const later = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:3499",
    '#EXT-X-MAP:URI="https://native.example/live-init.mp4"',
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-26T01:48:31.198Z",
    "#EXTINF:2.000,live",
    "https://native.example/a.mp4",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-26T01:48:33.198Z",
    "#EXTINF:2.000,live",
    "https://native.example/b.mp4",
  ].join("\n");
  const { text, stats } = lib.spliceMediaPlaylist(later, null, memory);
  assertCleanContinuous(text);
  eq(stats.window, [3496, 3497], "window");
});

test("prefetch hints that point past an ad boundary are dropped", () => {
  // Real playlist from the moment an ad began: the last live segment is followed
  // by ad markers, a discontinuity, the ad's init segment, and prefetch hints for
  // the ad's segments. Forwarding those hints made the player append H.264 ad
  // segments to an HEVC stream (Twitch error #3000).
  const text = fixture("ad-starting-native");
  eq(lib.parseMediaPlaylist(text).prefetchSafe, false, "prefetch unsafe");
  const { text: out, stats } = lib.spliceMediaPlaylist(text, null, lib.newSpliceMemory());
  assertCleanContinuous(out);
  eq(out.includes("#EXT-X-TWITCH-PREFETCH"), false, "no prefetch in output");
  eq(stats.prefetch, "dropped", "stats");
});

test("a bare discontinuity before prefetch hints counts as an ad starting", () => {
  // Same boundary with the ad markers removed: only the discontinuity, a new init
  // segment, and prefetch hints remain. It must still take the safe path.
  const bare = fixture("ad-starting-native")
    .split("\n")
    .filter((line) => !line.startsWith("#EXT-X-DATERANGE") || line.includes("CLASS=\"twitch-session\""))
    .join("\n");
  const analysis = lib.analyzeMedia(bare);
  eq(analysis.adKind, "stitched", "kind");
  eq(analysis.adReasons, ["discontinuity after the last segment"], "reasons");
});

test("a marker for an ad the page draws keeps the prefetch hints", () => {
  // Real playlist: the twitch-maf-ad marker sits between the two hints, and the
  // live video continues. Dropping the hints here made the player rebuffer.
  const maf = read("test/fixtures/maf-client-ad-media.m3u8");
  eq(lib.parseMediaPlaylist(maf).prefetchSafe, true, "prefetch safe");
  const { text, stats } = lib.spliceMediaPlaylist(maf, null, lib.newSpliceMemory());
  eq(stats.prefetch, "native", "kept");
  eq(text.split("\n").filter((l) => l.startsWith("#EXT-X-TWITCH-PREFETCH")).length, 2, "both hints");
  eq(text.includes("twitch-maf-ad"), false, "marker still removed");
});

test("a page-drawn ad marker that also signals ad video still drops the hints", () => {
  const maf = read("test/fixtures/maf-client-ad-media.m3u8");
  const stitched = maf.replace('CLASS="twitch-maf-ad"', 'CLASS="twitch-stitched-ad"');
  eq(lib.parseMediaPlaylist(stitched).prefetchSafe, false, "stitched class");
  const source = maf.replace('CLASS="twitch-maf-ad",', 'CLASS="twitch-maf-ad",X-TV-TWITCH-STREAM-SOURCE="Amazon",');
  eq(lib.parseMediaPlaylist(source).prefetchSafe, false, "non-live source");
  const discontinuity = maf.replace("#EXT-X-DATERANGE:ID=\"maf-ad", "#EXT-X-DISCONTINUITY\n#EXT-X-DATERANGE:ID=\"maf-ad");
  eq(lib.parseMediaPlaylist(discontinuity).prefetchSafe, false, "discontinuity");
});

test("prefetch hints on a clean live playlist are kept", () => {
  const post = lib.parseMediaPlaylist(fixture("post-ad-native"));
  eq(post.prefetchSafe, true, "post-ad live tail is safe");
  const backup = lib.parseMediaPlaylist(fixture("mid-ad-backup"));
  eq(backup.prefetchSafe, true, "clean backup is safe");
});

test("the end of a stream is passed on to the player", () => {
  // Real last playlist of a broadcast on a session spliced earlier. Dropping
  // #EXT-X-ENDLIST kept the player polling until the playlist URL 404'd.
  const ended = fixture("stream-ended-native");
  eq(lib.analyzeMedia(ended).ended, true, "analysis");
  eq(lib.analyzeMedia(ended).unknownTags, [], "known tag");
  const { text, stats } = lib.spliceMediaPlaylist(ended, null, lib.newSpliceMemory());
  assertCleanContinuous(text);
  eq(stats.window, [6938, 6954], "window");
  eq(text.trimEnd().split("\n").at(-1), "#EXT-X-ENDLIST", "last line");
});

test("a stream that has ended gets no prefetch hints", () => {
  const ended = `${fixture("post-ad-native").trimEnd()}\n#EXT-X-ENDLIST\n`;
  const { text, stats } = lib.spliceMediaPlaylist(ended, fixture("post-ad-backup"), lib.newSpliceMemory());
  eq(text.includes("#EXT-X-TWITCH-PREFETCH"), false, "no prefetch in output");
  eq(stats.prefetch, "dropped", "stats");
  eq(text.trimEnd().split("\n").at(-1), "#EXT-X-ENDLIST", "last line");
});

test("no backup and no live segments yields nothing to splice", () => {
  const { text } = lib.spliceMediaPlaylist(fixture("mid-ad-native"), null, lib.newSpliceMemory());
  eq(text, null, "text");
});

test("stripAdMarkers removes the client ad marker and nothing else", () => {
  const maf = read("test/fixtures/maf-client-ad-media.m3u8");
  const { text, removed } = lib.stripAdMarkers(maf);
  eq(removed, 1, "removed");
  eq(lib.analyzeMedia(text).isAd, false, "clean");
  eq(text.split("\n").length, maf.split("\n").length - 1, "one line");
});

// Builds a media playlist. `items`: a number is a live segment with that live
// sequence, "ad" an ad segment. A live segment after an ad carries Twitch's
// live-sequence tag, as real playlists do.
function playlist(index, items, { base = "https://src.example/", prefetch = true, tagLive = true } = {}) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:6", `#EXT-X-MEDIA-SEQUENCE:${index}`];
  if (tagLive && typeof items[0] === "number") lines.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${items[0]}`);
  lines.push('#EXT-X-MAP:URI="https://init.example/live.mp4"');
  let inAd = false;
  items.forEach((item, i) => {
    if (item === "ad") {
      if (!inAd) lines.push("#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="https://init.example/ad.mp4"');
      inAd = true;
      lines.push("#EXTINF:2.000,Creative", `${base}ad-${index + i}.mp4`);
      return;
    }
    if (inAd) lines.push("#EXT-X-DISCONTINUITY", `#EXT-X-TWITCH-LIVE-SEQUENCE:${item}`, '#EXT-X-MAP:URI="https://init.example/live.mp4"');
    inAd = false;
    lines.push("#EXTINF:2.000,live", `${base}live-${item}.mp4`);
  });
  if (prefetch) lines.push(`#EXT-X-TWITCH-PREFETCH:${base}next.mp4`);
  return `${lines.join("\n")}\n`;
}
const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const ads = (n) => Array(n).fill("ad");
const allAdNative = playlist(500, ads(8), { base: "https://native.example/" });
const segmentUrls = (text) => lib.parseMediaPlaylist(text).segments.map((s) => s.url.replace(/^.*\//, ""));

test("a second backup supplies the live edge while the first is in an ad", () => {
  const first = playlist(90, [...range(90, 97), "ad", "ad"], { base: "https://a.example/" });
  const second = playlist(92, range(92, 99), { base: "https://b.example/" });
  const { text, stats } = lib.spliceMediaPlaylist(allAdNative, [first, second], lib.newSpliceMemory());
  assertCleanContinuous(text);
  eq(stats.window, [90, 99], "window");
  eq(stats.backups.map((b) => b.liveAtEdge), [false, true], "edge per backup");
  eq(stats.lost, 0, "nothing lost");
  eq(segmentUrls(text).slice(-2), ["live-98.mp4", "live-99.mp4"], "edge from the second backup");
  eq(text.includes("#EXT-X-TWITCH-PREFETCH:https://b.example/next.mp4"), true, "its prefetch kept");
});

test("a backup that failed this time is skipped", () => {
  const { text, stats } = lib.spliceMediaPlaylist(allAdNative, [null, playlist(90, range(90, 99))], lib.newSpliceMemory());
  assertCleanContinuous(text);
  eq(stats.window, [90, 99], "window");
  eq(stats.backups[0], null, "no stats for the failed one");
});

test("segments no source had are bridged with a discontinuity, keeping the numbering", () => {
  const memory = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), memory);
  // Every source is in an ad over 100-102; the backup comes back at 103.
  const { text, stats } = lib.spliceMediaPlaylist(allAdNative, playlist(94, [...range(94, 99), ...ads(3), 103]), memory);
  eq(stats.lost, 3, "lost");
  eq(memory.session.gaps, [[100, 102]], "gap remembered");
  eq(stats.window, [94, 103], "live window");
  eq(stats.outWindow, [94, 100], "output numbers stay contiguous");
  const parsed = lib.parseMediaPlaylist(text);
  eq(parsed.mediaSequence, 94, "media sequence");
  eq(parsed.segments.length, 7, "older segments kept, not trimmed to one");
  eq(segmentUrls(text), ["live-94.mp4", "live-95.mp4", "live-96.mp4", "live-97.mp4", "live-98.mp4", "live-99.mp4", "live-103.mp4"], "urls");
  eq(parsed.segments.map((s) => s.discontinuity), [false, false, false, false, false, false, true], "discontinuity before 103");
  eq(parsed.segments.at(-1).map, "https://init.example/live.mp4", "init segment restated after it");
  eq(text.includes("#EXT-X-DISCONTINUITY-SEQUENCE"), false, "no discontinuity has scrolled out yet");
  eq(lib.analyzeMedia(text).isAd, false, "no ad markup");

  // Next polls: the loss reaches the front of the window, then scrolls out.
  const atFront = lib.spliceMediaPlaylist(allAdNative, playlist(103, range(103, 112), { tagLive: true }), memory);
  eq(lib.parseMediaPlaylist(atFront.text).mediaSequence, 100, "numbering continues");
  eq(atFront.text.includes("#EXT-X-DISCONTINUITY\n"), true, "discontinuity still on the first segment");
  const scrolled = lib.spliceMediaPlaylist(allAdNative, playlist(104, range(104, 113)), memory);
  eq(lib.parseMediaPlaylist(scrolled.text).mediaSequence, 101, "media sequence");
  eq(scrolled.text.includes("#EXT-X-DISCONTINUITY\n"), false, "no discontinuity in the window");
  eq(scrolled.text.includes("#EXT-X-DISCONTINUITY-SEQUENCE:1"), true, "discontinuity sequence counts it");
  eq(scrolled.stats.lost, 0, "nothing new lost");
});

test("lost numbers stay lost, and every rendition of the session shares them", () => {
  const session = lib.newSpliceSession();
  const memory = lib.newSpliceMemory(session);
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), memory);
  lib.spliceMediaPlaylist(allAdNative, playlist(94, [...range(94, 99), ...ads(3), 103]), memory);
  // Another rendition, whose backup happens to have 100-102.
  const other = lib.spliceMediaPlaylist(allAdNative, playlist(96, range(96, 105)), lib.newSpliceMemory(session));
  eq(segmentUrls(other.text).some((u) => /live-10[012]\.mp4/.test(u)), false, "lost numbers not used");
  eq(other.stats.outWindow, [96, 102], "same numbering as the first rendition");
  // And the first rendition ignores them if a source turns up with them later.
  const later = lib.spliceMediaPlaylist(allAdNative, playlist(97, range(97, 106)), memory);
  eq(later.stats.outWindow, [97, 103], "numbering unchanged");
  eq(later.stats.lost, 0, "nothing new lost");
});

test("an edge that briefly moves back is not mistaken for a loss", () => {
  const memory = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), memory);
  // A stale playlist ending before what the player already has.
  lib.spliceMediaPlaylist(allAdNative, playlist(88, range(88, 97)), memory);
  const { stats } = lib.spliceMediaPlaylist(allAdNative, playlist(92, range(92, 101)), memory);
  eq(stats.lost, 0, "nothing lost");
  eq(memory.session.gaps, [], "no gap");
  eq(stats.window, [92, 101], "window");
});

test("a hole longer than an ad (player paused, tab asleep) jumps ahead instead", () => {
  const memory = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), memory);
  const { text, stats } = lib.spliceMediaPlaylist(allAdNative, playlist(300, range(300, 309)), memory);
  assertCleanContinuous(text);
  eq(stats.lost, 0, "not counted as lost");
  eq(memory.session.gaps, [], "no gap");
  eq(stats.outWindow, [300, 309], "live numbering");
});

test("switching quality and back is not mistaken for a loss", () => {
  // Real case: the player left 1440p60 for 360p30 during an ad Twitch drew
  // itself, and came back ~45s later. Only 360p30 had been polled meanwhile.
  const session = lib.newSpliceSession();
  const high = lib.newSpliceMemory(session);
  const low = lib.newSpliceMemory(session);
  const live = (first, last) => playlist(first, range(first, last));
  lib.spliceMediaPlaylist(live(4431, 4445), null, high, 0);
  for (let i = 1; i <= 23; i++) lib.spliceMediaPlaylist(live(4431 + i, 4445 + i), null, low, i * 2000);
  const back = lib.spliceMediaPlaylist(live(4454, 4468), null, high, 48_000);
  eq(back.stats.lost, 0, "nothing lost");
  eq(session.gaps, [], "no gap");
  eq(back.stats.outWindow, [4454, 4468], "same numbers the low rendition used");
});

test("a hole after the player stopped polling is not a loss", () => {
  const memory = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), memory, 0);
  const { stats } = lib.spliceMediaPlaylist(allAdNative, playlist(104, range(104, 113)), memory, 30_000);
  eq(stats.lost, 0, "not lost");
  eq(memory.session.gaps, [], "no gap");
  // While polling, the same hole is a loss.
  const polling = lib.newSpliceMemory();
  lib.spliceMediaPlaylist(allAdNative, playlist(90, range(90, 99)), polling, 0);
  eq(lib.spliceMediaPlaylist(allAdNative, playlist(104, range(104, 113)), polling, 2_000).stats.lost, 4, "lost");
});

results.join("\n");

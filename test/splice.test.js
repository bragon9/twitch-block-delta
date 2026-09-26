// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const lib = (0, eval)(
  `${read("src/playlist.js")}\n${read("src/splice.js")}\n;({ analyzeMedia, parseMediaPlaylist, spliceMediaPlaylist, newSpliceMemory, stripAdMarkers })`,
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

test("prefetch hints on a clean live playlist are kept", () => {
  const post = lib.parseMediaPlaylist(fixture("post-ad-native"));
  eq(post.prefetchSafe, true, "post-ad live tail is safe");
  const backup = lib.parseMediaPlaylist(fixture("mid-ad-backup"));
  eq(backup.prefetchSafe, true, "clean backup is safe");
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

results.join("\n");

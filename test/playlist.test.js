// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const lib = (0, eval)(
  `${read("src/playlist.js")}\n;({ parseAttributes, parseMaster, analyzeMedia, playlistSignature, redactMaster, pickVariant })`,
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

test("parseAttributes keeps commas inside quoted values", () => {
  eq(lib.parseAttributes('BANDWIDTH=1,CODECS="avc1.4D401F,mp4a.40.2"'), { BANDWIDTH: "1", CODECS: "avc1.4D401F,mp4a.40.2" }, "attrs");
});

test("parseMaster reads the multitrack master", () => {
  const master = lib.parseMaster(read("test/fixtures/multitrack-master.m3u8"));
  eq(master.sessionData["CHANNEL-METADATA"], "multitrack_video,multigroup_video", "channel metadata");
  eq(master.variants.map((v) => v.name), ["360p30", "160p30", "1080p60", "720p60", "480p30", "audio_only"], "variant names");
  eq(master.variants[2].codecs, "avc1.4D401F,mp4a.40.2", "codecs");
  eq(master.variants[2].frameRate, 60, "frame rate");
  eq(master.variants.every((v) => !v.relative), true, "absolute urls");
});

test("live playlist is not an ad", () => {
  const a = lib.analyzeMedia(read("test/fixtures/live-media.m3u8"));
  eq(a.isAd, false, "isAd");
  eq(a.adReasons, [], "reasons");
  eq(a.titles, { live: 15 }, "titles");
  eq(a.streamSources, ["live"], "sources");
  eq(a.unknownTags, [], "unknown tags");
  eq(a.mapCount, 1, "maps");
});

test("synthetic stitched ad is detected by every marker", () => {
  const a = lib.analyzeMedia(read("test/fixtures/synthetic-ad-media.m3u8"));
  eq(a.isAd, true, "isAd");
  eq(a.adReasons.sort(), [
    'daterange class "twitch-stitched-ad"',
    'daterange id "stitched-ad-1790384710-30"',
    'segment title "Amazon|ad-creative"',
    "ad attributes on a daterange",
  ].sort(), "reasons");
  eq(a.adKind, "stitched", "kind");
  eq(a.discontinuities, 1, "discontinuities");
  eq(a.mapCount, 2, "maps");
});

test("real maf-ad marker over live segments is a client ad, not stitched", () => {
  const a = lib.analyzeMedia(read("test/fixtures/maf-client-ad-media.m3u8"));
  eq(a.adKind, "client", "kind");
  eq(a.isAd, true, "isAd");
  eq(a.titles, { live: 14 }, "titles");
  eq(a.discontinuities, 0, "discontinuities");
  eq(a.adDateRanges, [{ id: "maf-ad-1790386317-60000000000", class: "twitch-maf-ad", plannedDuration: 60, primaryPod: "6", fallbackFormats: "5,3,4" }], "ad dateranges");
});

test("real stitched pre-roll is a stitched ad", () => {
  const a = lib.analyzeMedia(read("test/fixtures/stitched-ad-start-media.m3u8"));
  eq(a.adKind, "stitched", "kind");
  eq(a.titles, { "Amazon|591733614983626402": 3 }, "titles");
  eq(a.streamSources, ["Amazon|591733614983626402"], "sources");
  eq(a.discontinuities, 1, "discontinuities");
  eq(a.adDateRanges.map((r) => r.class).sort(), ["twitch-ad-quartile", "twitch-stitched-ad"], "ad dateranges");
});

test("ad-to-live playlist is still stitched while ad segments remain", () => {
  const a = lib.analyzeMedia(read("test/fixtures/stitched-ad-to-live-media.m3u8"));
  eq(a.adKind, "stitched", "kind");
  eq(a.titles.live, 2, "live segments after the ad");
  eq(a.streamSources.sort(), ["Amazon|591733614983626402", "live"], "sources");
  eq(a.discontinuities, 2, "discontinuities");
  eq(a.mapCount, 2, "init segments");
});

test("ad time follows the newest segment, not lingering markers", () => {
  const atEdge = (path) => lib.analyzeMedia(read(`test/fixtures/${path}`)).adAtLiveEdge;
  eq(atEdge("live-media.m3u8"), false, "live");
  eq(atEdge("stitched-ad-start-media.m3u8"), true, "stitched pre-roll");
  eq(atEdge("splice/mid-ad-native.m3u8"), true, "mid stitched ad");
  eq(atEdge("stitched-ad-to-live-media.m3u8"), false, "live again, ad segments still listed");
  eq(atEdge("splice/post-ad-native.m3u8"), false, "live after a pod, ad segments still listed");
  eq(atEdge("maf-client-ad-media.m3u8"), false, "client marker announced before its start");
  eq(atEdge("maf-client-ad-playing-media.m3u8"), true, "inside the client ad's planned span");
  eq(atEdge("maf-client-ad-lingering-media.m3u8"), false, "client marker past its planned span");
  eq(lib.analyzeMedia(read("test/fixtures/maf-client-ad-lingering-media.m3u8")).isAd, true, "lingering marker is still an ad for blocking");
});

test("live playlist has no ad kind", () => {
  eq(lib.analyzeMedia(read("test/fixtures/live-media.m3u8")).adKind, null, "kind");
});

test("signature ignores segment churn but not markup", () => {
  const live = read("test/fixtures/live-media.m3u8");
  const churned = live.replace(/MEDIA-SEQUENCE:\d+/, "MEDIA-SEQUENCE:1").replace(/segment\/REDACTED/, "segment/other");
  const sig = (t) => lib.playlistSignature(lib.analyzeMedia(t));
  eq(sig(churned) === sig(live), true, "same markup");
  eq(sig(read("test/fixtures/synthetic-ad-media.m3u8")) === sig(live), false, "ad markup differs");
});

test("redactMaster hides the viewer IP", () => {
  eq(lib.redactMaster('#EXT-X-SESSION-DATA:DATA-ID="USER-IP",VALUE="1.2.3.4"'), '#EXT-X-SESSION-DATA:DATA-ID="USER-IP",VALUE="redacted"', "redacted");
});

test("pickVariant prefers matching codecs and never falls back to another rendition", () => {
  const variants = [
    { name: "1080p60", stableId: "1080p60", codecs: "hvc1.2.4.L123.B0,mp4a.40.2" },
    { name: "1080p60", stableId: "1080p60", codecs: "avc1.4D401F,mp4a.40.2" },
    { name: "720p60", stableId: "720p60", codecs: "avc1.4D401F,mp4a.40.2" },
  ];
  eq(lib.pickVariant(variants, { name: "1080p60", stableId: "1080p60", codecs: "avc1.4D401F,mp4a.40.2" }), variants[1], "codec match");
  eq(lib.pickVariant(variants, { name: "1080p60", stableId: "1080p60", codecs: "av01" }), variants[0], "id match");
  eq(lib.pickVariant(variants, { name: "1440p60", stableId: "1440p60", codecs: "avc1" }), null, "no fallback");
});

results.join("\n");

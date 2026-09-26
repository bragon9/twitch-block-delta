// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
// capture.js needs remember() from background.js; a minimal copy keeps the test standalone.
const lib = (0, eval)(
  `function remember(map, key, value) { map.delete(key); map.set(key, value); }\n` +
    `${read("src/delta.js")}\n${read("src/capture.js")}\n;({ encodeLines, decodeLines, Capture, expandEntries })`,
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
  if (a !== e) throw new Error(`${label}: expected ${e.slice(0, 200)}, got ${a.slice(0, 200)}`);
}
const fixture = (name) => read(`test/fixtures/${name}.m3u8`);
const SEQUENCE = [
  "splice/mid-ad-native",
  "splice/post-ad-native",
  "splice/ad-starting-native",
  "stitched-ad-start-media",
  "stitched-ad-to-live-media",
  "maf-client-ad-media",
  "live-media",
].map(fixture);

test("round-trips every pair of real playlists exactly", () => {
  for (const prev of SEQUENCE) {
    for (const next of SEQUENCE) {
      const p = prev.split("\n");
      const n = next.split("\n");
      eq(lib.decodeLines(p, lib.encodeLines(p, n)).join("\n"), next, "round trip");
    }
  }
});

test("a sliding live window encodes as copies plus the new lines", () => {
  const prev = fixture("live-media").split("\n");
  const next = [...prev.slice(0, 11), ...prev.slice(14), "#EXT-X-PROGRAM-DATE-TIME:x", "#EXTINF:2.000,live", "https://new/seg.mp4"];
  const ops = lib.encodeLines(prev, next);
  // "#EXTINF:2.000,live" already exists in prev, so only the timestamp and URL are new.
  eq(ops.filter((op) => typeof op === "string"), ["#EXT-X-PROGRAM-DATE-TIME:x", "https://new/seg.mp4"], "only unseen lines are literal");
  eq(lib.decodeLines(prev, ops), next, "round trip");
});

test("a date range whose attributes were reordered is stored as a permutation", () => {
  const prev = fixture("maf-client-ad-media").split("\n");
  const i = prev.findIndex((l) => l.includes("twitch-maf-ad"));
  const [tag, body] = [prev[i].slice(0, 17), prev[i].slice(17)];
  const attrs = body.match(/[A-Z0-9-]+=(?:"[^"]*"|[^,]*)/g);
  const next = [...prev];
  next[i] = tag + [...attrs].reverse().join(",");
  const ops = lib.encodeLines(prev, next);
  eq(ops.some((op) => op && op.p === i), true, "permutation op used");
  eq(ops.some((op) => typeof op === "string" && op.includes("twitch-maf-ad")), false, "no literal copy");
  eq(lib.decodeLines(prev, ops), next, "round trip");
});

test("capture chains store deltas with periodic keyframes and expand exactly", () => {
  const records = [];
  const texts = [];
  for (let n = 0; n < 120; n++) {
    const text = SEQUENCE[n % SEQUENCE.length];
    const record = { id: n + 1, chain: "native:test", text };
    lib.Capture.sizes.set(record.id, 1);
    lib.Capture.encode(record);
    records.push(record);
    texts.push(text);
  }
  eq(records.filter((r) => r.text !== undefined).length, 3, "keyframes at 1, 51, 101");
  eq(lib.expandEntries(records).map((r) => r.text), texts, "expanded texts");
});

test("an entry whose base was evicted is marked, not silently wrong", () => {
  const records = [];
  lib.Capture.chains.clear();
  for (let n = 0; n < 5; n++) {
    const record = { id: 1000 + n, chain: "native:evict", text: SEQUENCE[n] };
    lib.Capture.sizes.set(record.id, 1);
    lib.Capture.encode(record);
    records.push(record);
  }
  const expanded = lib.expandEntries(records.slice(2));
  eq(expanded.map((r) => r.lost ?? "ok"), ["delta base evicted", "delta base evicted", "delta base evicted"], "marked");
});

// Encoded records for the Python decoder cross-check in test/run.sh.
const crossCheck = [];
lib.Capture.chains.clear();
for (let n = 0; n < 60; n++) {
  const record = { id: 5000 + n, chain: "native:cross", text: SEQUENCE[(n * 3) % SEQUENCE.length] };
  lib.Capture.sizes.set(record.id, 1);
  lib.Capture.encode(record);
  crossCheck.push(record);
}
$.NSString.alloc
  .initWithUTF8String(JSON.stringify({ encoded: crossCheck, expected: lib.expandEntries(crossCheck).map((r) => r.text) }))
  .writeToFileAtomicallyEncodingError(`${root}/test/.delta-crosscheck.json`, true, $.NSUTF8StringEncoding, null);

results.join("\n");

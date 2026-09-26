// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const newRing = () => (0, eval)(`${read("src/ring.js")}\n;Ring`);

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

test("keeps entries in order with increasing ids", () => {
  const ring = newRing();
  ring.add({ kind: "a" }, 1000);
  ring.add({ kind: "b" }, 2000);
  eq(ring.snapshot(3000).map((r) => [r.id, r.kind]), [[1, "a"], [2, "b"]], "entries");
});

test("drops entries older than the window", () => {
  const ring = newRing();
  ring.add({ kind: "old" }, 0);
  ring.add({ kind: "new" }, 100_000);
  ring.add({ kind: "newer" }, 130_000);
  eq(ring.snapshot(130_000).map((r) => r.kind), ["new", "newer"], "kept");
});

test("snapshot trims by age even when nothing new was added", () => {
  const ring = newRing();
  ring.add({ kind: "old" }, 0);
  eq(ring.snapshot(500_000), [], "empty");
  eq(ring.bytes, 0, "bytes");
});

test("evicts oldest first past the byte cap but always keeps the newest", () => {
  const ring = newRing();
  ring.maxBytes = 300;
  for (let i = 0; i < 5; i++) ring.add({ kind: "x", text: "y".repeat(100) }, 1000 + i);
  const kept = ring.snapshot(1010);
  if (kept.length < 1 || kept.length >= 5) throw new Error(`kept ${kept.length}`);
  eq(kept.at(-1).id, 5, "newest kept");
  eq(ring.bytes, ring.items.reduce((n, i) => n + i.size, 0), "byte accounting");
});

test("clear empties the ring", () => {
  const ring = newRing();
  ring.add({ kind: "a" }, 1000);
  ring.clear();
  eq([ring.items.length, ring.bytes], [0, 0], "cleared");
});

results.push("");
results.join("\n");

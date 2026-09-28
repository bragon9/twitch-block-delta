// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const Session = (0, eval)(`${read("src/session.js")}\n;Session`);

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

test("counts time between playlists as watched", () => {
  const s = Session.create(0);
  for (let t = 0; t <= 10_000; t += 2_000) Session.beat(s, t, false);
  eq([s.watchedMs, s.adMs], [10_000, 0], "watched, ads");
});

test("skips gaps longer than the idle limit", () => {
  const s = Session.create(0);
  Session.beat(s, 0, false);
  Session.beat(s, 2_000, false);
  Session.beat(s, 60_000, false);
  Session.beat(s, 62_000, false);
  eq(s.watchedMs, 4_000, "watched");
});

test("counts time leading up to an ad playlist as ad time", () => {
  const s = Session.create(0);
  Session.beat(s, 0, false);
  Session.beat(s, 2_000, true);
  Session.beat(s, 4_000, true);
  Session.beat(s, 6_000, false);
  eq([s.watchedMs, s.adMs], [6_000, 4_000], "watched, ads");
});

test("tallies each break once, by its worst outcome", () => {
  const s = Session.create(0);
  Session.adStart(s, "blocked");
  Session.adUpdate(s, "blocked");
  Session.adEnd(s);
  Session.adStart(s, "blocked");
  Session.adUpdate(s, "leaked");
  Session.adUpdate(s, "blocked");
  Session.adEnd(s);
  Session.adStart(s, "shown");
  Session.adEnd(s);
  eq([s.breaks, s.blocked, s.shown, s.leaked], [3, 1, 1, 1], "breaks, blocked, shown, leaked");
});

test("ignores updates outside a break", () => {
  const s = Session.create(0);
  Session.adUpdate(s, "leaked");
  eq([s.breaks, s.leaked], [0, 0], "breaks, leaked");
});

results.push("");
results.join("\n");

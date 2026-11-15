// Run with test/run.sh (macOS JavaScriptCore via osascript; no Node needed).
ObjC.import("Foundation");

const root = $.NSProcessInfo.processInfo.environment.objectForKey("DELTA_ROOT").js;
const read = (path) => $.NSString.stringWithContentsOfFileEncodingError(`${root}/${path}`, $.NSUTF8StringEncoding, null).js;
const lib = (0, eval)(
  `${read("src/playlist.js")}\n${read("src/splice.js")}\n${read("src/blocker.js")}\n;({ planPool, MAX_BACKUPS, BACKUP_OPEN_INTERVAL_MS, BACKUP_STUCK_MS })`,
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

const T0 = 1_000_000;
function pool(count, lastOpenedAt = T0 - lib.BACKUP_OPEN_INTERVAL_MS) {
  return { backups: Array.from({ length: count }, (_, i) => ({ id: i + 1, adSince: null })), lastOpenedAt };
}
const polled = (p, edges) => p.backups.map((backup, i) => ({ backup, error: null, liveAtEdge: edges[i] }));

test("opens another backup when nothing can supply the live edge", () => {
  const p = pool(1);
  eq(lib.planPool(p, polled(p, [false]), false, T0).open, true, "open");
});

test("opens nothing while any source is live at the edge", () => {
  const p = pool(2);
  eq(lib.planPool(p, polled(p, [false, true]), false, T0).open, false, "a backup is live");
  eq(lib.planPool(p, polled(p, [false, false]), true, T0).open, false, "the page's playlist is live");
});

test("opens at most one backup per interval, up to the limit", () => {
  const recent = pool(1, T0 - 1);
  eq(lib.planPool(recent, polled(recent, [false]), false, T0).open, false, "too soon");
  const full = pool(lib.MAX_BACKUPS);
  eq(lib.planPool(full, polled(full, Array(lib.MAX_BACKUPS).fill(false)), false, T0).open, false, "pool full");
});

test("closes a backup that failed, freeing its slot", () => {
  const p = pool(lib.MAX_BACKUPS);
  const results = polled(p, Array(lib.MAX_BACKUPS).fill(false));
  results[0].error = "HTTP 403 for example.net";
  const plan = lib.planPool(p, results, false, T0);
  eq(plan.close.map((c) => [c.backup.id, c.reason]), [[1, "HTTP 403 for example.net"]], "closed");
  eq(plan.open, true, "replaced");
});

test("closes a backup only once it has been in an ad too long", () => {
  const p = pool(1);
  eq(lib.planPool(p, polled(p, [false]), true, T0).close.length, 0, "ad just started");
  eq(p.backups[0].adSince, T0, "ad timer started");
  eq(lib.planPool(p, polled(p, [false]), true, T0 + lib.BACKUP_STUCK_MS).close.length, 0, "at the limit");
  eq(lib.planPool(p, polled(p, [false]), true, T0 + lib.BACKUP_STUCK_MS + 1).close.length, 1, "past it");
});

test("a backup back on live resets its ad timer", () => {
  const p = pool(1);
  lib.planPool(p, polled(p, [false]), true, T0);
  lib.planPool(p, polled(p, [true]), true, T0 + 5_000);
  eq(p.backups[0].adSince, null, "reset");
  eq(lib.planPool(p, polled(p, [false]), true, T0 + lib.BACKUP_STUCK_MS + 10_000).close.length, 0, "timer restarted");
});

results.join("\n");

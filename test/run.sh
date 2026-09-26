#!/bin/sh
# Runs the tests with macOS's built-in JavaScriptCore, plus a Python check that
# tools/expand_export.py decodes exactly what src/delta.js encodes.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for t in "$root"/test/*.test.js; do
  echo "# $(basename "$t")"
  out=$(DELTA_ROOT="$root" osascript -l JavaScript "$t")
  echo "$out"
  if echo "$out" | grep -q '^FAIL'; then status=1; fi
done
echo "# expand_export.py"
if python3 - "$root" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1] + "/tools")
from expand_export import expand_entries
data = json.load(open(sys.argv[1] + "/test/.delta-crosscheck.json"))
texts = [e["text"] for e in expand_entries(data["encoded"])]
assert texts == data["expected"], "python decoding differs from JS"
print("ok   python decoder matches the JS encoder on", len(texts), "entries")
PY
then :; else echo "FAIL python decoder"; status=1; fi
rm -f "$root/test/.delta-crosscheck.json"
exit $status

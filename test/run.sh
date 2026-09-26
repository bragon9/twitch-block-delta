#!/bin/sh
# Runs the tests with macOS's built-in JavaScriptCore.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for t in "$root"/test/*.test.js; do
  echo "# $(basename "$t")"
  out=$(DELTA_ROOT="$root" osascript -l JavaScript "$t")
  echo "$out"
  if echo "$out" | grep -q '^FAIL'; then status=1; fi
done
exit $status

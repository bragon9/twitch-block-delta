#!/usr/bin/env python3
"""Expand a Twitch Block Delta export: restore every entry's full playlist text.

Exports from v0.4.0+ store playlists as lossless line deltas (encoding
"line-delta-v1", see src/delta.js). This writes a copy with `text` filled in and
`delta` removed; older exports pass through unchanged.

    tools/expand_export.py export.json [expanded.json]
"""
import json
import re
import sys

DATERANGE_PREFIX = "#EXT-X-DATERANGE:"
ATTR_RE = re.compile(r'[A-Z0-9-]+=(?:"[^"]*"|[^,]*)')


def date_range_tokens(line):
    if not line.startswith(DATERANGE_PREFIX):
        return None
    body = line[len(DATERANGE_PREFIX):]
    tokens = ATTR_RE.findall(body)
    return tokens if ",".join(tokens) == body else None


def decode_lines(prev, ops):
    out = []
    for op in ops:
        if isinstance(op, str):
            out.append(op)
        elif isinstance(op, list):
            out.extend(prev[op[0]:op[0] + op[1]])
        else:
            tokens = date_range_tokens(prev[op["p"]])
            out.append(DATERANGE_PREFIX + ",".join(tokens[k] for k in op["o"]))
    return out


def expand_entries(entries):
    lines_by_id = {}
    expanded = []
    for entry in entries:
        entry = dict(entry)
        delta = entry.pop("delta", None)
        if delta is not None:
            base = lines_by_id.get(delta["base"])
            if base is None:
                entry.update(text=None, lost="delta base evicted")
            else:
                lines = decode_lines(base, delta["ops"])
                lines_by_id[entry["id"]] = lines
                entry["text"] = "\n".join(lines)
        elif entry.get("chain") and isinstance(entry.get("text"), str):
            lines_by_id[entry["id"]] = entry["text"].split("\n")
        expanded.append(entry)
    return expanded


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    source = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) == 3 else re.sub(r"\.json$", "", source) + ".expanded.json"
    with open(source) as f:
        data = json.load(f)
    data["entries"] = expand_entries(data["entries"])
    data["encoding"] = "expanded"
    with open(target, "w") as f:
        json.dump(data, f)
    lost = sum(1 for e in data["entries"] if e.get("lost"))
    print(f"{target}: {len(data['entries'])} entries, {lost} undecodable (base evicted)")


if __name__ == "__main__":
    main()

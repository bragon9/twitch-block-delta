"use strict";
// Lossless line-level delta encoding for consecutive playlists of one stream.
// A live playlist mostly repeats the previous one shifted by a segment, so it is
// stored as copy runs from the previous text plus new lines. Twitch reorders
// EXT-X-DATERANGE attributes on every fetch, so a date range that only changed
// order is stored as a permutation of the earlier line. decodeLines(prev,
// encodeLines(prev, next)) always returns `next` exactly; tools/expand_export.py
// implements the same decoding for exports.
//
// Ops: [start, count] copies prev[start .. start+count); {p, o} rebuilds
// prev[p]'s date range attributes in order `o`; a string is a literal line.

const DATERANGE_PREFIX = "#EXT-X-DATERANGE:";
const DELTA_ATTR_RE = /[A-Z0-9-]+=(?:"[^"]*"|[^,]*)/g;
const MAX_MATCH_CANDIDATES = 8;

// Attribute tokens of a date range line, or null if the line can't be rebuilt
// exactly from them (then it is stored as a literal).
function dateRangeTokens(line) {
  if (!line.startsWith(DATERANGE_PREFIX)) return null;
  const body = line.slice(DATERANGE_PREFIX.length);
  const tokens = body.match(DELTA_ATTR_RE) || [];
  return tokens.join(",") === body ? tokens : null;
}

function dateRangeId(tokens) {
  return tokens.find((t) => t.startsWith("ID=")) ?? null;
}

function sameTokens(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

function encodeLines(prev, next) {
  const positions = new Map();
  const dateRangesById = new Map();
  prev.forEach((line, j) => {
    if (!positions.has(line)) positions.set(line, []);
    positions.get(line).push(j);
    const tokens = dateRangeTokens(line);
    const id = tokens && dateRangeId(tokens);
    if (id) dateRangesById.set(id, { j, tokens });
  });

  const ops = [];
  let i = 0;
  while (i < next.length) {
    let bestLength = 0;
    let bestStart = -1;
    for (const j of (positions.get(next[i]) || []).slice(0, MAX_MATCH_CANDIDATES)) {
      let k = 0;
      while (i + k < next.length && j + k < prev.length && next[i + k] === prev[j + k]) k++;
      if (k > bestLength) {
        bestLength = k;
        bestStart = j;
      }
    }
    if (bestLength > 0) {
      ops.push([bestStart, bestLength]);
      i += bestLength;
      continue;
    }
    const tokens = dateRangeTokens(next[i]);
    const earlier = tokens && dateRangesById.get(dateRangeId(tokens));
    if (earlier && sameTokens(earlier.tokens, tokens)) {
      ops.push({ p: earlier.j, o: tokens.map((t) => earlier.tokens.indexOf(t)) });
    } else {
      ops.push(next[i]);
    }
    i++;
  }
  return ops;
}

function decodeLines(prev, ops) {
  const out = [];
  for (const op of ops) {
    if (typeof op === "string") out.push(op);
    else if (Array.isArray(op)) out.push(...prev.slice(op[0], op[0] + op[1]));
    else {
      const tokens = dateRangeTokens(prev[op.p]);
      out.push(DATERANGE_PREFIX + op.o.map((k) => tokens[k]).join(","));
    }
  }
  return out;
}

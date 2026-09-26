"use strict";
// Persistent capture log. Each entry is its own storage key ("e:<id>") so adding
// one doesn't rewrite everything captured so far.
//
// Entries with a `chain` (one per stream and role, e.g. "native:<url>") store
// their `text` as a lossless delta (delta.js) against the previous entry of the
// same chain, with a full keyframe every KEYFRAME_INTERVAL entries. Storage is
// capped by size, oldest first. An entry whose base was evicted can no longer be
// decoded; that only affects the few oldest entries of a chain.

const MAX_BYTES = 150 * 1024 * 1024;
const KEYFRAME_INTERVAL = 50;
const MAX_CHAINS = 500;
const ENTRY_PREFIX = "e:";
const EXPORT_ENCODING = "line-delta-v1";

const Capture = {
  ids: [],
  sizes: new Map(),
  totalBytes: 0,
  nextId: 1,
  // chain -> { id, lines, count } of the chain's newest stored entry.
  chains: new Map(),
  ready: null,

  load() {
    this.ready ??= browser.storage.local.get(null).then((all) => {
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(ENTRY_PREFIX)) continue;
        const id = Number(key.slice(ENTRY_PREFIX.length));
        this.ids.push(id);
        this.sizes.set(id, JSON.stringify(value).length);
      }
      this.ids.sort((a, b) => a - b);
      this.totalBytes = [...this.sizes.values()].reduce((a, b) => a + b, 0);
      this.nextId = Math.max(all.nextId || 1, (this.ids.at(-1) || 0) + 1);
    });
    return this.ready;
  },

  // Turns record.text into record.delta when the chain has a stored base.
  encode(record) {
    const { chain, text } = record;
    if (!chain || typeof text !== "string") return;
    const lines = text.split("\n");
    const state = this.chains.get(chain);
    if (state && state.count < KEYFRAME_INTERVAL && this.sizes.has(state.id)) {
      record.delta = { base: state.id, ops: encodeLines(state.lines, lines) };
      delete record.text;
      state.id = record.id;
      state.lines = lines;
      state.count++;
    } else {
      remember(this.chains, chain, { id: record.id, lines, count: 1 });
      if (this.chains.size > MAX_CHAINS) this.chains.delete(this.chains.keys().next().value);
    }
  },

  async add(entry) {
    await this.load();
    const id = this.nextId++;
    const record = { id, at: new Date().toISOString(), ...entry };
    this.encode(record);
    const size = JSON.stringify(record).length;
    this.ids.push(id);
    this.sizes.set(id, size);
    this.totalBytes += size;
    const evicted = [];
    while (this.totalBytes > MAX_BYTES && this.ids.length > 1) {
      const old = this.ids.shift();
      this.totalBytes -= this.sizes.get(old) || 0;
      this.sizes.delete(old);
      evicted.push(old);
    }
    await browser.storage.local.set({ [ENTRY_PREFIX + id]: record, nextId: this.nextId });
    if (evicted.length > 0) await browser.storage.local.remove(evicted.map((i) => ENTRY_PREFIX + i));
    return record;
  },

  // Stored form, for export. tools/expand_export.py restores the full texts.
  async all() {
    await this.load();
    const all = await browser.storage.local.get(this.ids.map((i) => ENTRY_PREFIX + i));
    return this.ids.map((i) => all[ENTRY_PREFIX + i]).filter(Boolean);
  },

  async stats() {
    await this.load();
    return { count: this.ids.length, bytes: this.totalBytes, maxBytes: MAX_BYTES };
  },

  async count() {
    await this.load();
    return this.ids.length;
  },

  async clear() {
    await this.load();
    await browser.storage.local.remove(this.ids.map((i) => ENTRY_PREFIX + i));
    this.ids = [];
    this.sizes.clear();
    this.totalBytes = 0;
    this.chains.clear();
  },
};

// Restores full `text` on every entry of an exported list (the inverse of
// Capture.encode), marking entries whose base was evicted.
function expandEntries(entries) {
  const linesById = new Map();
  return entries.map((entry) => {
    if (entry.delta) {
      const base = linesById.get(entry.delta.base);
      const { delta, ...rest } = entry;
      if (!base) return { ...rest, text: null, lost: "delta base evicted" };
      const lines = decodeLines(base, delta.ops);
      linesById.set(entry.id, lines);
      return { ...rest, text: lines.join("\n") };
    }
    if (entry.chain && typeof entry.text === "string") linesById.set(entry.id, entry.text.split("\n"));
    return entry;
  });
}

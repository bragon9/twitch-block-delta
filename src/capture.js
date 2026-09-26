"use strict";
// Persistent capture log. Each entry is its own storage key ("e:<id>") so adding
// one during an ad break doesn't rewrite everything captured so far.

const MAX_ENTRIES = 2000;
const ENTRY_PREFIX = "e:";

const Capture = {
  ids: [],
  nextId: 1,
  ready: null,

  load() {
    this.ready ??= browser.storage.local.get(null).then((all) => {
      this.ids = Object.keys(all)
        .filter((k) => k.startsWith(ENTRY_PREFIX))
        .map((k) => Number(k.slice(ENTRY_PREFIX.length)))
        .sort((a, b) => a - b);
      this.nextId = Math.max(all.nextId || 1, (this.ids.at(-1) || 0) + 1);
    });
    return this.ready;
  },

  async add(entry) {
    await this.load();
    const id = this.nextId++;
    const record = { id, at: new Date().toISOString(), ...entry };
    this.ids.push(id);
    const evicted = this.ids.length > MAX_ENTRIES ? this.ids.splice(0, this.ids.length - MAX_ENTRIES) : [];
    await browser.storage.local.set({ [ENTRY_PREFIX + id]: record, nextId: this.nextId });
    if (evicted.length > 0) await browser.storage.local.remove(evicted.map((i) => ENTRY_PREFIX + i));
    return record;
  },

  async all() {
    await this.load();
    const all = await browser.storage.local.get(this.ids.map((i) => ENTRY_PREFIX + i));
    return this.ids.map((i) => all[ENTRY_PREFIX + i]).filter(Boolean);
  },

  async count() {
    await this.load();
    return this.ids.length;
  },

  async clear() {
    await this.load();
    await browser.storage.local.remove(this.ids.map((i) => ENTRY_PREFIX + i));
    this.ids = [];
  },
};

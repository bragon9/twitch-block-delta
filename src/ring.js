"use strict";
// In-memory window of the most recent captures, used by "problems only" logging.
// Nothing here touches storage; background.js writes a snapshot to a file when
// something goes wrong. Entries have the same shape as Capture's, but keep their
// full text (no delta encoding), so a dump needs no expanding.

const Ring = {
  // Long enough to hold ~90s before a problem plus the seconds captured after it.
  windowMs: 120_000,
  maxBytes: 30 * 1024 * 1024,
  items: [],
  bytes: 0,
  nextId: 1,

  add(entry, now = Date.now()) {
    const record = { id: this.nextId++, at: new Date(now).toISOString(), ...entry };
    const size = JSON.stringify(record).length;
    this.items.push({ record, size, t: now });
    this.bytes += size;
    this.trim(now);
    return record;
  },

  trim(now = Date.now()) {
    while (
      this.items.length > 0 &&
      (now - this.items[0].t > this.windowMs || (this.bytes > this.maxBytes && this.items.length > 1))
    ) {
      this.bytes -= this.items.shift().size;
    }
  },

  snapshot(now = Date.now()) {
    this.trim(now);
    return this.items.map((item) => item.record);
  },

  clear() {
    this.items = [];
    this.bytes = 0;
  },
};

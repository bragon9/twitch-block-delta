"use strict";
// What the popup reports for the stream in a tab: time watched, how much of it
// was ads, and what happened to each ad break. Lives in memory only; a page load
// or channel change starts a new session.

const Session = {
  // A gap longer than this between playlists means the player was paused or the
  // tab was asleep; that time doesn't count as watched.
  idleMs: 15_000,
  // Worst outcome wins when a break is judged more than once.
  verdicts: ["blocked", "shown", "leaked"],

  create(now) {
    return { startedAt: now, watchedMs: 0, adMs: 0, lastBeatAt: null, breaks: 0, blocked: 0, shown: 0, leaked: 0, current: null };
  },

  // A playlist from the page's player arrived. `isAd`: Twitch was serving an ad
  // at its newest segment, so the time since the previous one counts as ad time.
  beat(s, now, isAd) {
    if (s.lastBeatAt !== null) {
      const gap = now - s.lastBeatAt;
      if (gap > 0 && gap <= this.idleMs) {
        s.watchedMs += gap;
        if (isAd) s.adMs += gap;
      }
    }
    s.lastBeatAt = now;
  },

  // `verdict`: "blocked" (the viewer saw no ad), "shown" (let through on purpose:
  // Observe only or an allowed channel), or "leaked" (the ad got to the player).
  adStart(s, verdict) {
    s.breaks++;
    s[verdict]++;
    s.current = verdict;
  },

  adUpdate(s, verdict) {
    if (!s.current || this.verdicts.indexOf(verdict) <= this.verdicts.indexOf(s.current)) return;
    s[s.current]--;
    s[verdict]++;
    s.current = verdict;
  },

  adEnd(s) {
    s.current = null;
  },
};

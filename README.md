# Twitch Block Delta

A Firefox-only Twitch ad blocker, built from scratch. It removes ads by
rewriting Twitch's playlists before the player sees them, so it never has to
pause, reload or resume the player. That is what caused the background-tab
stalls in TTV AB.

## How it works

Twitch's player downloads a media playlist every ~2s. Each live segment has a
**global live sequence number**. The number, timing and bytes of a live segment
are identical in every playback session (verified by hashing header and media
segments from two sessions).

- **Stitched ads** (pre-rolls and mid-rolls in the video stream). The extension
  fetches the same rendition, matched by variant ID and codec, from a logged-in
  `embed` session, which has been ad-free in every ad captured so far. It
  replaces the ad segments with the same-numbered live segments from that
  session and renumbers everything by live sequence. The player sees one
  continuous live stream, including 1440p HEVC.
- **Client ad markers** (`twitch-maf-ad`: the live video continues and Twitch's
  page is told to draw an ad). The marker is removed.
- If no clean backup is available, ad segments are dropped and the player waits
  at the live edge. The ad is only shown when there is nothing live at all to
  serve (e.g. a pre-roll with no backup).

`src/splice.js` is the pure splicing logic, tested against real playlists.
`src/blocker.js` fetches the backup session. `src/background.js` wires it into
`webRequest.filterResponseData` and records everything.

## Load it (Zen / Firefox)

1. Disable other Twitch ad blockers (TTV AB, TTV LOL PRO).
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `manifest.json`. After code changes, click **Reload** on its card,
   then **refresh any open Twitch tabs**. The extension only knows a stream
   from its master playlist, which a running player has already fetched.
3. The popup header shows the version. Check it after reloading.
4. **Inspect** on the card opens the console; lines are prefixed `[delta]`.

Temporary add-ons are removed when the browser quits. Export before restarting.

## Install a signed build

Download the `.xpi` from the latest
[release](https://github.com/bragon9/twitch-block-delta/releases/latest) and
drag it into Firefox. It is signed by Mozilla as unlisted (not on
addons.mozilla.org) and updates itself from this repo's releases.

To release: bump `version` in `manifest.json` in a PR and merge it. The Release
workflow signs that version and publishes it; merges that don't change the
version release nothing.

## Modes

- **Block** (default): rewrites playlists. During an ad the badge is green when
  the ad is being replaced cleanly, red when it isn't.
- **Observe only**: passes everything through unchanged and probes other player
  types during ads. Use it to capture raw ad data.

## Logging

Set in the popup:

- **Problems only** (default): the last ~2 minutes of captures are kept in
  memory only. If something goes wrong, they are saved with the ~15s after it to
  `Downloads/twitch-block-delta/problem-<time>.json`, with no prompt. Problems
  are: a rewrite that threw or returned an error (backup fetch failed, backup
  also had ads), an ad the player was left to see, a rewrite that left nothing
  live to play, a rewrite slower than 2s, and a non-playlist response. Files are
  limited to one per minute and 25 per browser session. **Save recent** writes
  the buffer on demand. These files hold full playlist text, so they need no
  expanding.
- **Always**: every capture is stored in extension storage (see below) and
  exported by hand.
- **Off**: nothing is recorded and the `[delta]` console lines stop.

The setting only affects recording; blocking is the same in every setting.

## What to collect

Export from the popup (**Export captures**) after any of these, and note the
time, the channel and what you saw:

- An ad you could see or hear, even partly.
- A freeze, spinner, black screen, audio drop, or the stream jumping back or
  skipping ahead, especially right when an ad would start or end.
- A quality drop or the quality selector acting oddly.
- A red **AD** badge.
- A stream left in a **background tab** through an ad: did it keep playing
  when you came back?

Every export also includes a timing log of each media playlist request (start,
first byte, body done, forwarded to the player, status, abort/errors, action).
It lives in memory (last 20,000 requests, roughly 10 hours of one stream), so it
only covers the time since the extension was last loaded.

Captures are capped at 150 MB (shown in the popup), oldest first. Playlists are
stored as lossless deltas against the previous playlist of the same stream,
about 12x smaller than full text, so a day of watching fits. Exports keep that
compact form. Expand one to full playlist text with:

```sh
tools/expand_export.py twitch-block-delta-….json   # writes ….expanded.json
```

Each splice also records the backup playlist it used, so any rewrite can be
replayed offline.

Clean ad breaks are useful too, especially pre-rolls (open a new channel) and
long mid-roll pods. Every rewrite during an ad is recorded with where each
segment came from.

Exports contain short-lived signed URLs and your Twitch user ID inside ad
tokens. Don't post them publicly.

## Tests

```sh
test/run.sh
```

This runs the tests with macOS's JavaScriptCore via `osascript` (no Node
needed). Fixtures are real playlists with URLs, session IDs and ad-tracking
fields redacted. `synthetic-ad-media.m3u8` is hand-written and kept only as a
marker-coverage test.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

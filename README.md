# Twitch Block Delta

A Firefox-only Twitch ad blocker. It removes ads by rewriting Twitch's playlists
before the player sees them, so the player is never paused, reloaded or resumed,
and streams in background tabs behave exactly like visible ones.

## Install

Download the `.xpi` from the
[latest release](https://github.com/bragon9/twitch-block-delta/releases/latest)
and drag it into Firefox (or Zen). It is signed by Mozilla for
self-distribution, not listed on addons.mozilla.org, and updates itself from this
repo's releases. To check for an update right away: `about:addons` → gear →
**Check for Updates**.

Disable other Twitch ad blockers (TTV AB, TTV LOL PRO) first. Refresh any open
Twitch tabs after installing: the extension only knows a stream from its master
playlist, which a running player has already fetched.

## Using it

The popup shows whether ads are being blocked and, for each Twitch tab, the
channel, its state (live, ad replaced, ad showing, idle), the quality and the ad
breaks seen. Everything else is under **Details & logging**: the mode, logging,
and each tab's rewrite details.

### Modes

- **Block** (default): rewrites playlists. During an ad the badge is green when
  the ad is being replaced cleanly, red when it isn't.
- **Observe only**: passes everything through unchanged and probes other player
  types during ads. Use it to capture raw ad data.

### Logging

- **Off** (default): nothing is recorded and the `[delta]` console lines stop.
- **Problems only**: the last ~2 minutes of captures are kept in
  memory only. If something goes wrong, they are saved with the ~15s after it to
  `Downloads/twitch-block-delta/problem-<time>.json`, with no prompt. Problems
  are:
  - a rewrite that threw or returned an error (backup fetch failed, backup also
    had ads);
  - an ad the player was left to see;
  - a rewrite that left nothing live to play;
  - a rewrite slower than 2s;
  - a response that isn't a playlist (other than the 404 once a stream ends).

  Files are limited to one per minute and 25 per browser session. **Save
  recent** writes the buffer on demand.
- **Always**: every capture is stored in extension storage, up to 150 MB, oldest
  first. **Export captures** saves them; **Clear** deletes them.

Logging only affects recording; blocking is the same in every setting.

## Reporting a problem

Open **Details & logging** and set logging to **Problems only** first; problem
files are then written automatically. For anything the extension didn't
notice, click **Save recent** within about two minutes, and note the time, the
channel and what you saw. Worth reporting:

- An ad you could see or hear, even partly.
- A freeze, spinner, black screen, audio drop, or the stream jumping back or
  skipping ahead, especially right when an ad would start or end.
- A quality drop or the quality selector acting oddly.
- A red **AD** badge.
- A stream in a background tab that didn't keep playing through an ad.

For longer investigations, switch logging to **Always** and use **Export
captures**. Every file also includes a timing log of each media playlist request
(start, first byte, body done, forwarded to the player, status, errors, action),
kept in memory for the last 20,000 requests while logging is on.

Problem files hold full playlist text. **Always** exports store playlists as
lossless deltas against the previous playlist of the same stream (about 12x
smaller); expand one with:

```sh
tools/expand_export.py twitch-block-delta-….json   # writes ….expanded.json
```

Each splice also records the backup playlist it used, so any rewrite can be
replayed offline.

Captured files contain short-lived signed URLs and your Twitch user ID inside ad
tokens. Don't post them publicly.

## Privacy

The extension sends nothing anywhere except Twitch. To fetch an ad-free backup
playlist it reads your Twitch login cookie and uses it only with Twitch's own
API (`gql.twitch.tv`). Logs stay on your computer, in extension storage or your
Downloads folder.

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

| File | Role |
| --- | --- |
| `src/splice.js` | Pure splicing logic, tested against real playlists |
| `src/blocker.js` | Fetches the backup session and rewrites media playlists |
| `src/background.js` | Wires it into `webRequest.filterResponseData`; logging |
| `src/playlist.js` | Playlist parsing and ad detection |
| `src/probe.js` | Twitch API calls; ad-break probes in Observe mode |
| `src/capture.js`, `src/delta.js` | Persistent capture storage (Always) |
| `src/ring.js` | In-memory buffer (Problems only) |

## Development

### Load from source

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `manifest.json`. It has the same ID as the signed build, so disable or
   remove that one first. Temporary add-ons are removed when the browser quits.
2. After code changes, click **Reload** on its card, then refresh any open
   Twitch tabs. The popup header shows the version.
3. **Inspect** on the card opens the console; lines are prefixed `[delta]`.

### Tests

```sh
test/run.sh
```

Runs the tests with macOS's JavaScriptCore via `osascript` (no Node needed).
Fixtures are real playlists with URLs, session IDs and ad-tracking fields
redacted. `synthetic-ad-media.m3u8` is hand-written and kept only as a
marker-coverage test.

CI runs the tests and `web-ext lint` on every pull request; `main` only accepts
changes through a pull request with passing checks.

### Releasing

Bump `version` in `manifest.json` in a pull request and merge it. The Release
workflow then signs that version with Mozilla as unlisted and publishes a GitHub
Release with the `.xpi` and an `updates.json`, which installed copies check
through the manifest's `update_url`. Merges that don't change the version
release nothing.

Mozilla accepts each version number once. If a run fails before signing, re-run
it from **Actions → Release → Run workflow**; if it fails after, bump the version
again.

The workflow needs the repository secrets `AMO_API_KEY` and `AMO_API_SECRET`
(from https://addons.mozilla.org/developers/addon/api/key/).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

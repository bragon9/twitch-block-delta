# Twitch Block Delta

A Firefox-only Twitch ad blocker. It removes ads by rewriting Twitch's playlists
before the player sees them, so the player is never paused, reloaded or resumed,
and streams in background tabs behave exactly like visible ones.

## Install

Install it from [addons.mozilla.org](https://addons.mozilla.org/firefox/search/?q=Twitch%20Block%20Delta)
in Firefox (or Zen); Firefox keeps it up to date. Each
[GitHub release](https://github.com/bragon9/twitch-block-delta/releases/latest)
also carries the same signed `.xpi` once Mozilla has approved it. Copies
installed from a release before 0.6.0 move to the addons.mozilla.org version on
their next update check (`about:addons` → gear → **Check for Updates** to do it
now).

Disable other Twitch ad blockers (TTV AB, TTV LOL PRO) first. Refresh any open
Twitch tabs after installing: the extension only knows a stream from its master
playlist, which a running player has already fetched.

## Using it

The popup is about the tab you open it from. It shows the channel, what's
happening right now (blocking ads, ad blocked, ad showing, paused), and this
session's numbers: how long you've watched, how much of that was ads, and what
happened to each ad break. A session starts over when the page reloads, the tab
switches channels, or the tab closes; nothing is saved. If an ad got through,
**Report a problem** opens a pre-filled GitHub issue for you to review.

**Troubleshooting** at the bottom shows this tab's rewrite details.

The gear opens **Settings** (also in `about:addons`), which holds the allowed
channels, the blocking mode and logging.

### Allowed channels

**Don't block ads on this channel** in the popup lets ads play normally on that
channel, for example to support the streamer. The page reloads to apply it,
since blocking is decided when a stream loads. Settings lists every allowed
channel, where you can remove them or add more. The list syncs through your
Firefox account.

### Modes

- **Block** (default): rewrites playlists. During an ad the badge is green when
  the ad is kept from the player, red when it isn't, and grey on an allowed
  channel.
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
  - a response that isn't a playlist (other than the 404 once a stream ends);
  - a playlist the player waited more than 10s for (the stream froze).

  Files are limited to one per minute and 25 per browser session. **Save
  recent** writes the buffer on demand.
- **Always**: every capture is stored in extension storage, up to 150 MB, oldest
  first. **Export captures** saves them; **Clear** deletes them.

Logging only affects recording; blocking is the same in every setting.

## Reporting a problem

In **Settings**, set logging to **Problems only** first; problem
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
Downloads folder. The allowed-channel list is stored with Firefox's own settings
sync, if you use it. **Report a problem** only opens a GitHub page for you to
review; nothing is sent unless you submit it.

## How it works

Twitch's player downloads a media playlist every ~2s. Each live segment has a
**global live sequence number**. The number, timing and bytes of a live segment
are identical in every playback session (verified by hashing header and media
segments from two sessions).

- **Stitched ads** (pre-rolls and mid-rolls in the video stream). The extension
  fetches the same rendition, matched by variant ID and codec, from a logged-in
  `embed` session, which was ad-free in every ad captured at first. It
  replaces the ad segments with the same-numbered live segments from that
  session and renumbers everything by live sequence. The player sees one
  continuous live stream, including 1440p HEVC. If the backup carries ads too
  (Twitch has done this to `embed`), the other player types (`popout`, `site`,
  `autoplay`, `picture-by-picture`) are tried and the first ad-free one is used
  for the rest of the channel's session. If none has the page's rendition
  ad-free, a lower rendition of the same codec family fills in for the break
  (a discontinuity marks each switch), and the full-quality search repeats every
  10s so playback goes back up as soon as it can.
- **Client ad markers** (`twitch-maf-ad`: the live video continues and Twitch's
  page is told to draw an ad). The marker is removed.
- If no clean backup is available, ad segments are dropped and the player waits
  at the live edge, repeating the last playlist rather than showing the ad. The
  ad is only shown when there is nothing to repeat either (e.g. a pre-roll with
  no backup).

| File | Role |
| --- | --- |
| `src/splice.js` | Pure splicing logic, tested against real playlists |
| `src/blocker.js` | Fetches the backup session and rewrites media playlists |
| `src/background.js` | Wires it into `webRequest.filterResponseData`; logging |
| `src/session.js` | Per-tab session stats shown in the popup |
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
workflow then submits that version to addons.mozilla.org as a listed version,
with the listing text from `amo/metadata.json`, and publishes a GitHub Release.
Merges that don't change the version release nothing.

Mozilla reviews each listed version before it can be downloaded. The **Attach
AMO build** workflow checks hourly; once the version is approved it attaches the
signed `.xpi` and an `updates.json` to the GitHub Release. That `updates.json`
is what moves copies installed before 0.6.0 (which checked this repo's releases
for updates) onto the addons.mozilla.org version.

Mozilla accepts each version number once. If a run fails before submitting,
re-run it from **Actions → Release → Run workflow**; if it fails after, bump the
version again.

The workflow needs the repository secrets `AMO_API_KEY` and `AMO_API_SECRET`
(from https://addons.mozilla.org/developers/addon/api/key/).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

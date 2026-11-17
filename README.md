# viperr-clips

The data and server side of [Viperr Music](https://github.com/awkward7777/discography-android), an Android app for the Viperr discography.

Most files here are produced and refreshed by GitHub Actions workflows. The app reads the JSON files straight from the `main` branch, so what is committed here is what users see.

## What is in this repository

| Path | What it is |
| --- | --- |
| `new.json`, `seen.json`, `artists.json`, `bios.json`, `bios_i18n.json` | New releases, the ids already seen, artists and biographies |
| `slugs.json`, `site_playlists.json` | Artist-name to catalog-site slug map, and the playlists shown on the site |
| `bpm.json`, `popular.json`, `quality.json`, `mood.json`, `genres.json`, `genres_override.json` | Track facts: BPM, popularity, quality variants, mood, genres |
| `lyrics_map.json` | Lyrics corrections the app applies: pick a specific LRCLIB id, a local file, or `{"none": true}` for no lyrics |
| `lyrics_audit.json`, `lyrics_fill.json`, `lyrics_report.json`, `lyrics_unreleased.json` | Output of the lyrics workflows |
| `clipcrop.json` | Detected black bars of music-video files |
| `compat.json` | Address of the Cloudflare Worker (written by the deploy workflow) |
| `covers/`, `photos/`, `moodcovers/` | Cover art and artist photos |
| `*.py` | The scripts the workflows run |
| `server/` | The Cloudflare Worker (see below) |
| `*.log`, `probe.txt`, `*_probe.*`, `genre_raw.json` | Debug output that workflows commit on purpose, so results can be read without access to the runner |

Music-video files are attached to this repository's `clips` release; they are not stored in git.

## Workflows

They run on a schedule or by hand; only the Compat server workflow also runs when `server/` changes. None runs on pull requests.

| Workflow | Runs |
| --- | --- |
| Sync releases | every 3 hours |
| Quality variants | every 6 hours |
| Popular tracks | daily |
| BPM | weekly |
| Compat server | on changes under `server/`, or by hand |
| Lyrics audit / fill / report / unreleased, Mood, genres probe, Genius probe, Detect clip black bars | by hand |

## Server (`server/`)

A small Cloudflare Worker with Workers KV and an optional D1 database.

- **Always on**: taste-compatibility codes (`POST /c`, `GET /c/<code>`, kept 24 hours) and device-to-device transfer (`POST /t`, `GET /t/<code>`, kept 10 minutes, read once).
- **Community** (needs the D1 database and a Telegram bot token, otherwise answers `off`): accounts, suggestions for Story pages and moderation through a Telegram bot. Passwords never reach the server, only a key the phone derives from them.

The **Compat server** workflow runs the tests in `server/test`, deploys the Worker and finishes with a smoke test. Run the tests yourself with `cd server && node --test test/community.test.mjs`.

## Secrets used by the workflows

Names only; values live in the repository's Actions secrets and are never committed.

| Secret | Used for |
| --- | --- |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Deploying the Worker. Give the token only the permissions it needs (Workers Scripts, Workers KV Storage and D1, all Edit, on this account) |
| `TG_BOT_TOKEN`, `ADMIN_TG_ID` | Telegram moderation bot |
| `SPOTIFY_ID`, `SPOTIFY_SECRET`, `GENIUS_TOKEN` | Metadata lookups in the sync and popularity workflows |
| `YT_COOKIES` | YouTube downloads. Use a throwaway Google account for this, never a personal one |

## Rights

Cover art, artist photos and music-video files belong to their respective rights holders and are included only so the app can show the catalog. If you are a rights holder and want something removed, open an issue and it will be handled.

## Security

See [SECURITY.md](SECURITY.md).

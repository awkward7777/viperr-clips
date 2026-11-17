# Security policy

## Reporting a vulnerability

Report problems privately through the **Security** tab of this repository (**Report a vulnerability**). Please do not post details in a public issue.

In scope: the Cloudflare Worker in `server/`, the GitHub Actions workflows, and anything in this repository that could leak a secret or let someone change what the app downloads. Problems in the Android app itself go to the app repository's policy: <https://github.com/awkward7777/discography-android/security/policy>.

## What the server stores

- **Compatibility code**: a nickname you choose and a list of top-track ids, for 24 hours.
- **Device transfer**: the backup you send, for 10 minutes, deleted on first read.
- **Community accounts** (only when enabled): a nickname, a keyed hash of a password-derived key, hashed session tokens, and the suggestions you submit. The password never leaves the phone.
- **Abuse limits**: request counters per IP address with a short expiry, for rate limiting only.

The Worker sends no CORS headers, so browsers on other sites cannot call it.

## How secrets are handled

- Secrets live only in GitHub Actions secrets. `cookies.txt`, `.env`, `.dev.vars` and key files are git-ignored.
- No workflow uses `pull_request_target`, and none runs on pull requests, so code from a fork never sees a secret.
- Workflows commit only the files they name; they do not run `git add -A` on the repository root.
- The Telegram webhook accepts a request only if its secret header matches, and only listed admin IDs can act.

## Known trade-offs

- The sync workflow installs the newest `yt-dlp`, `ytmusicapi` and a YouTube proof-of-origin helper at run time, because YouTube changes often and old versions stop working. That code runs on the runner while `YT_COOKIES` is present. Use a throwaway Google account for those cookies and rotate them if anything looks off.
- The app trusts the JSON files on `main`. Protect the GitHub account that owns this repository with two-factor authentication, and add branch protection if more people get write access.

## If a secret leaks

Replace it first, then clean up: roll the Cloudflare token in the dashboard, `/revoke` the Telegram bot token in BotFather, regenerate Spotify and Genius keys, sign out of the Google account used for cookies and export fresh ones. Then update the matching Actions secret.

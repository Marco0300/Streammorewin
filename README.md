# Streammore Windows desktop app

This is the standalone Windows Streammore app repository:

```text
https://github.com/Marco0300/Streammorewin
```

It is a native Electron desktop shell around the existing Streammore web
client. It is not an Android emulator and it does not require a browser. The
renderer uses the same authenticated Streammore UI, API, HLS player, subtitles,
progress tracking, Live TV, My List, ratings, downloads, and update-compatible
backend as the web client.

Version 1.0.1 also explicitly bridges the browser HTML Fullscreen API to the
native Windows window, so the player fullscreen button changes the real app
window rather than only changing the page layout.

The packaged app checks GitHub Releases shortly after startup and every six
hours while it is running. When a newer release is found it asks before
downloading, then asks again before restarting to install it. A manual
`Streammore → Check for updates` menu item is also available.

The default service is:

```text
https://streammore.mmcloud.co.za
```

For local LAN testing, launch with:

```powershell
$env:STREAMMORE_DESKTOP_URL = "http://192.168.3.91:3896"
npm start
```

Or pass `--streammore-url=https://...` on the command line.

## Build locally

```bash
npm ci
npm run check
npm start
```

Windows installers and a portable executable are built on a Windows runner:

```powershell
npm run dist:win
```

Outputs are written to `dist/` when built on Windows:

- `Streammore-Setup-<version>-x64.exe`
- `Streammore-Portable-<version>-x64.exe`

## Publishing an update

1. Change `version` in `package.json` (the lockfile must use the same version).
2. Commit the change and create a matching tag, for example `v1.0.2`.
3. Push the commit and tag to GitHub.

The Windows workflow builds both executables, verifies that they are complete,
and publishes the release assets plus Electron's `latest.yml` metadata. The
desktop updater reads that GitHub release metadata automatically.

The Electron shell keeps cookies in the normal persistent Electron session, keeps Node integration disabled, denies renderer permission prompts, prevents the app from navigating away from the Streammore origin, and opens external links in the system browser.

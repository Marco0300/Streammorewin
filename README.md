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

Version 1.0.2 also explicitly bridges the browser HTML Fullscreen API to the
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

## Code signing

The current release workflow publishes unsigned Windows builds. Windows may
show a SmartScreen or unknown-publisher warning when installing them.

For a future trusted release, the workflow can sign tagged builds with a
SHA-256 code-signing certificate. Keep the `.pfx` file and password out of Git.
Add these GitHub repository Actions secrets before enabling signing:

- `WINDOWS_CODE_SIGNING_CERTIFICATE_BASE64` — base64 contents of the `.pfx`
- `WINDOWS_CODE_SIGNING_CERTIFICATE_PASSWORD` — the `.pfx` password

PowerShell example for encoding the certificate locally:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("Streammore-CodeSigning.pfx")) | Set-Clipboard
```

The existing `v1.0.1` release was created before signing and bundled VLC were
enabled. The `v1.0.2` release is intentionally unsigned.

The Electron shell keeps cookies in the normal persistent Electron session, keeps Node integration disabled, denies renderer permission prompts, prevents the app from navigating away from the Streammore origin, and opens external links in the system browser.

## Native MKV playback

The Windows release bundles VLC 3.0.x/libVLC and the `electron-vlc-player`
native bridge. Use **Streammore → Open MKV file…** or press `Ctrl+O` to open a
local `.mkv`/`.mka` file. VLC handles Matroska video, audio tracks, subtitles,
seeking, and fullscreen independently of Chromium's HTML5 limitations.

The VLC runtime is downloaded by the Windows build workflow and is not checked
into Git. The distributed VLC license and plugin files are included in the
bundled runtime directory.

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

The app explicitly bridges the browser HTML Fullscreen API to the native Windows
window, so the player fullscreen button changes the real app window rather than
only changing the page layout.

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

## Native MKV playback

The Windows release bundles the VLC 3.0.21 runtime (`libvlc.dll`,
`libvlccore.dll`, and the full `plugins/` directory) plus the
`electron-vlc-player` native bridge. Use **Streammore → Open MKV file…** or
press `Ctrl+O` to open a local `.mkv`/`.mka` file. VLC handles Matroska video,
audio tracks, subtitle tracks, seeking, and fullscreen independently of
Chromium's HTML5 limitations, which do not include Matroska support.

Streams played from the service continue to use the existing HLS player.

The VLC runtime is downloaded by the Windows build workflow and is never checked
into Git. The bundled directory keeps VLC's own licence files (`COPYING.txt`,
`AUTHORS.txt`) alongside the plugins.

### How the runtime is bundled

The workflow downloads `vlc-3.0.21-win64.7z`, verifies it against the SHA-256
published by VideoLAN
(`9d2b24d6bc4196b3da8d181a3878678ba272e2a7690321f8826da76a69b2fb9c`), extracts
it with the runner's 7-Zip, and copies the runtime into `vendor/vlc`. That
directory is shipped through electron-builder's `extraResources` as
`resources/vendor/vlc`.

Downloading uses `curl.exe`, not `Invoke-WebRequest`: `get.videolan.org`
answers PowerShell's default user agent with an HTML "your download will start
shortly" interstitial page (HTTP 200, about 29 KB) instead of the archive.

The native bridge is compiled from source, so the workflow rebuilds it for the
bundled Electron version with `@electron/rebuild` and fails if
`node_modules/electron-vlc-player/build/Release/vlc_binding.node` is missing.
That binding is listed in `asarUnpack` so it loads from
`resources/app.asar.unpacked/`.

Before publishing, the workflow asserts that the packaged application directory
contains `resources/vendor/vlc/libvlc.dll`, `libvlccore.dll`, the `plugins`
directory, and the unpacked native binding. A build that would ship a Streammore
without MKV support fails instead of publishing.

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

The Windows workflow builds both executables, verifies that they are complete
and that the native MKV player parts are packaged, and publishes the release
assets plus Electron's `latest.yml` metadata. The desktop updater reads that
GitHub release metadata automatically.

## Code signing

Releases are published unsigned, so Windows may show a SmartScreen or
unknown-publisher warning when installing them.

`electron-builder` 26 rejects unknown keys inside the `win` section
(`additionalProperties: false`), so signing options live under
`win.signtoolOptions`. They are inert while `signAndEditExecutable` is `false`,
which is the current state.

To sign tagged builds later:

1. Add the repository Actions secrets
   `WINDOWS_CODE_SIGNING_CERTIFICATE_BASE64` (base64 `.pfx` contents) and
   `WINDOWS_CODE_SIGNING_CERTIFICATE_PASSWORD`. Never commit the `.pfx`.
2. Map them for the build step as `CSC_LINK` and `CSC_KEY_PASSWORD`.
3. Set `signAndEditExecutable: true` in `electron-builder.yml`.
4. Bump the version, tag it, and push.

PowerShell example for encoding the certificate locally:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("Streammore-CodeSigning.pfx")) | Set-Clipboard
```

Release history: `v1.0.1` was built before VLC support existed, and `v1.0.2` is
the first release with native MKV playback. Both are unsigned.

The Electron shell keeps cookies in the normal persistent Electron session,
keeps Node integration disabled, denies renderer permission prompts, prevents
the app from navigating away from the Streammore origin, and opens external
links in the system browser.

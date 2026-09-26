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

## Native Xtream playback

Xtream movies and series are published by `/api/streams` twice: as our HLS
rendition (`…/content/<token>.m3u8`) and as the provider's own file
(`…/content/<token>.mkv`, exposed as `nativeUrl` + `sourceExtension`). The
Android TV client plays the provider file — `Models.kt`:

```kotlin
fun tvUrl(): String = nativeUrl?.takeIf { it.isNotBlank() } ?: url
```

This app matches that. The bundled libVLC demuxes Matroska, so the player asks
for the same `.mkv` instead of the rendition, and falls back to the HLS
rendition whenever the provider file is unavailable — exactly the behaviour a
browser gets everywhere else.

How the two halves cooperate:

| Layer | File | Responsibility |
| --- | --- | --- |
| Web client | `public/native-playback.js` | Decides the URL (Android's `tvUrl()` rule) |
| Web client | `public/player.js` | Calls the bridge, mirrors libVLC's clock into progress |
| Shell | `preload.cjs` | Advertises `streammoreDesktop.nativePlayback` |
| Shell | `main.cjs` | Plays the URL in libVLC, reports events back |

Behaviour worth knowing:

* Only the configured Streammore origin may be handed to libVLC; local files
  reach the player solely through **Open MKV file…**.
* Progress, resume and "next episode" keep working: the shell reports libVLC's
  position every second and the player saves that as usual.
* The page keeps a slim bar above the video window (a native window cannot be
  overlapped by page content) with a back button, because the standard overlay
  would sit underneath the video.
* libVLC reports its audio tracks and the player picks English, mirroring the
  Android client's `setPreferredAudioLanguage("en")`.
* If the native player cannot start within 25 s, the title continues on the HLS
  rendition rather than failing.
* Live channels always use the rendition; there is no provider file to ask for.

Everything else streamed from the service continues to use the HLS player.


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

## Portable builds update themselves

`electron-updater` has no portable support. The portable launcher runs the app
from a temp directory and keeps the launched `.exe` open while it waits for the
app to exit, so `quitAndInstall()` cannot replace the file the user actually
launched. The portable build therefore uses its own path, implemented in
`portable-update.cjs`:

1. the newest release is still resolved through `electron-updater`, so the
   channel rules (stable releases only, tag must match the version) live in one
   place;
2. the published portable executable is downloaded next to the running file as
   `Streammore-Portable-<version>-x64.exe.update` and verified against the
   release's `portable.yml` (size and base64 SHA-512) *before* anything is
   replaced;
3. a detached PowerShell helper waits for this process and the portable
   launcher to exit, keeps the previous build as `<name>.exe.old`, replaces the
   file, and starts the new build.

If the swap cannot happen — for example the executable sits in a read-only
folder — the helper writes `<name>.exe.update-failed.log` and the next launch
reports it together with a manual download link. Backups are kept for a day and
then cleaned up, and a download the user postponed is offered again on the next
launch. Only files this app created next to the portable executable are ever
removed.

Every release publishes a `portable.yml` beside `latest.yml`. The workflow
verifies it against the executable it just built with
`scripts/verify-portable-channel.cjs` before uploading, so the app can never be
offered update metadata that does not describe the published file.

Checks for this code path:

```bash
npm run check
npm test
```

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

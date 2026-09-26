const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The page decides *which* URL to request (public/native-playback.js in the web
// client) and this shell plays it. These checks keep the two halves of that
// contract honest: the capability the page looks for, the IPC channel names and
// the event names it subscribes to all have to line up.

const root = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');

test('the preload advertises the capability the player tests for', () => {
  assert.match(preload, /nativePlayback: true/);
  assert.match(preload, /typeof desktop\.nativePlayback/ === 'string' || /nativePlayback/);
});

test('the preload exposes playNative, stopNative and setAudioTrack', () => {
  assert.match(preload, /playNative: \(payload\) => ipcRenderer\.invoke\('streammore:native-play'/);
  assert.match(preload, /stopNative: \(\) => ipcRenderer\.invoke\('streammore:native-stop'/);
  assert.match(preload, /setAudioTrack: \(trackId\) => ipcRenderer\.invoke\('streammore:native-audio-track'/);
});

test('both halves agree on the event channel name', () => {
  const channel = /const NATIVE_EVENT_CHANNEL = '([^']+)'/.exec(main)?.[1];
  assert.equal(channel, 'streammore:native-event');
  assert.match(preload, new RegExp(`ipcRenderer\\.on\\('${channel}'`));
});

test('the shell emits the event names the page handles', () => {
  for (const name of ['playing', 'paused', 'time', 'audioTracks', 'buffering', 'ended', 'stopped', 'error']) {
    assert.match(main, new RegExp(`type: '${name}'`), `missing event: ${name}`);
  }
});

test('native playback is registered before the window is created', () => {
  const ready = /app\.whenReady\(\)\.then\(\(\) => \{([\s\S]*?)\n  \}\);/.exec(main)?.[1] || '';
  const native = ready.indexOf('setupNativePlayback();');
  const window = ready.indexOf('createWindow();');
  assert.ok(native > -1, 'setupNativePlayback() must run on ready');
  assert.ok(window > -1 && native < window, 'handlers must exist before the page can call them');
});

test('only the configured Streammore origin may be handed to libVLC', () => {
  assert.match(main, /url\.origin !== new URL\(configuredUrl\(\)\)\.origin/);
  assert.match(main, /if \(url === null\) \{/);
  // A local file from the page must never reach the player.
  assert.match(main, /const ALLOWED_PROTOCOLS = new Set\(\['http:', 'https:'\]\);/);
});

test('libVLC’s clock is mirrored to the page once a second', () => {
  assert.match(main, /nativeClockTimer = setInterval\(\(\) => \{/);
  assert.match(main, /positionMs: Number\(vlcPlayer\.getTime\(\)\) \|\| 0/);
  assert.match(main, /durationMs: Number\(vlcPlayer\.getLength\(\)\) \|\| 0/);
  assert.match(main, /\}, 1000\);/);
});

test('resume seeks after the container is parsed, not before', () => {
  const play = /ipcMain\.handle\('streammore:native-play'[\s\S]*?\n  \}\);/.exec(main)?.[0] || '';
  assert.match(play, /positionMs > 5000/);
  assert.match(play, /setTimeout\(\(\) => \{/);
  assert.match(play, /vlcPlayer\?\.setTime\(Math\.round\(positionMs\)\)/);
});

test('stopping keeps the embedded player for the next title', () => {
  const stop = /async function stopNativePlayback\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] || '';
  assert.match(stop, /vlcPlayer\.unloadMedia\(\)/);
  assert.doesNotMatch(stop, /vlcPlayer\.destroy\(\)/);
  assert.match(stop, /await removeVlcSurface\(\)/);
});

test('the stream surface only appears when a title is played', () => {
  // openMkvFile and the page both build the surface through ensureVlcSurface.
  assert.match(main, /async function ensureVlcSurface\(\)/);
  assert.match(main, /id = 'streammore-vlc-surface'/);
  assert.match(main, /if \(!document\.getElementById\('streammore-vlc-surface'\)\)/);
});

test('a failed native start falls back instead of stranding the viewer', () => {
  assert.match(main, /return \{ ok: false, error: error\.message \};/);
  assert.match(main, /await stopNativePlayback\(\)\.catch\(\(\) => \{\}\);/);
});

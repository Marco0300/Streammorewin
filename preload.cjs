const { contextBridge, ipcRenderer } = require('electron');

/**
 * The page runs our own Streammore client, so the bridge stays deliberately
 * small: a capability flag the player uses to pick the container it can handle,
 * and the two calls needed to hand a URL to the bundled libVLC player.
 *
 * `nativePlayback` mirrors what the Android client gets from Media3 — the
 * ability to play the provider's real file (Matroska included) instead of the
 * server's HLS rendition. See public/native-playback.js.
 */
contextBridge.exposeInMainWorld('streammoreDesktop', {
  version: process.versions.electron,
  platform: process.platform,
  nativePlayback: true,

  /** Play a resolved source URL in the bundled VLC player. */
  playNative: (payload) => ipcRenderer.invoke('streammore:native-play', payload),

  /** Stop native playback and return to the page. */
  stopNative: () => ipcRenderer.invoke('streammore:native-stop'),

  /** Seek the native player, in milliseconds. */
  seekNative: (positionMs) => ipcRenderer.invoke('streammore:native-seek', positionMs),

  /** Switch the native player to a specific audio track (English by default). */
  setAudioTrack: (trackId) => ipcRenderer.invoke('streammore:native-audio-track', trackId),

  /**
   * Subscribe to native playback events: playing, paused, time, audioTracks,
   * buffering, ended, stopped and error.
   * Returns an unsubscribe function.
   */
  onNativeEvent: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('streammore:native-event', handler);
    return () => ipcRenderer.removeListener('streammore:native-event', handler);
  },
});

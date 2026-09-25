const { app, BrowserWindow, shell, session, screen, dialog, Menu, ipcMain } = require('electron');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { autoUpdater } = require('electron-updater');
const portableUpdate = require('./portable-update.cjs');

const DEFAULT_URL = 'https://streammore.mmcloud.co.za';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const RESPONSIVE_CSS = fs.readFileSync(path.join(__dirname, 'responsive.css'), 'utf8');
let mainWindow;
let updatePromptOpen = false;
let updateTimer;
let autoCheckUpdates = true;
let vlcPlayer = null;
let portableStaged = null;

function configuredUrl() {
  const fromEnv = process.env.STREAMMORE_DESKTOP_URL;
  const fromArg = process.argv.find((value) => value.startsWith('--streammore-url='))?.slice('--streammore-url='.length);
  const value = fromArg || fromEnv || DEFAULT_URL;
  try {
    const url = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    return DEFAULT_URL;
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, Math.max(960, Math.floor(workArea.width * 0.92)));
  const height = Math.min(900, Math.max(640, Math.floor(workArea.height * 0.90)));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 640,
    fullscreenable: true,
    show: false,
    backgroundColor: '#0a0810',
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'assets', 'streammore-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Chromium's HTML Fullscreen API emits these events in Electron, but Electron
  // does not reliably maximize the native window for every Windows build unless
  // the host handles the transition explicitly. The Streammore player requests
  // fullscreen from a user click; mirror that request at the BrowserWindow level.
  mainWindow.on('enter-html-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
  });
  mainWindow.on('leave-html-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (ALLOWED_PROTOCOLS.has(parsed.protocol)) shell.openExternal(parsed.toString());
    } catch { /* ignore malformed external URLs */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const current = new URL(mainWindow.webContents.getURL());
      const next = new URL(url);
      // Keep the app inside Streammore. External links are opened in the user's
      // default browser instead of replacing the desktop client.
      if (next.origin !== current.origin) {
        event.preventDefault();
        if (ALLOWED_PROTOCOLS.has(next.protocol)) shell.openExternal(next.toString());
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('streammore-load-error', { detail: ${JSON.stringify({ code, description })} }))`).catch(() => {});
  });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(RESPONSIVE_CSS).catch(() => {});
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(configuredUrl());
}

function checkForUpdates() {
  if (!app.isPackaged) return Promise.resolve(null);
  return autoUpdater.checkForUpdates().catch((error) => {
    console.warn('[updates] check failed:', error.message);
    return null;
  });
}

function installUpdate() {
  updatePromptOpen = false;
  autoUpdater.quitAndInstall(false, true);
}

// --- Portable build self-update -------------------------------------------
//
// electron-updater has no portable support: the portable launcher runs the app
// from a temp directory and keeps the launched .exe open until the app exits,
// so quitAndInstall() cannot replace it. The portable build instead downloads
// the published portable executable, verifies it against portable.yml, and
// hands the swap to a detached helper that runs once both processes exit.
// The logic itself lives in portable-update.cjs.

function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': `Streammore/${app.getVersion()}`, Accept: '*/*' } },
      (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirects <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          httpsGet(new URL(response.headers.location, url).toString(), redirects - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`download failed with HTTP ${status}`));
          return;
        }
        resolve(response);
      },
    );
    request.setTimeout(60_000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
  });
}

async function fetchText(url) {
  const response = await httpsGet(url);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadFile(url, destination) {
  const response = await httpsGet(url);
  const announced = Number(response.headers['content-length'] || 0);
  await pipeline(response, fs.createWriteStream(destination));
  const written = fs.statSync(destination).size;
  if (announced > 0 && written !== announced) {
    throw new Error(`the download stopped early (${written} of ${announced} bytes)`);
  }
  return written;
}

async function downloadPortableUpdate(version) {
  const target = portableUpdate.portableExecutable();
  if (!target) throw new Error('this build is not running as a portable executable');

  const channel = portableUpdate.parsePortableChannel(
    await fetchText(portableUpdate.portableChannelUrl(version)),
  );
  if (channel === null) {
    throw new Error('the release does not publish a portable.yml channel file');
  }

  const expectedName = portableUpdate.portableAssetName(version);
  if (channel.url !== expectedName) {
    throw new Error(`the release publishes "${channel.url}" instead of "${expectedName}"`);
  }

  const staged = portableUpdate.stagedPathFor(target, version);
  await fs.promises.mkdir(path.dirname(staged), { recursive: true });
  await downloadFile(portableUpdate.portableAssetUrl(version), staged);

  const verification = portableUpdate.verifyStagedFile(staged, channel);
  if (!verification.ok) {
    fs.rmSync(staged, { force: true });
    throw new Error(`the downloaded update failed verification: ${verification.reason}`);
  }

  portableStaged = staged;
  return staged;
}

function portableProblemDetail(error, version) {
  const lines = [error.message];
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    lines.push('Streammore cannot write next to the portable executable. Move it to a folder you can write to, such as your Desktop.');
  }
  if (version) {
    lines.push(`You can also download the new version manually:\n${portableUpdate.releasePageUrl(version)}`);
  }
  return lines.join('\n\n');
}

function installPortableUpdate(version) {
  const target = portableUpdate.portableExecutable();
  const staged = portableStaged;
  updatePromptOpen = false;

  if (!target || !staged || !fs.existsSync(staged)) {
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Streammore update failed',
      message: 'The downloaded update is no longer available.',
      detail: portableProblemDetail(new Error('no staged update file'), version),
    });
    return;
  }

  const scriptPath = path.join(app.getPath('temp'), `streammore-portable-update-${process.pid}.ps1`);
  try {
    fs.writeFileSync(
      scriptPath,
      portableUpdate.buildSwapScript({
        target,
        staged,
        appPid: process.pid,
        launcherPid: process.ppid,
        logPath: portableUpdate.failureLogPathFor(target),
      }),
      'utf8',
    );
    const helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    helper.unref();
  } catch (error) {
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Streammore update failed',
      message: 'Streammore could not start the update helper.',
      detail: portableProblemDetail(error, version),
    });
    return;
  }

  app.quit();
}

/** Report a failed swap, clear leftovers, and offer a postponed download. */
async function applyPendingPortableUpdate() {
  const target = portableUpdate.portableExecutable();
  if (!target) return;
  const directory = path.dirname(target);
  const logPath = portableUpdate.failureLogPathFor(target);

  if (fs.existsSync(logPath)) {
    let detail = '';
    try {
      detail = fs.readFileSync(logPath, 'utf8').trim();
    } catch {
      detail = '';
    }
    fs.rmSync(logPath, { force: true });
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Streammore update failed',
      message: 'The last portable update could not be installed.',
      detail: `${detail}\n\nDownload the new version from:\n${portableUpdate.latestReleasePageUrl()}`,
    });
  }

  const cleaned = portableUpdate.cleanupLeftovers(directory, app.getVersion());
  if (cleaned.removed.length > 0) {
    console.log('[updates] removed portable leftovers:', cleaned.removed.join(', '));
  }

  const pending = portableUpdate.findPendingStaged(directory, app.getVersion());
  if (pending === null) return;

  portableStaged = pending.path;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Streammore update ready',
    message: `Streammore ${pending.version} is ready to install.`,
    detail: 'It was downloaded earlier. Restart Streammore now to finish updating.',
    buttons: ['Restart and install', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) installPortableUpdate(pending.version);
}

function bundledVlcDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'vlc')
    : path.join(__dirname, 'vendor', 'vlc');
}

async function removeVlcSurface() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(`
    document.getElementById('streammore-vlc-surface')?.remove();
  `).catch(() => {});
}

async function closeMkvPlayer() {
  if (vlcPlayer) {
    try { vlcPlayer.destroy(); } catch (error) { console.warn('[vlc] destroy failed:', error.message); }
    vlcPlayer = null;
  }
  await removeVlcSurface();
}

async function openMkvFile() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open MKV file',
    properties: ['openFile'],
    filters: [{ name: 'Matroska video', extensions: ['mkv', 'mka'] }],
  });
  if (result.canceled || !result.filePaths[0]) return;

  const vlcDir = bundledVlcDir();
  if (!fs.existsSync(path.join(vlcDir, 'libvlc.dll'))) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'MKV playback is not available',
      message: 'The bundled VLC runtime is missing.',
      detail: 'Reinstall the signed Streammore Windows package or rebuild it with the VLC runtime included.',
    });
    return;
  }

  try {
    await mainWindow.webContents.executeJavaScript(`
      document.getElementById('streammore-vlc-surface')?.remove();
      const surface = document.createElement('div');
      surface.id = 'streammore-vlc-surface';
      surface.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#000;';
      document.body.appendChild(surface);
    `);

    if (!vlcPlayer) {
      const { VlcPlayer } = require('electron-vlc-player');
      vlcPlayer = new VlcPlayer({
        window: mainWindow,
        container: '#streammore-vlc-surface',
        vlcDir,
        controls: true,
        pageFullscreenButton: true,
        hardwareAcceleration: 'd3d11va',
      });
      await vlcPlayer.embed();
    }
    vlcPlayer.setSource(result.filePaths[0]);
  } catch (error) {
    await closeMkvPlayer();
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open MKV file',
      message: 'Streammore could not start the native VLC player.',
      detail: error.message,
    });
  }
}

function updatePreferencesPath() {
  return path.join(app.getPath('userData'), 'update-preferences.json');
}

function loadUpdatePreferences() {
  try {
    const value = JSON.parse(fs.readFileSync(updatePreferencesPath(), 'utf8'));
    autoCheckUpdates = value.autoCheckUpdates !== false;
  } catch {
    autoCheckUpdates = true;
  }
}

function saveUpdatePreferences() {
  try {
    fs.mkdirSync(path.dirname(updatePreferencesPath()), { recursive: true });
    fs.writeFileSync(updatePreferencesPath(), JSON.stringify({ autoCheckUpdates }, null, 2));
  } catch (error) {
    console.warn('[updates] preferences could not be saved:', error.message);
  }
}

function scheduleAutomaticChecks() {
  if (updateTimer) clearInterval(updateTimer);
  if (!autoCheckUpdates) return;
  setTimeout(() => void checkForUpdates(), 10_000);
  updateTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
}

function setupUpdates() {
  loadUpdatePreferences();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', async (info) => {
    if (updatePromptOpen || !mainWindow || mainWindow.isDestroyed()) return;
    if (!portableUpdate.isNewerVersion(app.getVersion(), info.version)) return;
    updatePromptOpen = true;
    const portable = portableUpdate.isPortable();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Streammore update available',
      message: `Streammore ${info.version} is available.`,
      detail: portable
        ? 'Download the new portable build now? Streammore asks again before restarting to replace it.'
        : 'Download the update now? The app will ask before restarting.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0) {
      updatePromptOpen = false;
      return;
    }

    if (portable) {
      try {
        await downloadPortableUpdate(info.version);
      } catch (error) {
        updatePromptOpen = false;
        console.warn('[updates] portable download failed:', error.message);
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Streammore update failed',
          message: 'The portable update could not be downloaded.',
          detail: portableProblemDetail(error, info.version),
        });
        return;
      }
      const restart = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Streammore update ready',
        message: `Streammore ${info.version} has been downloaded.`,
        detail: 'Restart Streammore now to replace the portable file. The current file is kept as a backup until the next launch.',
        buttons: ['Restart and install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (restart.response === 0) {
        installPortableUpdate(info.version);
      } else {
        updatePromptOpen = false;
      }
      return;
    }

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      updatePromptOpen = false;
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Streammore update failed',
        message: 'The update could not be downloaded.',
        detail: error.message,
      });
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Portable builds take the replacement path above; the installer payload
    // electron-updater downloads here cannot replace a portable executable.
    if (portableUpdate.isPortable()) return;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Streammore update ready',
      message: `Streammore ${info.version} has been downloaded.`,
      detail: 'Restart Streammore now to install it, or choose Later and install on the next launch.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    updatePromptOpen = false;
    if (result.response === 0) installUpdate();
  });

  autoUpdater.on('error', (error) => {
    updatePromptOpen = false;
    console.warn('[updates] updater error:', error.message);
  });

  // Check shortly after launch and then every six hours while the app is open.
  scheduleAutomaticChecks();
}

function setupApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Streammore',
      submenu: [
        {
          label: 'Open MKV file…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openMkvFile(),
        },
        {
          label: 'Close MKV player',
          click: () => void closeMkvPlayer(),
        },
        { type: 'separator' },
        {
          label: 'Check for updates',
          click: () => void checkForUpdates(),
        },
        {
          label: 'Automatically check for updates',
          type: 'checkbox',
          checked: autoCheckUpdates,
          click: (item) => {
            autoCheckUpdates = item.checked;
            saveUpdatePreferences();
            scheduleAutomaticChecks();
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ]));
}

app.setName('Streammore');
app.setAppUserModelId('com.streammore.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    // Keep authenticated Streammore cookies between launches. This is the
    // desktop equivalent of the Android client's persisted session cookie.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    setupUpdates();
    setupApplicationMenu();
    createWindow();
    void applyPendingPortableUpdate();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  if (updateTimer) clearInterval(updateTimer);
  if (process.platform !== 'darwin') app.quit();
});

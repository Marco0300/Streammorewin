const { app, BrowserWindow, shell, session, screen, dialog, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const DEFAULT_URL = 'https://streammore.mmcloud.co.za';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const RESPONSIVE_CSS = fs.readFileSync(path.join(__dirname, 'responsive.css'), 'utf8');
let mainWindow;
let updatePromptOpen = false;
let updateTimer;
let autoCheckUpdates = true;

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
    updatePromptOpen = true;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Streammore update available',
      message: `Streammore ${info.version} is available.`,
      detail: 'Download the update now? The app will ask before restarting.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0) {
      updatePromptOpen = false;
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
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  if (updateTimer) clearInterval(updateTimer);
  if (process.platform !== 'darwin') app.quit();
});

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// The URL of the online web app (Vercel deploy). Loaded first on every launch so any update
// pushed to Vercel (new features, bug fixes) shows up immediately, without rebuilding the .exe.
// If it can't be reached (no internet, DNS failure, Vercel down, etc.), we automatically fall
// back to the copy of the app bundled inside the .exe (in the app/ folder), so the window still
// opens and shows something useful — and we keep quietly retrying the online version in the
// background, switching back to it the moment the connection is restored.
const APP_URL = 'https://lms-app-2026.vercel.app';
const RECONNECT_INTERVAL_MS = 15000; // how often to retry the online site while offline

// Keep a global reference so it isn't garbage collected.
let mainWindow;
let usingFallback = false;
let reconnectTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false, // wait until maximized (below) before showing, so there's no visible resize jump
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true, // hides the default File/Edit/View menu bar (press Alt to reveal)
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The app is plain HTML/CSS/JS that talks to Supabase over HTTPS — it needs no Node.js
      // or filesystem access, so we keep the renderer fully sandboxed (safer defaults).
      sandbox: true,
    },
  });

  // Fill the screen on whatever monitor/resolution the user has — maximized (not exclusive
  // "fullscreen", which would also hide the Windows taskbar). Runs once the window is ready to
  // paint, then reveals it already at full size instead of flashing the smaller 1400x900 first.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  registerLoadHandlers();
  loadOnline();

  // Open external links (e.g. the Telegram support link) in the user's real browser
  // instead of inside the app window. But the app also does window.open('', '_blank')
  // internally (e.g. for the print-schedule feature) to build a blank print preview —
  // those have no real http(s) URL (url is "about:blank" or empty), so let Electron
  // open them as a normal in-app window instead of handing them to the OS shell, which
  // doesn't know how to "open" about:blank and pops up a "You'll need a new app..." dialog.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    // Internal window (about:blank, etc.) — allow it to open as a real child window.
    return { action: 'allow' };
  });

  // Uncomment the next line while debugging to open DevTools automatically:
  // mainWindow.webContents.openDevTools();
}

function loadOnline() {
  usingFallback = false;
  mainWindow.loadURL(APP_URL);
}

function loadFallback() {
  if (usingFallback) return; // already showing it, no need to reload/flash the screen
  usingFallback = true;
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  startReconnectLoop();
}

// While showing the offline fallback, periodically try the online URL again in the background.
// If it succeeds, did-finish-load (below) detects we're back on APP_URL and stops this loop.
function startReconnectLoop() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (usingFallback) mainWindow.loadURL(APP_URL);
  }, RECONNECT_INTERVAL_MS);
}

function stopReconnectLoop() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

function registerLoadHandlers() {
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ERR_ABORTED — fires on normal navigations/redirects, ignore
    if (!isMainFrame) return; // ignore failed sub-resources (images, CDN scripts, etc.)
    if (validatedURL.startsWith(APP_URL)) loadFallback();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.webContents.getURL().startsWith(APP_URL)) {
      usingFallback = false;
      stopReconnectLoop();
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // remove default menu entirely (File/Edit/View/Window/Help)
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

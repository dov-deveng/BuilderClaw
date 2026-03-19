/**
 * BuilderClaw — Electron Main Process
 * Runs the Express server in-process and opens the app window.
 * No terminal required — everything runs inside the app.
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const SERVER_PORT = 3000;
let mainWindow = null;

// --- Start server in-process via dynamic import ---
async function startServer() {
  const serverPath = path.join(__dirname, '..', 'src', 'index.js');
  console.log('[app] Loading server from:', serverPath);

  try {
    // Dynamic import of the ESM server module
    // This runs start() which calls app.listen()
    await import(pathToFileURL(serverPath).href);
    console.log('[app] Server module loaded');
  } catch (err) {
    console.error('[app] Server load error:', err.message);
    console.error(err.stack);
  }

  // Wait for Express to be listening
  return waitForServer(SERVER_PORT);
}

function waitForServer(port, maxRetries = 60) {
  return new Promise((resolve) => {
    let attempt = 0;
    const check = () => {
      const req = http.get(`http://localhost:${port}/api/setup/status`, (res) => {
        res.resume();
        console.log('[app] Server is ready');
        resolve();
      });
      req.on('error', () => {
        attempt++;
        if (attempt >= maxRetries) {
          console.log('[app] Server wait timed out, opening window anyway');
          resolve();
        } else {
          setTimeout(check, 500);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        attempt++;
        if (attempt >= maxRetries) resolve();
        else setTimeout(check, 500);
      });
    };
    check();
  });
}

// --- Window ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f5f3ef',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Retry if server wasn't ready yet
  mainWindow.webContents.on('did-fail-load', () => {
    console.log('[app] Page load failed, retrying in 2s...');
    setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
    }, 2000);
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes('localhost')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- App Lifecycle ---
app.whenReady().then(async () => {
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

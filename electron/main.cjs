/**
 * BuilderClaw — Electron Main Process
 * Launches the Express server and opens the app window.
 * No terminal required — everything runs inside the app.
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

const SERVER_PORT = 3000;
let mainWindow = null;
let serverProcess = null;

// --- Server Management ---
function startServer() {
  const serverPath = path.join(__dirname, '..', 'src', 'index.js');

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BUILDERCLAW_DATA_DIR: path.join(app.getPath('userData'), 'data'),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  serverProcess.stdout.on('data', (d) => {
    console.log('[server]', d.toString().trim());
  });

  serverProcess.stderr.on('data', (d) => {
    console.error('[server]', d.toString().trim());
  });

  serverProcess.on('error', (err) => {
    console.error('[server] Process error:', err.message);
  });

  serverProcess.on('exit', (code) => {
    console.log('[server] Exited with code:', code);
    serverProcess = null;
  });

  return waitForServer(SERVER_PORT);
}

function waitForServer(port, maxRetries = 40) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const check = () => {
      const req = http.get(`http://localhost:${port}/api/setup/status`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        attempt++;
        if (attempt >= maxRetries) {
          // Even if health check fails, open the window — server might be slow
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

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
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
  try {
    await startServer();
  } catch (err) {
    console.error('[app] Failed to start server:', err.message);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', cleanup);

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill('SIGTERM');
    } catch {}
    serverProcess = null;
  }
}

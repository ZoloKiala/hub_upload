// Electron main process for the IWMI Hub Uploader.
// - Spawns the Python FastAPI backend (backend.py) as a child process.
// - Opens a frameless window with custom (macOS-style) chrome.
// - Provides native file/folder dialogs and window controls over IPC.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const BACKEND_PORT = 8765;
const PROJECT_ROOT = path.join(__dirname, "..");
const BACKEND = path.join(PROJECT_ROOT, "backend.py");

let backendProc = null;
let win = null;

function startBackend() {
  const env = { ...process.env, BACKEND_PORT: String(BACKEND_PORT) };
  let cmd, args, cwd;
  if (app.isPackaged) {
    // Packaged build: run the standalone backend (PyInstaller) shipped as an
    // extra resource. It reads HF_TOKEN from a .env next to it (resourcesPath).
    cmd = path.join(process.resourcesPath, "hub-backend.exe");
    args = [];
    cwd = process.resourcesPath;
  } else {
    // Dev: run the Python source directly. `py -3` is the Windows launcher.
    cmd = process.platform === "win32" ? "py" : "python3";
    args = process.platform === "win32" ? ["-3", BACKEND] : [BACKEND];
    cwd = PROJECT_ROOT;
  }
  backendProc = spawn(cmd, args, { cwd, env, windowsHide: true });
  backendProc.stdout.on("data", (d) => console.log("[backend]", d.toString().trim()));
  backendProc.stderr.on("data", (d) => console.log("[backend]", d.toString().trim()));
  backendProc.on("error", (e) => console.error("[backend] failed to start:", e.message));
}

function stopBackend() {
  if (!backendProc) return;
  const pid = backendProc.pid;
  backendProc = null;
  if (process.platform === "win32") {
    // kill the whole tree (py launcher -> python.exe -> uvicorn)
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
  } else {
    try { process.kill(pid); } catch (_) {}
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1328,
    height: 858,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: "#020617",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--backend-port=${BACKEND_PORT}`],
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
}

// ── file helpers ──
function statFile(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function walkDir(dir) {
  // return files relative to the PARENT of `dir` so the folder name is kept
  const base = path.dirname(dir);
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push({
          path: full,
          rel: path.relative(base, full).split(path.sep).join("/"),
          size: statFile(full),
        });
      }
    }
  }
  return out;
}

// ── IPC ──
ipcMain.handle("dialog:openFiles", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, rel: path.basename(p), size: statFile(p) }));
});

ipcMain.handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths.length) return [];
  return walkDir(r.filePaths[0]);
});

ipcMain.handle("fs:statFiles", async (_e, paths) =>
  paths.map((p) => ({ path: p, rel: path.basename(p), size: statFile(p) }))
);

ipcMain.handle("shell:openExternal", async (_e, url) => { shell.openExternal(url); });
ipcMain.handle("window:minimize", () => win && win.minimize());
ipcMain.handle("window:maximize", () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle("window:close", () => win && win.close());

// ── lifecycle ──
app.whenReady().then(() => {
  startBackend();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { app.quit(); });
app.on("before-quit", stopBackend);
process.on("exit", stopBackend);

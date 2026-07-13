// Secure bridge between the renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const portArg = process.argv.find((a) => a.startsWith("--backend-port="));
const BACKEND_PORT = portArg ? portArg.split("=")[1] : "8765";

contextBridge.exposeInMainWorld("api", {
  isElectron: true,
  backendBase: `http://127.0.0.1:${BACKEND_PORT}`,

  openFiles: () => ipcRenderer.invoke("dialog:openFiles"),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),

  // dropped files resolve to real local paths — no byte copy needed
  stageDropped: (fileList) => {
    const paths = Array.from(fileList).map((f) => webUtils.getPathForFile(f));
    return ipcRenderer.invoke("fs:statFiles", paths);
  },

  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
});

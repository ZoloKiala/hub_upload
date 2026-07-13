# IWMI Hub Uploader — Electron desktop app

A native desktop window that recreates the high-fidelity design from the handoff
(macOS-style window chrome, pill nav, dark slate theme) and performs real uploads
to the **IWMIHQ** Hugging Face organization.

## Architecture

```
electron/
├── main.js            Electron main process — spawns the Python backend,
│                      opens the frameless window, native file dialogs,
│                      window controls (traffic lights).
├── preload.js         contextBridge: file paths, dialogs, window controls.
├── renderer/          The UI (no framework, matches the design tokens):
│   ├── index.html     all screens: connect · upload · history · uploading · done · help
│   ├── styles.css     Irrigation Viewer design tokens
│   └── app.js         state, drag-drop, live README, upload+progress
└── run.cmd            launcher that clears ELECTRON_RUN_AS_NODE first

../backend.py          FastAPI wrapper around huggingface_hub, on 127.0.0.1:8765
                       (identity · list repos · README preview · upload w/ progress)
```

The renderer talks to `backend.py` over HTTP. File uploads pass **local paths**
(the renderer and backend share the machine), so `huggingface_hub` reads files
directly — no bytes are copied over HTTP, and folders keep their structure.

## Run

```bash
pip install -r ../requirements.txt   # backend deps
npm install                          # one-time (downloads Electron)
run.cmd                              # Windows launcher (or: npm start)
```

Real uploads need a valid **write** token in `../.env` (`HF_TOKEN`). With the
placeholder token the UI works fully but the header shows "token not set" and
uploads will fail.

## Toward a distributable installer

`main.js` spawns `py -3 backend.py`, which assumes Python is installed. To ship
to users without Python, bundle the backend with PyInstaller
(`pyinstaller --onefile ../backend.py`) and point `main.js` at the resulting
binary, then package with `electron-builder`. (The `src-tauri/` scaffold is the
alternative, smaller-binary route.)

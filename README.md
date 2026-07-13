# IWMI Hub Uploader — working app

Upload models, datasets and Spaces to the **IWMIHQ** Hugging Face organization in a few clicks.
Built with Python + Gradio + `huggingface_hub` (the stack recommended in the design handoff).

## Setup

1. Python 3.10+
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Create the team token ONCE (admin only): log in as the `IWMI-huggingface`
   service account → Settings → Access Tokens → New token (write scope).
4. Put it in the environment (never in code, never in git):
   ```bash
   cp .env.example .env      # then paste the token into .env
   ```

## Run

```bash
python app.py
```

Open http://127.0.0.1:7860. Enter your name (recorded in every commit message),
pick a repo type, create or update a repo, add files, upload.

## Deploy for the whole team

Option A — host as a private Space in IWMIHQ itself: create a Gradio Space,
upload `app.py` + `requirements.txt`, and set `HF_TOKEN` as a **Space secret**.
Everyone uses it in the browser with zero setup.

Option B — desktop window (pure Python): `pip install pywebview && python desktop.py`.

Option C — distributable desktop installer: Tauri scaffold in `src-tauri/`
(see `src-tauri/README.md`).

Option D — **Electron desktop app** (`electron/`): a native window that
recreates the high-fidelity design pixel-for-pixel (not the generic Gradio
form). It runs a small FastAPI backend (`backend.py`) that wraps the same
`huggingface_hub` logic. See `electron/README.md`.

## Electron app (recommended desktop build)

```bash
pip install -r requirements.txt          # backend deps (adds fastapi/uvicorn — already pulled by gradio)
cd electron && npm install               # one-time: downloads Electron
```

Run it:

```bash
cd electron
run.cmd            # Windows — clears ELECTRON_RUN_AS_NODE, then starts Electron
# or, if that env var is not set in your shell:  npm start
```

> **Gotcha:** if `ELECTRON_RUN_AS_NODE=1` is set in your environment (some IDEs /
> Electron-based tools set it globally), Electron launches as plain Node and the
> window never appears (`TypeError: Cannot read properties of undefined (reading 'handle')`).
> `run.cmd` clears it. Setting it to `0` or `""` is NOT enough — it must be unset.

`main.js` spawns `backend.py` on `127.0.0.1:8765` and opens the frameless window;
closing the window stops the backend.

## Package as a Windows installer (.exe)

The app ships as an NSIS installer. Because the backend is Python, it is first
compiled to a standalone `hub-backend.exe` (PyInstaller) and bundled into the
Electron app; the target machine needs **neither Python nor Node**.

```bash
pip install pyinstaller
# 1. compile the backend to dist-backend/hub-backend.exe
py -3 -m PyInstaller --noconfirm --onefile --name hub-backend \
  --distpath dist-backend --workpath build-backend \
  --collect-all uvicorn --collect-all fastapi --collect-all starlette \
  --collect-all anyio --collect-all huggingface_hub --collect-all pydantic \
  --collect-all pydantic_core --collect-all multipart --collect-all dotenv \
  backend.py
# 2. build the installer (electron-builder), output in dist-app/
cd electron
npm install                     # one-time
npm run dist
```

Result: `dist-app/IWMI Hub Uploader Setup <version>.exe`. Installing it registers
a proper uninstaller (so the ⋮ → **Uninstall app** entry works in Apps & features)
and creates Start-menu / desktop shortcuts. `main.js` runs the bundled
`hub-backend.exe` (from `process.resourcesPath`) when packaged, and `py -3
backend.py` in dev.

> **Token in the packaged app.** The shared `HF_TOKEN` is **not** embedded in the
> installer (anyone could extract it). The bundled backend reads `HF_TOKEN` from a
> `.env` next to it — `…\resources\.env` in the install directory — or from the
> environment. Until an admin sets it, the app runs but shows *token not set* and
> uploads fail. Decide a distribution method before handing the exe out (per-user
> setup, an MDM-pushed `.env`, or move to per-user HF login).

Deployments are logged to `%APPDATA%\IWMI Hub Uploader\deployments.jsonl` and shown
in the app's **History** tab; each successful upload also prints its Hub link to the
backend console.

## Web version (same UI, in a browser)

The exact same UI also runs as a plain web app — `backend.py` serves the
`electron/renderer/` files as a static site, and a browser shim
(`web-api.js`) replaces the Electron bridge (file pickers upload bytes to
`/api/stage` since browsers can't hand over local paths; the window chrome is
hidden).

```bash
pip install -r requirements.txt
py -3 backend.py            # then open http://127.0.0.1:8765 in a browser
```

For the whole team with zero install, deploy it as a private **Gradio/Docker
Space** in IWMIHQ (or any host) and set `HF_TOKEN` as a secret — everyone uses
it in the browser (Option A above).

### Deploy the web version to Railway

The repo is Railway-ready (`railway.json`). In Railway: **New Project → Deploy
from GitHub repo → `ZoloKiala/hub_upload`**, then set service **Variables**:

| Variable | Purpose |
|---|---|
| `HF_TOKEN` | team write token — **required** for uploads |
| `ACCESS_CODE` | if set, the whole app sits behind an HTTP Basic prompt (password = this code). **Strongly recommended for any public URL**, because uploads use the shared token and there is no passphrase. |
| `HF_ORG` | optional; defaults to `IWMIHQ` |

Then **Settings → Networking → Generate Domain**. Nixpacks installs
`requirements.txt` and runs `uvicorn backend:app --host 0.0.0.0 --port $PORT`.
Note: the deployment log is on ephemeral disk (resets on redeploy) unless you
attach a Railway **Volume**.

## Security

- `HF_TOKEN` lives only in `.env` (gitignored) or a Space secret.
- If a token is ever pasted in chat/screenshots, revoke it and make a new one.

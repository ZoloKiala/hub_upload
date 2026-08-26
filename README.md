# IWMI Hub Uploader

Upload models, datasets and Spaces to the **IWMIHQ** organization on the Hugging Face
Hub. A static, installable web app: no Python at runtime, no Node, no server.

```bash
python serve_pwa.py            # http://127.0.0.1:8099
```

That is also what the hosted deployment runs, so the URL serves the app itself.

## How it works

Each person signs in with **their own** Hugging Face write token, pasted once and kept
in their browser. Nothing secret lives on the server — there is no server — and the Hub
records who actually committed. Everything up to the upload works offline: staging
files, the pre-flight checks, the generated README. Only the upload needs the network.

Install it from the browser (the install icon in the address bar on Chrome or Edge,
Share → Add to Dock on Safari) and it opens in its own window.

## Layout

| Path | What it is |
| --- | --- |
| [`pwa/`](pwa/) | the app — see [`pwa/README.md`](pwa/README.md) |
| [`serve_pwa.py`](serve_pwa.py) | the static server: correct MIME types, sane cache headers |
| [`railway.json`](railway.json) | the hosted deployment, which runs the above |
| `requirements.txt` | empty on purpose; it only tells Nixpacks this is a Python project |

Read [`pwa/README.md`](pwa/README.md) before editing the app. It covers the token
model, what the app talks to, the rules it follows about other people's repositories,
and the traps already paid for once — `cache.addAll()` being atomic, Hub list entries
keeping the repository path in `name` rather than `id`, and why an existing README is
never overwritten.

## Deploy it

Any static host will do. On Railway the repo is ready as it stands: `railway.json`
starts `serve_pwa.py`. There is no `HF_TOKEN` to set and no `ACCESS_CODE` needed to
protect one — a visitor without their own token sees the connect screen and nothing
else. If either variable is still set on the service from an earlier deployment, remove
it, and revoke the shared token it held.

## The previous generation

This repository used to hold a Python + Gradio app, a FastAPI backend, an Electron
window and a Tauri scaffold, packaged into a Windows installer. All of it existed to
provide a window, an icon and a server-side token — the three things the PWA handles by
itself — and it uploaded with one shared team token, which is why it needed an access
code and this does not.

It is not gone, only not here: branch **`legacy-python-electron`**, tagged
**`legacy-v0.1.0`**, holds its last state, including the in-progress "Explain this
error" helper. Work from that branch to run or deploy it.

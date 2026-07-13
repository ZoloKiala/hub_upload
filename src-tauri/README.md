# Tauri desktop build (scaffold)

Tauri gives a small, signed, distributable installer (.dmg / .msi / .deb) —
the pywebview route (`../desktop.py`) is fine for internal use, but Tauri is
the production path from the design handoff.

## How it fits together

- Tauri shell (Rust) opens a native window pointing at the local uploader UI.
- The Python uploader (Gradio + huggingface_hub) runs as a **sidecar** process
  that Tauri starts and stops.
- Bundle the Python app as a single binary with PyInstaller so end users don't
  need Python:

  ```bash
  pip install pyinstaller
  pyinstaller --onefile ../app.py --name hf-uploader-server
  # place the binary in src-tauri/binaries/ and list it under
  # tauri.conf.json > bundle > externalBin
  ```

## Setup

1. Install Rust + the Tauri CLI (`cargo install tauri-cli`).
2. `cargo tauri dev` — starts the sidecar and opens the window.
3. `cargo tauri build` — produces the installer.

`tauri.conf.json` and `src/main.rs` here are a minimal working scaffold:
the window loads http://127.0.0.1:7861 served by the sidecar. Adjust the
sidecar path/name to match your PyInstaller output.

Token note: ship `HF_TOKEN` via an encrypted config or set it machine-wide;
do NOT hardcode it in this repo.

"""Desktop wrapper — runs the uploader in a native window (no browser).

    pip install pywebview
    python desktop.py

Uses the same app.py; Gradio serves locally, pywebview shows it in an
OS-native window. Simplest desktop option (pure Python).
For a distributable installer, see src-tauri/README.md.
"""

import threading

import webview  # pywebview

from app import demo

HOST, PORT = "127.0.0.1", 7861


def serve():
    demo.launch(server_name=HOST, server_port=PORT, prevent_thread_lock=True,
                show_error=True, inbrowser=False, quiet=True)


if __name__ == "__main__":
    serve()
    webview.create_window(
        "Hub uploader — IWMIHQ",
        f"http://{HOST}:{PORT}",
        width=1280,
        height=840,
        min_size=(960, 640),
    )
    webview.start()

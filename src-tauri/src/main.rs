// Tauri 2 entrypoint — starts the Python uploader sidecar, then shows the window.
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Launch the bundled Python server (PyInstaller binary, see README).
            let sidecar = app.shell().sidecar("hf-uploader-server")?;
            let (_rx, _child): (_, CommandChild) = sidecar.spawn()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running IWMI Hub Uploader");
}

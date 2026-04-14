use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            // Allow HTTPS and Tauri internal URLs only.
            // This prevents WebView from navigating to arbitrary protocols (file://, javascript://, etc.)
            // while permitting the dashboard server URL and local Tauri assets.
            window.on_navigation(|url| {
                matches!(url.scheme(), "https" | "tauri" | "http")
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

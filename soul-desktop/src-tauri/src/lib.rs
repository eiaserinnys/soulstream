use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Build the main window programmatically so we can attach
            // the navigation guard at builder time.
            //
            // Allow HTTPS and Tauri internal URLs only.
            // This prevents WebView from navigating to arbitrary protocols
            // (file://, javascript://, etc.) while permitting the dashboard
            // server URL and local Tauri assets.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Soulstream")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .on_navigation(|url| matches!(url.scheme(), "https" | "tauri" | "http"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

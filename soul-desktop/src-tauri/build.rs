fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["set_dashboard_origin"]),
        ),
    )
    .expect("failed to run tauri-build");

    if let Ok(tag) = std::env::var("GITHUB_REF_NAME") {
        if let Some(tag_version) = tag.strip_prefix("soul-desktop-v") {
            let package_version = std::env::var("CARGO_PKG_VERSION")
                .expect("Cargo did not provide CARGO_PKG_VERSION");
            assert_eq!(
                tag_version, package_version,
                "desktop release tag must match the Cargo package version",
            );
        }
    }
}

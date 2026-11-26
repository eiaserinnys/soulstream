//! 「서버 주소 설정…」 네이티브 메뉴.
//!
//! 대시보드로 넘어간 뒤에는 번들 React 앱이 언로드되므로, 설정 화면으로 돌아오는 길은
//! 네이티브 메뉴뿐이다. 메뉴 이벤트는 Rust에서만 처리하고 원격 페이지에는 command 권한을 주지 않는다.

use tauri::menu::{Menu, MenuEvent, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::PredefinedMenuItem;
#[cfg(not(target_os = "macos"))]
use tauri::menu::Submenu;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

const SETTINGS_MENU_ID: &str = "open-server-settings";
const SETTINGS_MENU_LABEL: &str = "서버 주소 설정…";
const SETTINGS_MENU_ACCELERATOR: &str = "CmdOrCtrl+,";
const SETTINGS_VIEW_QUERY: (&str, &str) = ("view", "settings");

/// 번들 앱의 기준 주소. Tauri가 `WebviewUrl::App`에 쓰는 규칙과 같다.
/// - dev 실행: `devUrl`
/// - Windows와 Android: `http://tauri.localhost`
/// - 그 밖: `tauri://localhost`
fn bundled_app_base(is_dev: bool, dev_url: Option<&Url>, http_host_scheme: bool) -> Url {
    match dev_url {
        Some(url) if is_dev => url.clone(),
        _ if http_host_scheme => Url::parse("http://tauri.localhost/").expect("static url"),
        _ => Url::parse("tauri://localhost/").expect("static url"),
    }
}

/// 내장 화면이 Settings를 바로 열도록 표시(`?view=settings`)를 붙인 주소.
fn settings_view_url(base: &Url) -> Url {
    let mut url = base.clone();
    url.set_path("/");
    url.set_fragment(None);
    url.query_pairs_mut()
        .clear()
        .append_pair(SETTINGS_VIEW_QUERY.0, SETTINGS_VIEW_QUERY.1);
    url
}

fn settings_target_url<R: Runtime>(app: &AppHandle<R>) -> Url {
    let base = bundled_app_base(
        tauri::is_dev(),
        app.config().build.dev_url.as_ref(),
        cfg!(any(windows, target_os = "android")),
    );
    settings_view_url(&base)
}

/// macOS는 기본 메뉴(앱 메뉴, 편집 메뉴 등)를 그대로 두고 앱 메뉴의 About 아래에 항목을 더한다.
/// Windows와 Linux는 항목 하나만 든 메뉴를 단다.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = MenuItem::with_id(
        app,
        SETTINGS_MENU_ID,
        SETTINGS_MENU_LABEL,
        true,
        Some(SETTINGS_MENU_ACCELERATOR),
    )?;

    #[cfg(target_os = "macos")]
    {
        let menu = Menu::default(app)?;
        if let Some(app_menu) = menu.items()?.first().and_then(|kind| kind.as_submenu()) {
            app_menu.insert_items(&[&item, &PredefinedMenuItem::separator(app)?], 2)?;
        }
        Ok(menu)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let submenu = Submenu::with_items(app, "Soulstream", true, &[&item])?;
        Menu::with_items(app, &[&submenu])
    }
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() != SETTINGS_MENU_ID {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.navigate(settings_target_url(app)) {
        eprintln!("failed to open the bundled settings view: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_nav::{classify_navigation, NavigationAction};

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn assert_allowed_as_bundled_app(target: &Url) {
        let remote_dashboard = vec![url("https://soul.example.com")];
        assert_eq!(
            classify_navigation(target, &remote_dashboard, false).action,
            NavigationAction::Allow,
            "{target} must be allowed by the navigation guard"
        );
    }

    #[test]
    fn settings_url_on_each_platform_base_is_allowed_by_the_navigation_guard() {
        for base in [
            bundled_app_base(false, None, false),
            bundled_app_base(false, None, true),
            bundled_app_base(true, Some(&url("http://localhost:1420/")), false),
        ] {
            let target = settings_view_url(&base);
            assert_eq!(target.query(), Some("view=settings"));
            assert_allowed_as_bundled_app(&target);
        }
    }

    #[test]
    fn bundled_base_follows_tauri_rules() {
        assert_eq!(
            bundled_app_base(false, None, false).as_str(),
            "tauri://localhost/"
        );
        assert_eq!(
            bundled_app_base(false, None, true).as_str(),
            "http://tauri.localhost/"
        );
        let dev = url("http://localhost:1420/");
        assert_eq!(bundled_app_base(true, Some(&dev), true), dev);
        assert_eq!(
            bundled_app_base(false, Some(&dev), true).as_str(),
            "http://tauri.localhost/"
        );
    }

    #[test]
    fn settings_url_drops_existing_path_query_and_fragment() {
        let target = settings_view_url(&url("http://tauri.localhost/old/page?x=1#frag"));
        assert_eq!(target.as_str(), "http://tauri.localhost/?view=settings");
    }
}

mod external_nav;

use std::sync::{Arc, Mutex};

use tauri::webview::NewWindowResponse;
use tauri::{State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use external_nav::{is_external_http, is_tauri_app_url};

/// dashboard origin 런타임 정본.
///
/// frontend가 setup 완료/loadConfig 직후 `set_dashboard_origin` invoke로 등록한다.
/// 등록 전(setup 화면)에서는 `None` — 모든 외부 HTTP(S)이 OS 위임 대상.
/// persistent 정본은 `tauri-plugin-store`의 `server_url`(full URL); 본 state는 그 파생물(origin).
type OriginState = Arc<Mutex<Option<Url>>>;

/// frontend(`src/utils/origin.ts`의 `registerDashboardOrigin`)가 호출하는 command.
///
/// path/query/fragment를 제거한 순수 origin URL만 보존한다.
/// Mutex poisoning은 `expect`로 panic — 정책 가드는 critical path이고
/// silent fail은 정책 미적용 상태로 navigation 허용 → 보안 결함(design-principles §4).
#[tauri::command]
fn set_dashboard_origin(origin: String, state: State<OriginState>) -> Result<(), String> {
    let parsed = Url::parse(&origin).map_err(|e| format!("invalid origin: {e}"))?;
    let mut clean = parsed.clone();
    clean.set_path("/");
    clean.set_query(None);
    clean.set_fragment(None);
    *state.lock().expect("origin state mutex poisoned") = Some(clean);
    Ok(())
}

fn snapshot_allowed(state: &OriginState) -> Vec<Url> {
    state
        .lock()
        .expect("origin state mutex poisoned")
        .clone()
        .into_iter()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let origin_state: OriginState = Arc::new(Mutex::new(None));
    let origin_state_nav = Arc::clone(&origin_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(origin_state)
        .invoke_handler(tauri::generate_handler![set_dashboard_origin])
        .setup(move |app| {
            // Navigation 정책:
            //  - Tauri app URL(`tauri:` 또는 `http://tauri.localhost`)은 내부 앱으로 허용.
            //  - 그 외 비-HTTP(S) scheme: `on_navigation`은 차단,
            //    `on_new_window`는 모두 `Deny` only(`open::that` 호출 없음) — about:blank/javascript:
            //    같은 사전작업 URL이 OS 브라우저에 빈 창을 띄우는 결함을 차단한다.
            //  - HTTP(S) external origin: 두 핸들러 모두 `open::that(url)`로 OS 기본 브라우저에
            //    위임 + (`on_navigation`은 navigation 취소).
            //  - HTTP(S) internal origin: `on_navigation` 허용, `on_new_window`도 OS 위임
            //    (일관성을 위해 — dashboard 안에서 같은 origin을 _blank로 여는 사례는 없음).
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Soulstream")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .on_navigation(move |url| {
                    if is_tauri_app_url(url) {
                        return true;
                    }
                    if !matches!(url.scheme(), "http" | "https") {
                        // `file://`, `javascript:` 등은 차단(navigation 취소).
                        return false;
                    }
                    let allowed = snapshot_allowed(&origin_state_nav);
                    if is_external_http(url, &allowed) {
                        // 외부 origin → OS 브라우저 위임 + navigation 취소.
                        // `open::that` 5.x는 실패 시 `Result`를 반환하므로 무시해 crash 방지.
                        let _ = open::that(url.as_str());
                        return false;
                    }
                    // 같은 origin — 허용.
                    true
                })
                .on_new_window(|url, _features| {
                    // 사용자가 `target="_blank"` anchor를 클릭하거나 `window.open(url)`을 호출한 경우.
                    // HTTP(S)이면 origin 무관하게 OS 브라우저로 위임(현재 동작 보존 + 외부 일관성).
                    // 비-HTTP(S)(`about:blank` 사전작업 등)는 `open::that` 호출 없이 `Deny` only —
                    // useClaudeAuthFlow.ts:126의 popup-blocker 우회 사전작업이 OS 브라우저에
                    // 빈 about:blank 창을 띄우던 결함을 차단한다.
                    if matches!(url.scheme(), "http" | "https") && !is_tauri_app_url(&url) {
                        let _ = open::that(url.as_str());
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

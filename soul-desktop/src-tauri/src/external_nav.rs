//! 외부 navigation 정책 가드.
//!
//! `is_external_http`는 webview의 navigation/new-window 핸들러가 호출하는 순수 함수다.
//! HTTP(S) scheme이면서 등록된 dashboard origin과 다른 origin인 경우 `true`를 반환한다.
//! 호출자가 `true`를 받으면 navigation을 취소하고 `open::that(url)`로 OS 기본 브라우저에
//! 위임한다. 비-HTTP(S) scheme(about/javascript/mailto/tel/blob 등)은 `false`로 분류되며,
//! 호출자는 별도 정책으로 처리한다.

use url::Url;

const DASHBOARD_GOOGLE_AUTH_START_PATH: &str = "/api/auth/google";
const DASHBOARD_GOOGLE_AUTH_CALLBACK_PATH: &str = "/api/auth/google/callback";
const GOOGLE_ACCOUNTS_HOST: &str = "accounts.google.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationAction {
    Allow,
    OpenExternal,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFlowTransition {
    None,
    Start,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NavigationDecision {
    pub action: NavigationAction,
    pub auth_transition: AuthFlowTransition,
}

/// 외부 HTTP(S) navigation인지 판단한다.
///
/// - scheme이 `http` 또는 `https`가 아니면 `false`를 반환한다(외부 분류 대상 아님).
/// - Tauri v2의 packaged app origin(`http://tauri.localhost`)은 내부 앱 URL로 취급한다.
/// - HTTP(S)이면서 `allowed_origins`의 어느 항목과도 origin이 일치하지 않으면 `true`다.
pub fn is_external_http(url: &Url, allowed_origins: &[Url]) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if is_tauri_app_url(url) {
        return false;
    }
    !allowed_origins
        .iter()
        .any(|allowed| same_origin(url, allowed))
}

/// main webview navigation을 어떻게 처리할지 판단한다.
///
/// Google dashboard login은 `/api/auth/google`에서 시작해 `accounts.google.com`을 거쳐
/// `/api/auth/google/callback`으로 돌아온다. 이 provider redirect까지 일반 외부 링크처럼
/// OS 브라우저로 보내면 JWT 쿠키가 app webview가 아닌 OS 브라우저에 저장되어 앱 로그인 완료가
/// 불가능해진다.
pub fn classify_navigation(
    url: &Url,
    allowed_origins: &[Url],
    auth_flow_active: bool,
) -> NavigationDecision {
    if is_tauri_app_url(url) {
        return allow(AuthFlowTransition::None);
    }
    if !matches!(url.scheme(), "http" | "https") {
        return block();
    }
    if is_dashboard_google_auth_start_url(url, allowed_origins) {
        return allow(AuthFlowTransition::Start);
    }
    if is_dashboard_google_auth_callback_url(url, allowed_origins) {
        return allow(AuthFlowTransition::Complete);
    }
    if auth_flow_active && is_google_oauth_provider_url(url) {
        return allow(AuthFlowTransition::None);
    }
    if auth_flow_active && is_dashboard_origin(url, allowed_origins) {
        // 사용자가 인증을 취소하고 dashboard 내부로 돌아온 경우 stale auth state를 남기지 않는다.
        return allow(AuthFlowTransition::Complete);
    }
    if is_external_http(url, allowed_origins) {
        return NavigationDecision {
            action: NavigationAction::OpenExternal,
            auth_transition: AuthFlowTransition::None,
        };
    }
    allow(AuthFlowTransition::None)
}

/// `target=_blank`/`window.open` URL을 OS 브라우저로 열어도 되는지 판단한다.
///
/// 기존 정책은 HTTP(S) new-window를 origin과 무관하게 OS 브라우저로 위임한다. 단, dashboard
/// Google auth URL과 진행 중인 Google OAuth provider URL은 앱 로그인 쿠키를 잃지 않도록
/// 외부 브라우저로 보내지 않는다.
pub fn should_open_new_window_in_external_browser(
    url: &Url,
    allowed_origins: &[Url],
    auth_flow_active: bool,
) -> bool {
    if !matches!(url.scheme(), "http" | "https") || is_tauri_app_url(url) {
        return false;
    }
    if is_dashboard_google_auth_start_url(url, allowed_origins)
        || is_dashboard_google_auth_callback_url(url, allowed_origins)
    {
        return false;
    }
    if auth_flow_active && is_google_oauth_provider_url(url) {
        return false;
    }
    true
}

/// Tauri가 번들 React app을 로드할 때 쓰는 내부 URL인지 판단한다.
///
/// Tauri v1/v2와 플랫폼 차이를 모두 허용하기 위해 legacy `tauri:` scheme과
/// v2 custom protocol host인 `tauri.localhost`를 함께 내부로 본다.
pub fn is_tauri_app_url(url: &Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

/// 두 URL의 origin이 동일한지 비교한다(scheme + host + port).
///
/// `port_or_known_default`를 사용하여 명시되지 않은 표준 포트(http:80, https:443)도 정합한다.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn allow(auth_transition: AuthFlowTransition) -> NavigationDecision {
    NavigationDecision {
        action: NavigationAction::Allow,
        auth_transition,
    }
}

fn block() -> NavigationDecision {
    NavigationDecision {
        action: NavigationAction::Block,
        auth_transition: AuthFlowTransition::None,
    }
}

fn is_dashboard_google_auth_start_url(url: &Url, allowed_origins: &[Url]) -> bool {
    is_dashboard_origin(url, allowed_origins) && matches_path(url, DASHBOARD_GOOGLE_AUTH_START_PATH)
}

fn is_dashboard_google_auth_callback_url(url: &Url, allowed_origins: &[Url]) -> bool {
    is_dashboard_origin(url, allowed_origins)
        && matches_path(url, DASHBOARD_GOOGLE_AUTH_CALLBACK_PATH)
}

fn is_dashboard_origin(url: &Url, allowed_origins: &[Url]) -> bool {
    allowed_origins
        .iter()
        .any(|allowed| same_origin(url, allowed))
}

fn is_google_oauth_provider_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(GOOGLE_ACCOUNTS_HOST)
}

fn matches_path(url: &Url, expected: &str) -> bool {
    let path = url.path();
    path == expected || path.strip_suffix('/') == Some(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test URL parse")
    }

    #[test]
    fn non_http_scheme_returns_false() {
        // about:blank, javascript:, mailto:, tel: 등은 외부 분류 대상 아님 — 호출자가 별도 처리.
        assert!(!is_external_http(&url("about:blank"), &[]));
        assert!(!is_external_http(&url("javascript:void(0)"), &[]));
        assert!(!is_external_http(&url("mailto:a@b.com"), &[]));
        assert!(!is_external_http(&url("tel:+82-10-0000-0000"), &[]));
    }

    #[test]
    fn tauri_app_urls_are_internal() {
        assert!(is_tauri_app_url(&url("tauri://localhost/index.html")));
        assert!(is_tauri_app_url(&url("http://tauri.localhost/")));
        assert!(is_tauri_app_url(&url(
            "https://tauri.localhost/assets/app.js"
        )));
        assert!(!is_tauri_app_url(&url("http://localhost:1420/")));
    }

    #[test]
    fn tauri_localhost_is_not_external_without_dashboard_origin() {
        assert!(!is_external_http(&url("http://tauri.localhost/"), &[]));
        assert!(!is_external_http(
            &url("http://tauri.localhost/assets/index.js"),
            &[]
        ));
    }

    #[test]
    fn empty_allowed_treats_all_http_as_external() {
        // dashboard origin 등록 전(setup 화면)에서는 앱 내부 origin을 제외한 HTTP(S)이 외부로 분류된다.
        assert!(is_external_http(&url("https://x.com/path"), &[]));
        assert!(is_external_http(&url("http://localhost:3000"), &[]));
    }

    #[test]
    fn same_origin_is_not_external() {
        let allowed = vec![url("https://soul.example.me")];
        assert!(!is_external_http(
            &url("https://soul.example.me/path?x=1"),
            &allowed
        ));
    }

    #[test]
    fn different_origin_is_external() {
        let allowed = vec![url("https://soul.example.me")];
        // dashboard origin 등록 후, 다른 host로의 navigation은 외부.
        // MarkdownContent/SessionMetadata의 target=_blank 외부 링크가 이 분기로 진입한다.
        assert!(is_external_http(&url("https://github.com/repo"), &allowed));
    }

    #[test]
    fn different_port_is_external() {
        let allowed = vec![url("https://soul.example.me")];
        // 명시된 다른 포트는 다른 origin.
        assert!(is_external_http(
            &url("https://soul.example.me:8443/"),
            &allowed
        ));
    }

    #[test]
    fn different_scheme_is_external() {
        let allowed = vec![url("https://soul.example.me")];
        // http vs https는 다른 origin.
        assert!(is_external_http(&url("http://soul.example.me/"), &allowed));
    }

    #[test]
    fn dashboard_google_auth_start_allows_navigation_and_marks_auth_flow() {
        let allowed = vec![url("https://soul.example.me")];

        let decision = classify_navigation(
            &url("https://soul.example.me/api/auth/google?return_to=%2Fsessions"),
            &allowed,
            false,
        );

        assert_eq!(decision.action, NavigationAction::Allow);
        assert_eq!(decision.auth_transition, AuthFlowTransition::Start);
    }

    #[test]
    fn google_oauth_provider_stays_internal_only_during_auth_flow() {
        let allowed = vec![url("https://soul.example.me")];
        let provider = url(
            "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fsoul.example.me%2Fapi%2Fauth%2Fgoogle%2Fcallback",
        );

        assert_eq!(
            classify_navigation(&provider, &allowed, false).action,
            NavigationAction::OpenExternal,
        );
        assert_eq!(
            classify_navigation(&provider, &allowed, true).action,
            NavigationAction::Allow,
        );
    }

    #[test]
    fn dashboard_google_auth_callback_allows_navigation_and_completes_auth_flow() {
        let allowed = vec![url("https://soul.example.me")];

        let decision = classify_navigation(
            &url("https://soul.example.me/api/auth/google/callback?code=abc&state=xyz"),
            &allowed,
            true,
        );

        assert_eq!(decision.action, NavigationAction::Allow);
        assert_eq!(decision.auth_transition, AuthFlowTransition::Complete);
    }

    #[test]
    fn same_origin_navigation_clears_stale_auth_flow_state() {
        let allowed = vec![url("https://soul.example.me")];

        let decision = classify_navigation(&url("https://soul.example.me/"), &allowed, true);

        assert_eq!(decision.action, NavigationAction::Allow);
        assert_eq!(decision.auth_transition, AuthFlowTransition::Complete);
    }

    #[test]
    fn new_window_routing_keeps_auth_urls_out_of_external_browser() {
        let allowed = vec![url("https://soul.example.me")];

        assert!(!should_open_new_window_in_external_browser(
            &url("https://soul.example.me/api/auth/google"),
            &allowed,
            false,
        ));
        assert!(!should_open_new_window_in_external_browser(
            &url("https://soul.example.me/api/auth/google/callback?code=abc&state=xyz"),
            &allowed,
            true,
        ));
        assert!(!should_open_new_window_in_external_browser(
            &url("https://accounts.google.com/signin/oauth"),
            &allowed,
            true,
        ));
        assert!(should_open_new_window_in_external_browser(
            &url("https://github.com/eiaserinnys/soulstream"),
            &allowed,
            true,
        ));
    }
}

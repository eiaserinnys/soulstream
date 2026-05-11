//! 외부 navigation 정책 가드.
//!
//! `is_external_http`는 webview의 navigation/new-window 핸들러가 호출하는 순수 함수다.
//! HTTP(S) scheme이면서 등록된 dashboard origin과 다른 origin인 경우 `true`를 반환한다.
//! 호출자가 `true`를 받으면 navigation을 취소하고 `open::that(url)`로 OS 기본 브라우저에
//! 위임한다. 비-HTTP(S) scheme(about/javascript/mailto/tel/blob 등)은 `false`로 분류되며,
//! 호출자는 별도 정책(`on_navigation`은 `tauri` scheme만 추가 허용, `on_new_window`는
//! 모두 `Deny`)으로 처리한다.

use url::Url;

/// 외부 HTTP(S) navigation인지 판단한다.
///
/// - scheme이 `http` 또는 `https`가 아니면 `false`를 반환한다(외부 분류 대상 아님).
/// - HTTP(S)이면서 `allowed_origins`의 어느 항목과도 origin이 일치하지 않으면 `true`다.
pub fn is_external_http(url: &Url, allowed_origins: &[Url]) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    !allowed_origins.iter().any(|allowed| same_origin(url, allowed))
}

/// 두 URL의 origin이 동일한지 비교한다(scheme + host + port).
///
/// `port_or_known_default`를 사용하여 명시되지 않은 표준 포트(http:80, https:443)도 정합한다.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
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
    fn empty_allowed_treats_all_http_as_external() {
        // dashboard origin 등록 전(setup 화면)에서는 모든 HTTP(S)이 외부로 분류된다.
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
}

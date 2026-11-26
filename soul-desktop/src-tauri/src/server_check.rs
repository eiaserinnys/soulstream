//! 서버 주소가 실제 소울스트림 orch 서버인지 확인한다.
//!
//! 웹뷰 `fetch`는 서버의 CORS 허용 목록에 앱 origin이 없으면 응답을 읽지 못하므로
//! 확인은 Rust에서 `GET /api/health`를 불러 한다.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use url::Url;

const HEALTH_PATH: &str = "/api/health";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerCheck {
    Ok,
    Unreachable,
    HttpStatus { status: u16 },
    NotSoulstream,
}

/// 주소의 origin 기준 상태 경로. 대시보드 origin 등록(`set_dashboard_origin`)과 같은 기준이다.
pub fn health_url(server_url: &str) -> Option<Url> {
    let mut url = Url::parse(server_url).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_path(HEALTH_PATH);
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// orch `GET /api/health`(`orch-server-ts/src/public/public_status_routes.ts`)의 응답 모양:
/// `{ "status": "ok", "version": "<문자열>", "uptime_seconds": <숫자>, ... }`.
/// 2xx이면서 이 세 칸이 맞아야 소울스트림 서버로 본다.
pub fn classify_health_response(status: u16, body: &[u8]) -> ServerCheck {
    if !(200..300).contains(&status) {
        return ServerCheck::HttpStatus { status };
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(json) if is_orch_health(&json) => ServerCheck::Ok,
        _ => ServerCheck::NotSoulstream,
    }
}

fn is_orch_health(json: &Value) -> bool {
    json.get("status").and_then(Value::as_str) == Some("ok")
        && json.get("version").is_some_and(Value::is_string)
        && json.get("uptime_seconds").is_some_and(Value::is_number)
}

/// reqwest의 rustls는 provider를 직접 고르지 않으므로(`rustls-no-provider`),
/// updater 플러그인과 같은 ring provider를 프로세스에 하나 등록해 둔다.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

async fn fetch_health(url: Url, timeout: Duration) -> Result<(u16, Vec<u8>), reqwest::Error> {
    ensure_crypto_provider();
    let client = reqwest::Client::builder().timeout(timeout).build()?;
    let response = client.get(url).send().await?;
    let status = response.status().as_u16();
    let body = response.bytes().await?;
    Ok((status, body.to_vec()))
}

/// frontend(`src/utils/url.ts`의 `checkReachability`)가 호출하는 command.
/// 연결, DNS, TLS, 시간 초과는 모두 `Unreachable`이다.
#[tauri::command]
pub async fn check_server(url: String, timeout_ms: u64) -> ServerCheck {
    let Some(health) = health_url(&url) else {
        return ServerCheck::Unreachable;
    };
    match fetch_health(health, Duration::from_millis(timeout_ms)).await {
        Ok((status, body)) => classify_health_response(status, &body),
        Err(_) => ServerCheck::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORCH_HEALTH: &str = r#"{"status":"ok","version":"0.1.0","healthy":true,"ready":true,"draining":false,"instance_id":"i","build_id":"b","process_build_id":"p","uptime_seconds":12}"#;

    #[test]
    fn orch_health_json_is_ok() {
        assert_eq!(
            classify_health_response(200, ORCH_HEALTH.as_bytes()),
            ServerCheck::Ok
        );
        assert_eq!(
            classify_health_response(
                200,
                br#"{"status":"ok","version":"0.1.0","uptime_seconds":0}"#
            ),
            ServerCheck::Ok
        );
    }

    #[test]
    fn non_2xx_is_http_status_with_code() {
        assert_eq!(
            classify_health_response(404, b"{}"),
            ServerCheck::HttpStatus { status: 404 }
        );
        assert_eq!(
            classify_health_response(502, b"<html>bad gateway</html>"),
            ServerCheck::HttpStatus { status: 502 }
        );
        assert_eq!(
            classify_health_response(500, ORCH_HEALTH.as_bytes()),
            ServerCheck::HttpStatus { status: 500 }
        );
    }

    #[test]
    fn two_xx_without_orch_health_json_is_not_soulstream() {
        let dashboard_html = b"<!doctype html><html><body>app</body></html>";
        assert_eq!(
            classify_health_response(200, dashboard_html),
            ServerCheck::NotSoulstream
        );
        assert_eq!(classify_health_response(200, b""), ServerCheck::NotSoulstream);
        assert_eq!(
            classify_health_response(200, br#"{"status":"ok"}"#),
            ServerCheck::NotSoulstream
        );
        assert_eq!(
            classify_health_response(
                200,
                br#"{"status":"error","version":"0.1.0","uptime_seconds":1}"#
            ),
            ServerCheck::NotSoulstream
        );
        assert_eq!(
            classify_health_response(
                200,
                br#"{"status":"ok","version":1,"uptime_seconds":"1"}"#
            ),
            ServerCheck::NotSoulstream
        );
        assert_eq!(classify_health_response(204, b""), ServerCheck::NotSoulstream);
    }

    #[test]
    fn health_url_uses_origin_and_keeps_port() {
        assert_eq!(
            health_url("http://127.0.0.1:4105").unwrap().as_str(),
            "http://127.0.0.1:4105/api/health"
        );
        assert_eq!(
            health_url("https://soul.example.com/dashboard/x?a=1#f")
                .unwrap()
                .as_str(),
            "https://soul.example.com/api/health"
        );
    }

    #[test]
    fn health_url_rejects_non_http_addresses() {
        assert!(health_url("ftp://soul.example.com").is_none());
        assert!(health_url("not a url").is_none());
        assert!(health_url("file:///etc/passwd").is_none());
    }

    fn serve_once(status_line: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}")
    }

    fn check(url: String) -> ServerCheck {
        tauri::async_runtime::block_on(check_server(url, 3000))
    }

    #[test]
    fn check_server_reaches_a_real_http_server() {
        assert_eq!(check(serve_once("200 OK", ORCH_HEALTH)), ServerCheck::Ok);
        assert_eq!(
            check(serve_once("404 Not Found", "{}")),
            ServerCheck::HttpStatus { status: 404 }
        );
        assert_eq!(
            check(serve_once("200 OK", "<html>dashboard</html>")),
            ServerCheck::NotSoulstream
        );
    }

    #[test]
    fn check_server_reports_unreachable_for_a_closed_port_and_bad_address() {
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        assert_eq!(check(closed), ServerCheck::Unreachable);
        assert_eq!(check("ftp://example.com".into()), ServerCheck::Unreachable);
    }

    #[test]
    fn serializes_with_kind_tag_for_the_frontend() {
        let json = |v: &ServerCheck| serde_json::to_string(v).unwrap();
        assert_eq!(json(&ServerCheck::Ok), r#"{"kind":"ok"}"#);
        assert_eq!(json(&ServerCheck::Unreachable), r#"{"kind":"unreachable"}"#);
        assert_eq!(
            json(&ServerCheck::HttpStatus { status: 404 }),
            r#"{"kind":"http_status","status":404}"#
        );
        assert_eq!(
            json(&ServerCheck::NotSoulstream),
            r#"{"kind":"not_soulstream"}"#
        );
    }
}

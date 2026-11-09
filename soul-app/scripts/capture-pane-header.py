#!/usr/bin/env python3
"""세션 대화 패널 머리 제목 위 여백 시각 검수 (카드 #1095).

무엇을 검수하나
---------------
- 듀오 안쪽 가로(951x669)·안쪽 세로(669x951) 카드 오버레이 대화 패널 머리
  (`tablet-chat-header`)의 높이가 72pt이고, 세션 이름 글자의 세로 가운데가
  머리 위 끝에서 36pt다.
- iPad split(`cardChecks` 1210x834)에서 사이드바·메인·피드·대화 머리가 한 줄에
  서고, 위 끝과 아래 끝이 1px 이내로 같다.
- 메인 목록 내용이 커진 머리 아래에서 시작한다.
- 페이지 오류가 없다.

실행 방법
---------
1. 번들을 만든다(heavy_verify runner 경유):
       node scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 사용자 site-packages의 Playwright로 실행한다:
       python3 -P soul-app/scripts/capture-pane-header.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/artifacts/card-1095-pane-header

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import BrowserContext, Page, sync_playwright

PREFIX = "/assets/ios-components/"

HEADER_MIN_HEIGHT = 72
TITLE_CENTER_FROM_TOP = 36
EDGE_TOLERANCE = 1

# (id, width, height)
DUO_FRAMES = [
    ("inner-landscape", 951, 669),
    ("inner-portrait", 669, 951),
]
IPAD_FRAME = ("ipad-landscape", 1210, 834)
THEMES = ["light", "dark"]

SHELL_HEADER_IDS = [
    "tablet-sidebar-header",
    "tablet-main-header",
    "tablet-feed-header",
]

MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {
      left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height),
    };
  };
  const byTestId = (testId) => document.querySelector(`[data-testid="${testId}"]`);
  const chatHeader = byTestId('tablet-chat-header');
  let chatTitle = null;
  if (chatHeader) {
    for (const element of chatHeader.querySelectorAll('div[dir="auto"]')) {
      const style = getComputedStyle(element);
      const text = (element.textContent || '').trim();
      if (!text) continue;
      if (style.fontFamily.includes('Ionicons')) continue;
      if (style.fontSize !== '20px') continue;
      chatTitle = element;
      break;
    }
  }
  const headers = {};
  for (const id of ['tablet-sidebar-header', 'tablet-main-header', 'tablet-feed-header',
                    'tablet-chat-header']) {
    headers[id] = box(byTestId(id));
  }
  const titleStyle = chatTitle ? getComputedStyle(chatTitle) : null;
  return {
    window: { width: innerWidth, height: innerHeight },
    safeFrame: box(byTestId('tablet-safe-area-frame')),
    headers,
    chatHeader: box(chatHeader),
    chatTitle: box(chatTitle),
    chatTitleText: chatTitle ? chatTitle.textContent.trim() : null,
    chatTitleStyle: titleStyle ? {
      fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight,
      fontWeight: titleStyle.fontWeight,
    } : null,
    boardFrame: box(byTestId('card-board-frame')),
  };
}
"""


class BundleServer:
    def __init__(self, bundle_root: Path):
        self.bundle_root = bundle_root.resolve()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def _handler(self):
        bundle_root = self.bundle_root

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - silence fixture server logs
                return

            def _send(self, status: int, body: bytes, content_type: str):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802 - http.server contract
                path = urlsplit(self.path).path
                if path == "/api/auth/status":
                    authenticated = "review=fixture" in (self.headers.get("Cookie") or "")
                    self._send(200, json.dumps({"authenticated": authenticated}).encode(), "application/json")
                    return
                if path.startswith("/api/"):
                    self._send(403, b"Unexpected API request", "text/plain")
                    return
                if not path.startswith(PREFIX):
                    self._send(404, b"", "text/plain")
                    return
                relative = path[len(PREFIX) - 1:]
                file = (bundle_root / relative.lstrip("/")).resolve()
                if bundle_root != file and bundle_root not in file.parents:
                    self._send(404, b"", "text/plain")
                    return
                if not file.is_file():
                    self._send(404, b"", "text/plain")
                    return
                content_type = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
                self._send(200, file.read_bytes(), content_type)

        return Handler

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def base(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"


class Checks:
    def __init__(self):
        self.entries: list[dict] = []

    def check(self, name: str, condition: bool, detail):
        self.entries.append({"name": name, "passed": bool(condition), "detail": detail})


def duo_url(base: str, frame_id: str, theme: str) -> str:
    query = f"section=iphoneDuo&sample=main-layout&frame={frame_id}&board=ops&overlay=card-with-chat&theme={theme}"
    return f"{base}{PREFIX}index.html?{query}"


def ipad_url(base: str, theme: str) -> str:
    query = f"section=cardChecks&safeArea=fixture&state=normal&theme={theme}"
    return f"{base}{PREFIX}index.html?{query}"


def open_page(context: BrowserContext, base: str) -> tuple[Page, list[str]]:
    page = context.new_page()
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", lambda route: route.continue_()
               if route.request.url.startswith(base) else route.abort())
    return page, errors


def settle(page: Page, test_id: str) -> None:
    try:
        page.get_by_test_id(test_id).wait_for(state="attached", timeout=20000)
    except Exception:  # noqa: BLE001 - 화면이 다르면 캡처는 계속한다
        pass
    page.evaluate("async () => { await document.fonts.ready; }")
    page.wait_for_timeout(900)


def measure(page: Page) -> dict:
    return page.evaluate(MEASURE_JS)


def shot(page: Page, out: Path, name: str, width: int, height: int) -> str:
    path = out / f"{name}.png"
    page.screenshot(path=str(path), clip={"x": 0, "y": 0, "width": width, "height": height})
    return str(path)


def title_center(metrics: dict) -> float | None:
    title = metrics["chatTitle"]
    return None if title is None else round((title["top"] + title["bottom"]) / 2, 2)


def check_chat_header(prefix: str, metrics: dict, checks: Checks) -> None:
    header = metrics["chatHeader"]
    checks.check(f"{prefix} 대화 머리 존재", header is not None, header)
    if header is None:
        return
    checks.check(f"{prefix} 대화 머리 높이 {HEADER_MIN_HEIGHT}",
                 abs(header["height"] - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE, header)
    center = title_center(metrics)
    checks.check(f"{prefix} 제목 가운데가 머리 위 끝에서 {TITLE_CENTER_FROM_TOP}",
                 center is not None
                 and abs((center - header["top"]) - TITLE_CENTER_FROM_TOP) <= EDGE_TOLERANCE,
                 {"headerTop": header["top"], "title": metrics["chatTitle"],
                  "titleCenter": center, "text": metrics["chatTitleText"],
                  "style": metrics["chatTitleStyle"]})


def check_header_row(prefix: str, metrics: dict, checks: Checks, required: list[str]) -> None:
    present = {name: metrics["headers"][name] for name in required}
    checks.check(f"{prefix} 나란한 머리 모두 존재",
                 all(box is not None for box in present.values()),
                 {name: box is not None for name, box in present.items()})
    boxes = [box for box in present.values() if box is not None]
    if len(boxes) < 2:
        return
    tops = [box["top"] for box in boxes]
    bottoms = [box["bottom"] for box in boxes]
    checks.check(f"{prefix} 머리 위 끝 정렬",
                 max(tops) - min(tops) <= EDGE_TOLERANCE,
                 {name: box["top"] for name, box in present.items() if box})
    checks.check(f"{prefix} 머리 아래 끝 정렬",
                 max(bottoms) - min(bottoms) <= EDGE_TOLERANCE,
                 {name: box["bottom"] for name, box in present.items() if box})


def capture_duo(context: BrowserContext, base: str, out: Path, frame_id: str,
                width: int, height: int, checks: Checks) -> dict:
    states: dict[str, dict] = {}
    for theme in THEMES:
        page, errors = open_page(context, base)
        url = duo_url(base, frame_id, theme)
        page.goto(url, wait_until="load")
        settle(page, "tablet-chat-header")
        metrics = measure(page)
        name = f"{frame_id}-{theme}"
        states[theme] = {"url": url, "screenshot": shot(page, out, name, width, height),
                         "metrics": metrics}
        check_chat_header(name, metrics, checks)
        checks.check(f"{name} 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def capture_ipad(context: BrowserContext, base: str, out: Path,
                 checks: Checks) -> dict:
    frame_id, width, height = IPAD_FRAME
    states: dict[str, dict] = {}
    for theme in THEMES:
        page, errors = open_page(context, base)
        url = ipad_url(base, theme)
        page.goto(url, wait_until="load")
        settle(page, "tablet-chat-header")
        metrics = measure(page)
        name = f"{frame_id}-{theme}"
        states[theme] = {"url": url, "screenshot": shot(page, out, name, width, height),
                         "metrics": metrics}
        check_chat_header(name, metrics, checks)
        check_header_row(name, metrics, checks,
                         ["tablet-sidebar-header", "tablet-main-header", "tablet-chat-header"])
        board = metrics["boardFrame"]
        header = metrics["chatHeader"]
        main_header = metrics["headers"]["tablet-main-header"]
        if board is not None and main_header is not None:
            checks.check(f"{name} 메인 목록 내용이 머리 아래에서 시작",
                         board["top"] >= main_header["bottom"] - EDGE_TOLERANCE,
                         {"boardTop": board["top"], "mainHeaderBottom": main_header["bottom"]})
        checks.check(f"{name} 머리 높이 {HEADER_MIN_HEIGHT} (메인)",
                     main_header is not None
                     and abs(main_header["height"] - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     main_header)
        checks.check(f"{name} 머리 높이 {HEADER_MIN_HEIGHT} (사이드바)",
                     metrics["headers"]["tablet-sidebar-header"] is not None
                     and abs(metrics["headers"]["tablet-sidebar-header"]["height"]
                             - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     metrics["headers"]["tablet-sidebar-header"])
        checks.check(f"{name} 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"passed": False, "errors": [], "warnings": []}
    checks = Checks()
    try:
        with BundleServer(bundle_root) as server:
            base = server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    result["frames"] = {}
                    for frame_id, width, height in DUO_FRAMES:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=2,
                        )
                        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                        result["frames"][frame_id] = capture_duo(
                            context, base, out, frame_id, width, height, checks)
                        context.close()
                    ipad_id, ipad_width, ipad_height = IPAD_FRAME
                    context = browser.new_context(
                        viewport={"width": ipad_width, "height": ipad_height},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                    result["frames"][ipad_id] = capture_ipad(context, base, out, checks)
                    context.close()
                finally:
                    browser.close()
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "pane-header.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "passed": result["passed"],
        "errors": result["errors"],
        "checks": len(result["checks"]),
        "failed": [entry["name"] for entry in result["checks"] if not entry["passed"]],
    }, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

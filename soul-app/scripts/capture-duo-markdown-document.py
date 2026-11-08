#!/usr/bin/env python3
"""듀오 펼침 마크다운 문서 열람 가로·세로 전체 폭 시각 검수.

무엇을 검수하나
---------------
- 아이폰 듀오 안쪽 세로(669x951)에서 문서 시트는 좌우 12pt 여백만 남기고 전체 폭을
  쓴다(645x845, top 94, right 657, bottom 939). 시트 안 헤더에 뒤로 버튼이 있고,
  뒤에 깔린 듀오 상단 띠(`duo-top-band`)는 문서가 떠 있는 동안 보이지 않는다.
- 아이폰 듀오 안쪽 가로(951x669)에서 문서 시트는 843x621(top 36, right 855, bottom 657)이고,
  뒤로 가기는 84pt 오른쪽 레일의 `duo-rail-action-back` 캡슐 하나로만 제공된다.
  시트 안에는 뒤로 버튼이 없다.
- 짧은 프레임(626x890, 890x626)에서도 폭은 각각 602, 782로 같은 여백 규칙을 따른다.
- 불러오는 중(`documentState=loading`)에도 시트는 전체 폭을 유지하고
  `markdown-document-loading`이 시트 안에 있다.
- 뒤로 가기 뒤에는 문서 시트가 사라지고 보드가 다시 보인다(세로는 상단 띠도 돌아온다).
- 회귀 기준: iPad Pro 13 세로(1032x1376) 문서 시트는 기존 반쪽 폭 460을 유지한다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 리포 루트에서 이 스크립트를 실행한다(사용자 site-packages의 Playwright 사용):
       python3 -P soul-app/scripts/capture-duo-markdown-document.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/artifacts/card-1094-visual

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`, iphoneDuo 문서 fixture)만 흉내 낸다.
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

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

PREFIX = "/assets/ios-components/"
OUTER_INSET = 12

# (frame id, width, height, expected sheet rect)
DUO_FRAMES = [
    ("inner-portrait", 669, 951,
     {"left": 12, "top": 94, "right": 657, "bottom": 939, "width": 645, "height": 845}),
    ("inner-landscape", 951, 669,
     {"left": 12, "top": 36, "right": 855, "bottom": 657, "width": 843, "height": 621}),
    ("inner-portrait-short", 626, 890,
     {"left": 12, "top": 94, "right": 614, "bottom": 878, "width": 602, "height": 784}),
    ("inner-landscape-short", 890, 626,
     {"left": 12, "top": 36, "right": 794, "bottom": 614, "width": 782, "height": 578}),
]
IPAD_FRAME = ("ipad-pro-13-portrait", 1032, 1376,
              {"left": 560, "top": 36, "right": 1020, "bottom": 1364, "width": 460, "height": 1328})
LOADING_FRAME = ("inner-portrait", 669, 951, DUO_FRAMES[0][3])

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
  const sheet = byTestId('persistent-tablet-document-sheet');
  const title = byTestId('markdown-document-title');
  const body = byTestId('markdown-document-body');
  const railHost = byTestId('duo-rail-override-host');
  return {
    window: { width: innerWidth, height: innerHeight },
    sheetCount: document.querySelectorAll('[data-testid="persistent-tablet-document-sheet"]').length,
    sheet: box(sheet),
    sheetBackButtons: sheet ? [...sheet.querySelectorAll('[aria-label="뒤로"]')].map(box) : [],
    railHost: box(railHost),
    railBack: box(byTestId('duo-rail-action-back')),
    railBackCount: document.querySelectorAll('[data-testid="duo-rail-action-back"]').length,
    topBandCount: document.querySelectorAll('[data-testid="duo-top-band"]').length,
    topBand: box(byTestId('duo-top-band')),
    title: title ? (title.textContent || '').trim() : null,
    titleBox: box(title),
    bodyBox: box(body),
    bodyTextLength: body ? (body.textContent || '').trim().length : 0,
    loadingBox: box(byTestId('markdown-document-loading')),
    board: box(byTestId('card-board-frame')),
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
        entry = {"name": name, "passed": bool(condition), "detail": detail}
        self.entries.append(entry)
        if not condition:
            raise AssertionError(f"{name}: {detail}")


def page_url(base: str, frame_id: str, extra: str = "") -> str:
    query = f"section=iphoneDuo&sample=main-layout&frame={frame_id}&board=ops&doc=1"
    if extra:
        query += f"&{extra}"
    return f"{base}{PREFIX}index.html?{query}"


def settle(page: Page, test_id: str | None = None) -> None:
    if test_id:
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


def open_document(context: BrowserContext, base: str, frame_id: str, extra: str,
                  ready_test_id: str, errors: list[str]) -> Page:
    page = context.new_page()
    page.set_default_timeout(20000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", lambda route: route.continue_()
               if route.request.url.startswith(base) else route.abort())
    page.goto(page_url(base, frame_id, extra), wait_until="load")
    settle(page, ready_test_id)
    return page


def new_context(browser: Browser, base: str, width: int, height: int) -> BrowserContext:
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=2,
    )
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    return context


def assert_sheet_rect(checks: Checks, label: str, metrics: dict, expected: dict) -> None:
    sheet = metrics["sheet"]
    checks.check(f"{label} 문서 시트가 하나", metrics["sheetCount"] == 1 and sheet is not None,
                 {"sheetCount": metrics["sheetCount"], "sheet": sheet})
    position = {key: sheet[key] for key in ("left", "top", "right", "bottom")}
    deltas = {key: round(sheet[key] - expected[key], 2) for key in position}
    checks.check(f"{label} 문서 시트 위치 {expected['left']}/{expected['top']}/{expected['right']}/{expected['bottom']}",
                 all(abs(delta) <= 1 for delta in deltas.values()),
                 {"position": position, "expected": {key: expected[key] for key in position}, "deltas": deltas})
    size = {key: sheet[key] for key in ("width", "height")}
    checks.check(f"{label} 문서 시트 크기 {expected['width']}x{expected['height']}",
                 abs(sheet["width"] - expected["width"]) <= 1
                 and abs(sheet["height"] - expected["height"]) <= 1,
                 {"size": size, "expected": {"width": expected["width"], "height": expected["height"]}})


def capture_duo_frame(browser: Browser, base: str, out: Path, frame_id: str, width: int, height: int,
                      expected: dict, checks: Checks) -> dict:
    context = new_context(browser, base, width, height)
    errors: list[str] = []
    page = open_document(context, base, frame_id, "", "markdown-document-title", errors)
    metrics = measure(page)
    screenshot = shot(page, out, f"{frame_id}-markdown-ready", width, height)
    portrait = frame_id.startswith("inner-portrait")
    assert_sheet_rect(checks, frame_id, metrics, expected)
    checks.check(f"{frame_id} 문서 제목 렌더", metrics["title"] is not None
                 and metrics["title"].startswith("#270"), metrics["title"])
    checks.check(f"{frame_id} 문서 본문 렌더", metrics["bodyBox"] is not None
                 and metrics["bodyTextLength"] > 0,
                 {"bodyBox": metrics["bodyBox"], "length": metrics["bodyTextLength"]})
    checks.check(f"{frame_id} 불러오는 표시 없음", metrics["loadingBox"] is None, metrics["loadingBox"])
    if portrait:
        checks.check(f"{frame_id} 시트 안 뒤로 버튼 하나", len(metrics["sheetBackButtons"]) == 1,
                     metrics["sheetBackButtons"])
        checks.check(f"{frame_id} 레일 뒤로 캡슐 없음", metrics["railBackCount"] == 0,
                     metrics["railBackCount"])
        checks.check(f"{frame_id} 뒤에 깔린 상단 띠 숨김", metrics["topBandCount"] == 0,
                     {"topBandCount": metrics["topBandCount"], "topBand": metrics["topBand"]})
    else:
        checks.check(f"{frame_id} 레일 뒤로 캡슐 하나", metrics["railBackCount"] == 1
                     and metrics["railBack"] is not None, metrics["railBack"])
        checks.check(f"{frame_id} 레일 폭 84",
                     metrics["railHost"] is not None
                     and abs(metrics["railHost"]["width"] - 84) <= 1,
                     metrics["railHost"])
        checks.check(f"{frame_id} 레일 안 뒤로 캡슐",
                     metrics["railBack"] is not None and metrics["railHost"] is not None
                     and metrics["railBack"]["left"] >= metrics["railHost"]["left"] - 0.5,
                     {"railBack": metrics["railBack"], "railHost": metrics["railHost"]})
        checks.check(f"{frame_id} 시트 안 뒤로 버튼 없음", len(metrics["sheetBackButtons"]) == 0,
                     metrics["sheetBackButtons"])

    # 뒤로 가기 → 문서가 닫히고 보드가 다시 보인다.
    if portrait:
        page.locator('[data-testid="persistent-tablet-document-sheet"] [aria-label="뒤로"]').first.click()
    else:
        page.get_by_test_id("duo-rail-action-back").click()
    page.get_by_test_id("persistent-tablet-document-sheet").wait_for(state="detached", timeout=10000)
    settle(page, "card-board-frame")
    after = measure(page)
    after_shot = shot(page, out, f"{frame_id}-markdown-back", width, height)
    checks.check(f"{frame_id} 뒤로 가기 뒤 문서 시트 사라짐", after["sheetCount"] == 0,
                 after["sheetCount"])
    checks.check(f"{frame_id} 뒤로 가기 뒤 보드 복귀", after["board"] is not None, after["board"])
    if portrait:
        checks.check(f"{frame_id} 뒤로 가기 뒤 상단 띠 복귀", after["topBandCount"] == 1,
                     {"topBandCount": after["topBandCount"], "topBand": after["topBand"]})
    checks.check(f"{frame_id} 페이지 오류 없음", not errors, errors)
    page.close()
    context.close()
    return {"url": page_url(base, frame_id), "screenshot": screenshot,
            "backScreenshot": after_shot, "metrics": metrics, "afterBack": after}


def capture_loading(browser: Browser, base: str, out: Path, checks: Checks) -> dict:
    frame_id, width, height, expected = LOADING_FRAME
    context = new_context(browser, base, width, height)
    errors: list[str] = []
    page = open_document(context, base, frame_id, "documentState=loading", "markdown-document-loading", errors)
    metrics = measure(page)
    screenshot = shot(page, out, f"{frame_id}-markdown-loading", width, height)
    assert_sheet_rect(checks, "loading", metrics, expected)
    checks.check("loading 문서 로딩 표시가 시트 안",
                 metrics["loadingBox"] is not None, metrics["loadingBox"])
    checks.check("loading 제목은 아직 없음", metrics["title"] is None, metrics["title"])
    checks.check("loading 뒤에 깔린 상단 띠 숨김", metrics["topBandCount"] == 0,
                 {"topBandCount": metrics["topBandCount"], "topBand": metrics["topBand"]})
    checks.check("loading 페이지 오류 없음", not errors, errors)
    page.close()
    context.close()
    return {"url": page_url(base, frame_id, "documentState=loading"), "screenshot": screenshot,
            "metrics": metrics}


def capture_ipad_regression(browser: Browser, base: str, out: Path, checks: Checks) -> dict:
    frame_id, width, height, expected = IPAD_FRAME
    context = new_context(browser, base, width, height)
    errors: list[str] = []
    page = open_document(context, base, frame_id, "", "markdown-document-title", errors)
    metrics = measure(page)
    screenshot = shot(page, out, f"{frame_id}-markdown-ready", width, height)
    assert_sheet_rect(checks, frame_id, metrics, expected)
    checks.check(f"{frame_id} 문서 시트 폭 460 유지",
                 metrics["sheet"] is not None and abs(metrics["sheet"]["width"] - 460) <= 1,
                 metrics["sheet"])
    checks.check(f"{frame_id} 시트 안 뒤로 버튼 하나", len(metrics["sheetBackButtons"]) == 1,
                 metrics["sheetBackButtons"])
    checks.check(f"{frame_id} 문서 제목 렌더", metrics["title"] is not None
                 and metrics["title"].startswith("#270"), metrics["title"])
    checks.check(f"{frame_id} 페이지 오류 없음", not errors, errors)
    page.close()
    context.close()
    return {"url": page_url(base, frame_id), "screenshot": screenshot, "metrics": metrics}


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
                    for frame_id, width, height, expected in DUO_FRAMES:
                        result["frames"][frame_id] = capture_duo_frame(
                            browser, base, out, frame_id, width, height, expected, checks)
                    result["loading"] = capture_loading(browser, base, out, checks)
                    result["regression"] = capture_ipad_regression(browser, base, out, checks)
                finally:
                    browser.close()
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except AssertionError as error:
        result["errors"].append(str(error))
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "report.json").write_text(
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

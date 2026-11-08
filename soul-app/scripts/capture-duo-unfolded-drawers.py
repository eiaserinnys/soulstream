#!/usr/bin/env python3
"""듀오 펼침 기본 보드 전체 폭과 폴더·피드 서랍 여닫기 시각 검수.

무엇을 검수하나
---------------
- 안쪽 세로(669x951)·안쪽 가로(951x669) 듀오에서 기본 화면은 카드 보드가 전체 폭을
  쓰고(`split-panel-main` 645pt / 843pt) 스플리터와 상시 피드 열이 없다.
- `duo-main-menu`(폴더)와 `duo-main-feed`(피드) 단추가 280pt/360pt 서랍을 슬라이드로
  열고, 같은 단추·바깥 어두운 배경(`duo-drawer-backdrop`)으로 닫힌다.
- 프로젝트 카드 보드(`project-view=board`)도 같은 전체 폭을 쓴다.
- 회귀 기준: 바깥 세로(466x678)와 iPad Pro 13 세로(1032x1376) 기본 화면은 그대로다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 리포 루트에서 이 스크립트를 실행한다(사용자 site-packages의 Playwright 사용):
       python3 -P soul-app/scripts/capture-duo-unfolded-drawers.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/artifacts/card-1089-visual

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

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

PREFIX = "/assets/ios-components/"

# (id, width, height)
DUO_FRAMES = [
    ("inner-portrait", 669, 951),
    ("inner-landscape", 951, 669),
]
REGRESSION_FRAMES = [
    ("outer-portrait", 466, 678),
    ("ipad-pro-13-portrait", 1032, 1376),
]

DRAWER_WIDTH = 280
FEED_DRAWER_WIDTH = 360
OUTER_INSET = 12
CLOSED_SHADOW_MARGIN = 24
ANIM_SETTLE_MS = 450

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
  const pointerEvents = (element) => element ? getComputedStyle(element).pointerEvents : null;
  const label = (element) => element ? element.getAttribute('aria-label') : null;
  const iconColor = (element) => {
    const icon = element ? element.querySelector('div[dir="auto"]') : null;
    return icon ? getComputedStyle(icon).color : null;
  };
  const folderDrawer = byTestId('duo-folder-drawer');
  const feedDrawer = byTestId('duo-feed-drawer');
  return {
    window: { width: innerWidth, height: innerHeight },
    safeFrame: box(byTestId('tablet-safe-area-frame')),
    main: box(byTestId('split-panel-main')),
    splitter: box(byTestId('splitter-touch-zone')) || box(byTestId('splitter')),
    sessions: [...document.querySelectorAll('[data-testid="split-panel-session"]')].map(box),
    folderDrawer: box(folderDrawer),
    folderDrawerPointerEvents: pointerEvents(folderDrawer),
    feedDrawer: box(feedDrawer),
    feedDrawerPointerEvents: pointerEvents(feedDrawer),
    backdrop: box(byTestId('duo-drawer-backdrop')),
    backdropPointerEvents: pointerEvents(byTestId('duo-drawer-backdrop')),
    menuButton: box(byTestId('duo-main-menu')),
    menuLabel: label(byTestId('duo-main-menu')),
    menuIconColor: iconColor(byTestId('duo-main-menu')),
    feedButton: box(byTestId('duo-main-feed')),
    feedLabel: label(byTestId('duo-main-feed')),
    feedIconColor: iconColor(byTestId('duo-main-feed')),
    topBand: box(byTestId('duo-top-band')),
    navigationCapsule: box(byTestId('duo-top-band-navigation-capsule'))
      || box(byTestId('duo-main-navigation-capsule')),
    boardFrame: box(byTestId('card-board-frame')),
    feedHeader: box(byTestId('tablet-feed-header')),
    phoneRailItems: [...document.querySelectorAll('[data-testid^="phone-tab-"], [data-testid^="phone-rail-"]')]
      .map((element) => ({ testId: element.dataset.testid, ...box(element) })),
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
    query = f"section=iphoneDuo&sample=main-layout&frame={frame_id}&board=ops"
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


def content_edges(frame_id: str, width: int) -> tuple[float, float]:
    """SafeAreaView(가로 안전 영역) + TabletSafeAreaFrame 12pt 여백 뒤의 실제 행 경계."""
    right_inset = 84 if frame_id == "inner-landscape" else 0
    return float(OUTER_INSET), float(width - right_inset - OUTER_INSET)


def capture_duo_frame(context: BrowserContext, base: str, out: Path, frame_id: str, width: int, height: int,
                      checks: Checks) -> dict:
    page = context.new_page()
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", lambda route: route.continue_()
               if route.request.url.startswith(base) else route.abort())

    left, right = content_edges(frame_id, width)
    states: dict[str, dict] = {}

    # a) 기본: 보드 전체 폭, 서랍·스플리터 없음.
    url = page_url(base, frame_id)
    page.goto(url, wait_until="load")
    settle(page, "card-board-frame")
    metrics = measure(page)
    states["default"] = {"url": url, "screenshot": shot(page, out, f"default-{frame_id}", width, height),
                         "metrics": metrics}
    checks.check(f"{frame_id} 기본 splitter 없음", metrics["splitter"] is None, metrics["splitter"])
    checks.check(f"{frame_id} 기본 보드 전체 폭",
                 metrics["main"] is not None and abs(metrics["main"]["width"] - (right - left)) <= 1.5,
                 {"main": metrics["main"], "expected": right - left})
    checks.check(f"{frame_id} 기본 폴더 서랍 닫힘",
                 metrics["folderDrawer"] is not None and metrics["folderDrawer"]["right"] <= left + 0.5,
                 metrics["folderDrawer"])
    checks.check(f"{frame_id} 기본 피드 서랍 닫힘",
                 metrics["feedDrawer"] is not None and metrics["feedDrawer"]["left"] >= right - 0.5,
                 metrics["feedDrawer"])

    # b) 폴더 서랍: 열림 → 같은 단추로 닫힘.
    page.get_by_test_id("duo-main-menu").click()
    page.wait_for_timeout(ANIM_SETTLE_MS)
    folder_metrics = measure(page)
    states["folder-open"] = {"screenshot": shot(page, out, f"folder-open-{frame_id}", width, height),
                             "metrics": folder_metrics}
    checks.check(f"{frame_id} 폴더 서랍 폭 280",
                 folder_metrics["folderDrawer"] is not None
                 and abs(folder_metrics["folderDrawer"]["width"] - DRAWER_WIDTH) <= 1,
                 folder_metrics["folderDrawer"])
    checks.check(f"{frame_id} 폴더 서랍이 콘텐츠 왼쪽에서 열림",
                 folder_metrics["folderDrawer"] is not None
                 and abs(folder_metrics["folderDrawer"]["left"] - left) <= 1,
                 folder_metrics["folderDrawer"])
    checks.check(f"{frame_id} 폴더 단추 선택 표시",
                 folder_metrics["menuLabel"] == "폴더 닫기"
                 and folder_metrics["menuIconColor"] != metrics["menuIconColor"],
                 {"label": folder_metrics["menuLabel"], "color": folder_metrics["menuIconColor"],
                  "closedColor": metrics["menuIconColor"]})
    page.get_by_test_id("duo-main-menu").click()
    page.wait_for_timeout(ANIM_SETTLE_MS)
    closed_metrics = measure(page)
    checks.check(f"{frame_id} 같은 단추로 폴더 서랍 닫힘",
                 closed_metrics["folderDrawer"] is not None
                 and closed_metrics["folderDrawer"]["right"] <= left + 0.5,
                 closed_metrics["folderDrawer"])

    # c) 피드 서랍: 열림 → 바깥 어두운 배경 탭으로 닫힘.
    page.get_by_test_id("duo-main-feed").click()
    page.wait_for_timeout(ANIM_SETTLE_MS)
    feed_metrics = measure(page)
    states["feed-open"] = {"screenshot": shot(page, out, f"feed-open-{frame_id}", width, height),
                           "metrics": feed_metrics}
    checks.check(f"{frame_id} 피드 서랍 폭 360",
                 feed_metrics["feedDrawer"] is not None
                 and abs(feed_metrics["feedDrawer"]["width"] - FEED_DRAWER_WIDTH) <= 1,
                 feed_metrics["feedDrawer"])
    checks.check(f"{frame_id} 피드 서랍이 콘텐츠 오른쪽에서 열림",
                 feed_metrics["feedDrawer"] is not None
                 and abs(feed_metrics["feedDrawer"]["right"] - right) <= 1,
                 feed_metrics["feedDrawer"])
    checks.check(f"{frame_id} 피드 단추 선택 표시",
                 feed_metrics["feedLabel"] == "피드 닫기"
                 and feed_metrics["feedIconColor"] != metrics["feedIconColor"],
                 {"label": feed_metrics["feedLabel"], "color": feed_metrics["feedIconColor"],
                  "closedColor": metrics["feedIconColor"]})
    checks.check(f"{frame_id} 열린 피드 서랍의 배경이 입력을 받음",
                 feed_metrics["backdropPointerEvents"] == "auto",
                 feed_metrics["backdropPointerEvents"])
    page.mouse.click(left + 40, height / 2)
    page.wait_for_timeout(ANIM_SETTLE_MS)
    after_backdrop = measure(page)
    checks.check(f"{frame_id} 배경 탭으로 피드 서랍 닫힘",
                 after_backdrop["feedDrawer"] is not None
                 and after_backdrop["feedDrawer"]["left"] >= right - 0.5,
                 after_backdrop["feedDrawer"])

    # d) 프로젝트 카드 보드도 같은 전체 폭.
    project_url = page_url(base, frame_id, "project-view=board")
    page.goto(project_url, wait_until="load")
    settle(page, "card-board-frame")
    project_metrics = measure(page)
    states["project-board"] = {"url": project_url,
                               "screenshot": shot(page, out, f"project-board-{frame_id}", width, height),
                               "metrics": project_metrics}
    checks.check(f"{frame_id} 프로젝트 보드 전체 폭",
                 project_metrics["main"] is not None
                 and abs(project_metrics["main"]["width"] - (right - left)) <= 1.5,
                 {"main": project_metrics["main"], "expected": right - left})
    checks.check(f"{frame_id} 프로젝트 보드에도 스플리터 없음",
                 project_metrics["splitter"] is None, project_metrics["splitter"])

    checks.check(f"{frame_id} 페이지 오류 없음", not errors, errors)
    page.close()
    return states


def capture_regression_frames(browser: Browser, base: str, out: Path,
                              checks: Checks) -> dict:
    frames: dict[str, dict] = {}
    for frame_id, width, height in REGRESSION_FRAMES:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=2,
        )
        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
        page = context.new_page()
        page.set_default_timeout(20000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/*", lambda route: route.continue_()
                   if route.request.url.startswith(base) else route.abort())
        url = page_url(base, frame_id)
        page.goto(url, wait_until="load")
        settle(page, "card-board-frame")
        metrics = measure(page)
        frames[frame_id] = {"url": url, "screenshot": shot(page, out, f"default-{frame_id}", width, height),
                            "metrics": metrics}
        if frame_id.startswith("outer-"):
            checks.check("바깥 세로 레일 유지", len(metrics["phoneRailItems"]) > 0,
                         [item["testId"] for item in metrics["phoneRailItems"]])
        else:
            checks.check("iPad Pro 13 세로 2-pane 유지",
                         metrics["splitter"] is not None and len(metrics["sessions"]) == 1,
                         {"splitter": metrics["splitter"], "sessions": metrics["sessions"]})
            checks.check("iPad Pro 13 세로 기본 보드 폭 기록",
                         metrics["main"] is not None and metrics["main"]["width"] > 0,
                         metrics["main"])
        checks.check(f"{frame_id} 페이지 오류 없음", not errors, errors)
        page.close()
        context.close()
    return frames


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
                        result["frames"][frame_id] = capture_duo_frame(
                            context, base, out, frame_id, width, height, checks)
                        context.close()
                    result["regression"] = capture_regression_frames(
                        browser, base, out, checks)
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
        (out / "duo-unfolded-drawers.json").write_text(
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

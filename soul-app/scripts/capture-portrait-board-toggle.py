#!/usr/bin/env python3
"""iPad 세로 폴더의 기존 보기/카드 보드 전환과 보드 메뉴 시각 검수 (카드 #1120).

무엇을 검수하나
---------------
- iPad 세로(834x1210, TwoPaneWithDrawer)에서 서랍으로 프로젝트 폴더를 열면 목록 칸
  머리 아래에 「기존 보기 / 카드 보드」 전환 줄이 있고, 눌러 두 보기를 오간다.
- 세로 카드 보기에서 머리의 「보드 메뉴」(...)를 누르면 드래프트 카드 추가,
  완료·취소 숨김, 보드 확대가 나오고, 드래프트 카드 추가를 누르면 카드 제목 입력이 열린다.
- iPad 가로(1210x834, ThreePaneLayout)의 전환 줄과 단독 보드 단추, 듀오 안쪽 세로 화면은
  변경 전후가 같다.
- 목록 칸 머리(tablet-main-header)와 피드 머리(tablet-feed-header)의 높이, 전환 줄과
  머리의 좌우 끝 좌표, 머리 안 버튼 목록, 검색창 폭, 페이지 오류를 JSON으로 남긴다.

실행 방법
---------
1. 번들을 만든다(heavy_verify runner 경유):
       node scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 사용자 site-packages의 Playwright로 실행한다:
       python3 -P soul-app/scripts/capture-portrait-board-toggle.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/artifacts/card-1120/after

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
변경 전 번들(origin/main)에 돌리면 세로 전환 줄 검사가 실패하는 것이 정상이다.
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
PORTRAIT = ("ipad-portrait", 834, 1210)
LANDSCAPE = ("ipad-landscape", 1210, 834)
THEMES = ("light", "dark")
DUO_QUERY = ("section=iphoneDuo&sample=main-layout&frame=inner-portrait"
             "&board=ops&overlay=card-with-chat&theme=light")
EDGE_TOLERANCE = 1

BOARD_LABELS = ["드래프트 카드 추가", "완료·취소 숨김", "보드 확대"]

MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {
      left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(element).display !== 'none',
    };
  };
  const byTestId = (testId) => document.querySelector(`[data-testid="${testId}"]`);
  const header = byTestId('tablet-main-header');
  const buttons = [];
  if (header) {
    for (const button of header.querySelectorAll('[role="button"], button')) {
      buttons.push({
        label: button.getAttribute('aria-label'),
        testId: button.getAttribute('data-testid'),
        box: box(button),
      });
    }
  }
  const segmentOption = byTestId('settings-segment-tablet-card-view-existing');
  const visibleCount = (root, label) => [...(root ? root.querySelectorAll(`[aria-label="${label}"]`) : [])]
    .filter((element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
  const labelCounts = {};
  const headerLabelCounts = {};
  for (const label of LABELS_PLACEHOLDER) {
    labelCounts[label] = visibleCount(document, label);
    headerLabelCounts[label] = visibleCount(header, label);
  }
  const titleInput = [...document.querySelectorAll('[aria-label="카드 제목"]')]
    .find((element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || null;
  return {
    window: { width: innerWidth, height: innerHeight },
    mainHeader: box(header),
    feedHeader: box(byTestId('tablet-feed-header')),
    mainTitle: box(byTestId('tablet-main-title')),
    searchInput: box(byTestId('session-search-input')),
    toggleTrack: box(segmentOption ? segmentOption.parentElement : null),
    toggleExisting: box(byTestId('settings-segment-tablet-card-view-existing')),
    toggleBoard: box(byTestId('settings-segment-tablet-card-view-board')),
    boardFrame: box(byTestId('card-board-frame')),
    boardOverflowButton: box(byTestId('board-header-overflow-button')),
    boardOverflowMenu: box(byTestId('board-header-overflow-menu')),
    cardTitleInput: box(titleInput),
    buttons,
    labelCounts,
    headerLabelCounts,
  };
}
""".replace("LABELS_PLACEHOLDER", json.dumps(BOARD_LABELS, ensure_ascii=False))


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


def entry_url(base: str, theme: str) -> str:
    query = f"section=entryShell&safeArea=fixture&theme={theme}"
    return f"{base}{PREFIX}index.html?{query}"


def duo_url(base: str) -> str:
    return f"{base}{PREFIX}index.html?{DUO_QUERY}"


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


def open_folder(page: Page, width: int) -> list[str]:
    """entryShell에서 서랍 또는 사이드바를 거쳐 첫 공개 예 폴더를 연다."""
    notes: list[str] = []
    side = page.evaluate("""() => {
      const element = document.querySelector('[data-testid="sidebar-main-list"]');
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    }""")
    if not side or side["width"] == 0 or side["left"] < 0 or side["right"] > width:
        try:
            page.get_by_label("메뉴", exact=True).first.click(timeout=8000)
            page.wait_for_timeout(900)
        except Exception as error:  # noqa: BLE001 - 아래 폴더 열기가 실패를 드러낸다
            notes.append(f"menu: {error}")
    try:
        page.get_by_test_id("sidebar-main-list").get_by_text("공개 예", exact=False).first.click(timeout=8000)
        page.get_by_test_id("task-workspace-tablet-header").wait_for(state="visible", timeout=8000)
    except Exception as error:  # noqa: BLE001
        notes.append(f"folder: {error}")
    page.wait_for_timeout(1500)
    return notes


def visible_label_count(metrics: dict, label: str, scope: str = "labelCounts") -> int:
    return int(metrics[scope].get(label, 0))


def check_header_row(prefix: str, metrics: dict, checks: Checks) -> None:
    # 머리 높이의 정합은 카드 #1095/#1118 담당 범위다. 여기서는 높이를 기록만 하고
    # 이 작업이 만드는 전환 줄과 보드 메뉴 동작만 판정한다.
    main_header = metrics["mainHeader"]
    feed_header = metrics["feedHeader"]
    checks.check(f"{prefix} 목록 칸 머리 존재", main_header is not None, main_header)
    checks.check(f"{prefix} 피드 머리 존재", feed_header is not None, feed_header)


def check_toggle(prefix: str, metrics: dict, checks: Checks) -> None:
    track = metrics["toggleTrack"]
    checks.check(f"{prefix} 기존 보기/카드 보드 전환 줄 보임",
                 track is not None and track["visible"],
                 {"track": track, "existing": metrics["toggleExisting"],
                  "board": metrics["toggleBoard"]})
    checks.check(f"{prefix} 전환 줄 두 옵션 존재",
                 metrics["toggleExisting"] is not None and metrics["toggleBoard"] is not None,
                 {"existing": metrics["toggleExisting"], "board": metrics["toggleBoard"]})


def check_search(prefix: str, metrics: dict, checks: Checks) -> None:
    search = metrics["searchInput"]
    checks.check(f"{prefix} 머리 검색창 존재", search is not None and search["visible"], search)


def check_board_actions(prefix: str, metrics: dict, checks: Checks) -> None:
    checks.check(f"{prefix} 보드 본문 표시",
                 metrics["boardFrame"] is not None and metrics["boardFrame"]["visible"],
                 metrics["boardFrame"])
    overflow = metrics["boardOverflowButton"]
    checks.check(f"{prefix} 보드 메뉴 단추 보임",
                 overflow is not None and overflow["visible"], overflow)
    checks.check(f"{prefix} 보드 메뉴 닫힌 채 시작",
                 metrics["boardOverflowMenu"] is None, metrics["boardOverflowMenu"])
    standalone = {label: visible_label_count(metrics, label, "headerLabelCounts")
                  for label in BOARD_LABELS}
    checks.check(f"{prefix} 머리에 단독 보드 단추 없음",
                 all(count == 0 for count in standalone.values()), standalone)


def check_overflow_menu(prefix: str, metrics: dict, checks: Checks) -> None:
    menu = metrics["boardOverflowMenu"]
    checks.check(f"{prefix} 보드 메뉴 열림", menu is not None and menu["visible"], menu)
    counts = {label: visible_label_count(metrics, label) for label in BOARD_LABELS}
    checks.check(f"{prefix} 보드 메뉴 세 항목", all(count == 1 for count in counts.values()), counts)


def check_card_create(prefix: str, metrics: dict, checks: Checks) -> None:
    title_input = metrics["cardTitleInput"]
    checks.check(f"{prefix} 드래프트 카드 추가로 카드 제목 입력 열림",
                 title_input is not None and title_input["visible"], title_input)


def capture_portrait(context: BrowserContext, base: str, out: Path, frame_id: str,
                     width: int, height: int, checks: Checks) -> dict:
    states: dict[str, dict] = {}
    for theme in THEMES:
        page, errors = open_page(context, base)
        url = entry_url(base, theme)
        page.goto(url, wait_until="load")
        settle(page, "tablet-main-header")
        notes = open_folder(page, width)
        name = f"{frame_id}-{theme}"

        existing = measure(page)
        states[f"{theme}-existing"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-existing", width, height),
            "metrics": existing,
            "notes": list(notes),
        }
        check_toggle(name, existing, checks)
        check_search(name, existing, checks)
        check_header_row(name, existing, checks)
        checks.check(f"{name} 기존 보기 폴더 본문",
                     existing["mainTitle"] is not None, existing["mainTitle"])

        try:
            page.get_by_test_id("settings-segment-tablet-card-view-board").click(timeout=8000)
            page.get_by_test_id("card-board-frame").wait_for(state="visible", timeout=12000)
            page.wait_for_timeout(900)
        except Exception as error:  # noqa: BLE001 - 아래 검사가 실패를 드러낸다
            notes.append(f"board switch: {error}")
        board = measure(page)
        states[f"{theme}-board"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board", width, height),
            "metrics": board,
            "notes": list(notes),
        }
        check_board_actions(name, board, checks)

        try:
            page.get_by_test_id("board-header-overflow-button").click(timeout=8000)
            page.get_by_test_id("board-header-overflow-menu").wait_for(state="visible", timeout=8000)
            page.wait_for_timeout(500)
        except Exception as error:  # noqa: BLE001
            notes.append(f"overflow open: {error}")
        menu = measure(page)
        states[f"{theme}-board-menu"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-menu", width, height),
            "metrics": menu,
            "notes": list(notes),
        }
        check_overflow_menu(name, menu, checks)

        try:
            page.get_by_test_id("board-header-overflow-create").click(timeout=8000)
            page.get_by_label("카드 제목", exact=True).first.wait_for(state="visible", timeout=8000)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            notes.append(f"card create: {error}")
        create = measure(page)
        states[f"{theme}-board-menu-create"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-menu-create", width, height),
            "metrics": create,
            "notes": list(notes),
        }
        check_card_create(name, create, checks)
        checks.check(f"{name} 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def capture_landscape(context: BrowserContext, base: str, out: Path, frame_id: str,
                      width: int, height: int, checks: Checks) -> dict:
    states: dict[str, dict] = {}
    for theme in THEMES:
        page, errors = open_page(context, base)
        url = entry_url(base, theme)
        page.goto(url, wait_until="load")
        settle(page, "tablet-main-header")
        notes = open_folder(page, width)
        name = f"{frame_id}-{theme}"

        existing = measure(page)
        states[f"{theme}-existing"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-existing", width, height),
            "metrics": existing,
            "notes": list(notes),
        }
        check_toggle(name, existing, checks)
        check_header_row(name, existing, checks)

        try:
            page.get_by_test_id("settings-segment-tablet-card-view-board").click(timeout=8000)
            page.get_by_test_id("card-board-frame").wait_for(state="visible", timeout=12000)
            page.wait_for_timeout(900)
        except Exception as error:  # noqa: BLE001
            notes.append(f"board switch: {error}")
        board = measure(page)
        states[f"{theme}-board"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board", width, height),
            "metrics": board,
            "notes": list(notes),
        }
        checks.check(f"{name} 보드 본문 표시",
                     board["boardFrame"] is not None and board["boardFrame"]["visible"],
                     board["boardFrame"])
        checks.check(f"{name} 가로는 단독 보드 단추 유지",
                     visible_label_count(board, "드래프트 카드 추가", "headerLabelCounts") == 1
                     and visible_label_count(board, "보드 확대", "headerLabelCounts") == 1,
                     {label: visible_label_count(board, label, "headerLabelCounts")
                      for label in BOARD_LABELS})
        checks.check(f"{name} 가로는 보드 메뉴 단추 없음",
                     board["boardOverflowButton"] is None, board["boardOverflowButton"])
        checks.check(f"{name} 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def capture_duo(context: BrowserContext, base: str, out: Path, checks: Checks) -> dict:
    page, errors = open_page(context, base)
    url = duo_url(base)
    page.goto(url, wait_until="load")
    settle(page, "tablet-chat-header")
    metrics = measure(page)
    screenshot = shot(page, out, "duo-inner-portrait-light", 669, 951)
    checks.check("듀오 안쪽 세로 페이지 오류 없음", not errors, errors)
    page.close()
    return {"url": url, "screenshot": screenshot, "metrics": metrics}


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
                    for frame_id, width, height in [PORTRAIT, LANDSCAPE]:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=2,
                        )
                        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                        capture = capture_portrait if frame_id == PORTRAIT[0] else capture_landscape
                        result["frames"][frame_id] = capture(
                            context, base, out, frame_id, width, height, checks)
                        context.close()
                    context = browser.new_context(
                        viewport={"width": 669, "height": 951},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                    result["frames"]["duo-inner-portrait"] = capture_duo(context, base, out, checks)
                    context.close()
                finally:
                    browser.close()
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "portrait-board-toggle.json").write_text(
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

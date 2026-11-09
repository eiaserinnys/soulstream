#!/usr/bin/env python3
"""iPad 세로 폴더의 기존 보기/카드 보드 전환과 보드 머리 줄 시각 검수 (카드 #1120).

무엇을 검수하나
---------------
- iPad 세로(834x1210, TwoPaneWithDrawer)에서 서랍으로 프로젝트 폴더를 열면 목록 칸
  머리 아래에 「기존 보기 / 카드 보드」 전환 줄이 있고, 눌러 두 보기를 오간다.
- 세로 목록 칸 머리는 두 보기 모두 [메뉴][검색][영구 세션 열기]뿐이고 보드 단추가 없다.
  검색창 폭은 두 보기에서 같고, 머리 높이는 피드 머리와 같은 72다.
- 세로 카드 보드의 자체 머리 줄에 폴더 이름이 한 줄 말줄임으로 나오고, 드래프트 카드 추가,
  완료·취소 숨김, 보드 확대 단추 셋이 같은 줄 오른쪽에 세로 가운데로 놓인다. 단추 셋을
  눌러 카드 제목 입력, 완료 숨김 전환, 확대 보드 열고 닫기를 확인한다.
- 폴더 이름이 아주 길 때(서버가 서빙하는 번들 문자열을 바꿔 넣음)와 목록 칸이 가장 좁은
  280 안팎(616x900)일 때도 제목 한 줄 말줄임과 단추 셋 한 줄을 확인한다.
- iPad 가로(1210x834, ThreePaneLayout)의 전환 줄과 단독 보드 단추, 듀오 안쪽 세로 화면,
  제목을 넘기지 않는 검수 창 보드(boardConnected)는 변경 전후가 같다.
- 목록 칸 머리와 피드 머리의 높이, 전환 줄과 머리의 좌우 끝 좌표, 머리 안 버튼 목록,
  검색창 폭, 보드 머리 제목·단추 좌표, 메뉴 단추 모서리, 페이지 오류를 JSON으로 남긴다.

실행 방법
---------
1. 번들을 만든다(heavy_verify runner 경유):
       node scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 사용자 site-packages의 Playwright로 실행한다:
       python3 -P soul-app/scripts/capture-portrait-board-toggle.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/artifacts/card-1120/after-a

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
긴 폴더 이름 사례는 픽스처 파일을 고치지 않고, 두 번째 서버가 서빙하는 JS의
`공개 예시 폴더 ` 문자열(번들에서 유니코드 이스케이프된 형태)을 긴 이름으로 바꿔 넣는다.
변경 전 번들(origin/main)에 돌리면 세로 머리·보드 머리 검사가 실패하는 것이 정상이다.
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
NARROW = ("ipad-narrow-pane", 616, 900)
LANDSCAPE = ("ipad-landscape", 1210, 834)
THEMES = ("light", "dark")
DUO_QUERY = ("section=iphoneDuo&sample=main-layout&frame=inner-portrait"
             "&board=ops&overlay=card-with-chat&theme=light")
EDGE_TOLERANCE = 1

BOARD_LABELS = ["드래프트 카드 추가", "완료·취소 숨김", "보드 확대"]

# entryShell 픽스처의 첫 폴더 이름과, 긴 이름 사례에서 그것을 대신할 이름.
FOLDER_TITLE = "공개 예시 폴더 01"
LONG_NAME = "공개 예시 폴더 이름이 아주 길어질 때 한 줄에서 말줄임으로 끝나는지 확인하는 아주 긴 폴더 이름"
LONG_TITLE = f"{LONG_NAME} 01"
# 미니파이 번들에서 `공개 예시 폴더 `가 유니코드 이스케이프로 적힌 바이트.
BUNDLE_FOLDER_PREFIX = b"\\uacf5\\uac1c \\uc608\\uc2dc \\ud3f4\\ub354 "

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
  const menuButton = header
    ? [...header.querySelectorAll('[role="button"], button')]
      .find((element) => element.getAttribute('aria-label') === '메뉴') || null
    : null;
  const menuStyle = menuButton ? getComputedStyle(menuButton) : null;
  const headingTitle = byTestId('card-board-heading-title');
  const headingText = headingTitle ? (headingTitle.querySelector('div') || headingTitle) : null;
  const headingStyle = headingText ? getComputedStyle(headingText) : null;
  const actionBoxes = {};
  for (const label of LABELS_PLACEHOLDER) {
    actionBoxes[label] = box([...document.querySelectorAll(`[aria-label="${label}"]`)].find((element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || null);
  }
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
    menuButton: box(menuButton),
    menuRadius: menuStyle ? parseFloat(menuStyle.borderTopLeftRadius) || 0 : null,
    boardHeadingTitle: box(headingTitle),
    boardHeadingText: headingText ? {
      text: (headingText.textContent || '').trim(),
      height: round(headingText.getBoundingClientRect().height),
      width: round(headingText.getBoundingClientRect().width),
      scrollWidth: headingText.scrollWidth,
      clientWidth: headingText.clientWidth,
      whiteSpace: headingStyle.whiteSpace,
      textOverflow: headingStyle.textOverflow,
      fontSize: headingStyle.fontSize,
      lineHeight: parseFloat(headingStyle.lineHeight) || null,
    } : null,
    boardActionBoxes: actionBoxes,
    cardBoardExpanded: box(byTestId('card-board-expanded')),
    completedToggleState: byTestId('completed-cards-toggle-on') ? 'on'
      : (byTestId('completed-cards-toggle-off') ? 'off' : null),
    buttons,
    labelCounts,
    headerLabelCounts,
  };
}
""".replace("LABELS_PLACEHOLDER", json.dumps(BOARD_LABELS, ensure_ascii=False))


def long_name_substitutions() -> dict[bytes, bytes]:
    """번들이 서빙하는 JS에서 `공개 예시 폴더 `를 긴 이름으로 바꾸는 치환 쌍."""
    escaped = json.dumps(LONG_NAME, ensure_ascii=True)[1:-1].encode()
    return {BUNDLE_FOLDER_PREFIX: escaped + b" "}


class BundleServer:
    def __init__(self, bundle_root: Path, substitutions: dict[bytes, bytes] | None = None):
        self.bundle_root = bundle_root.resolve()
        self.substitutions = substitutions or {}
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def _handler(self):
        bundle_root = self.bundle_root
        substitutions = self.substitutions

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
                body = file.read_bytes()
                if substitutions and file.suffix == ".js":
                    for old, new in substitutions.items():
                        body = body.replace(old, new)
                self._send(200, body, content_type)

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


def review_board_url(base: str) -> str:
    return f"{base}{PREFIX}index.html?section=boardConnected&theme=light"


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
    # 이 작업이 만드는 전환 줄과 보드 머리 동작만 판정한다.
    main_header = metrics["mainHeader"]
    feed_header = metrics["feedHeader"]
    checks.check(f"{prefix} 목록 칸 머리 존재", main_header is not None, main_header)
    checks.check(f"{prefix} 피드 머리 존재", feed_header is not None, feed_header)


def vertical_center(box: dict | None) -> float | None:
    if not box:
        return None
    return round(box["top"] + box["height"] / 2, 2)


def check_header_alignment(prefix: str, metrics: dict, checks: Checks, state: str) -> None:
    """세로 목록 칸 머리가 피드 머리와 같은 72이고 줄 안 요소가 세로 가운데인지 본다."""
    main_header = metrics["mainHeader"]
    feed_header = metrics["feedHeader"]
    checks.check(f"{prefix} {state} 머리 높이 72",
                 main_header is not None and abs(main_header["height"] - 72) <= EDGE_TOLERANCE,
                 main_header)
    checks.check(f"{prefix} {state} 머리 위아래 끝 피드 머리와 일치",
                 bool(main_header and feed_header
                      and abs(main_header["top"] - feed_header["top"]) <= EDGE_TOLERANCE
                      and abs(main_header["bottom"] - feed_header["bottom"]) <= EDGE_TOLERANCE),
                 {"main": main_header and {"top": main_header["top"], "bottom": main_header["bottom"]},
                  "feed": feed_header and {"top": feed_header["top"], "bottom": feed_header["bottom"]}})
    search = metrics["searchInput"]
    centers = {"검색창": vertical_center(search)}
    for button in metrics["buttons"]:
        if button["label"] in ("메뉴", "영구 세션 열기"):
            centers[button["label"]] = vertical_center(button["box"])
    values = [value for value in centers.values() if value is not None]
    checks.check(f"{prefix} {state} 검색창 높이 48과 단추 세로 가운데",
                 search is not None and abs(search["height"] - 48) <= EDGE_TOLERANCE
                 and len(values) == 3 and max(values) - min(values) <= EDGE_TOLERANCE,
                 {"search": search, "centers": centers})


def check_sidebar_search(prefix: str, metrics: dict, checks: Checks) -> None:
    search = metrics["searchInput"]
    checks.check(f"{prefix} 사이드바 검색창 높이 52 유지",
                 search is not None and abs(search["height"] - 52) <= EDGE_TOLERANCE, search)


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


def check_search_width_equal(prefix: str, existing: dict, board: dict, checks: Checks) -> None:
    existing_search = existing["searchInput"]
    board_search = board["searchInput"]
    checks.check(f"{prefix} 두 보기 머리 검색창 폭 동일",
                 bool(existing_search and board_search
                      and abs(existing_search["width"] - board_search["width"]) <= 0.5),
                 {"existing": existing_search and existing_search["width"],
                  "board": board_search and board_search["width"]})


def check_header_without_board_actions(prefix: str, metrics: dict, checks: Checks) -> None:
    overflow = metrics["boardOverflowButton"]
    checks.check(f"{prefix} 머리에 보드 메뉴 단추 없음", overflow is None, overflow)
    counts = {label: visible_label_count(metrics, label, "headerLabelCounts") for label in BOARD_LABELS}
    checks.check(f"{prefix} 머리에 단독 보드 단추 없음",
                 all(count == 0 for count in counts.values()), counts)


def check_menu_round(prefix: str, metrics: dict, checks: Checks) -> None:
    button = metrics["menuButton"]
    radius = metrics["menuRadius"]
    checks.check(f"{prefix} 메뉴 단추 원형",
                 bool(button and radius is not None
                      and abs(button["width"] - button["height"]) <= EDGE_TOLERANCE
                      and radius >= button["height"] / 2 - 0.5),
                 {"box": button, "radius": radius})


def check_board_heading(prefix: str, metrics: dict, checks: Checks,
                        expected_title: str, expect_ellipsis: bool) -> None:
    title = metrics["boardHeadingTitle"]
    text = metrics["boardHeadingText"]
    checks.check(f"{prefix} 보드 머리 제목 표시", title is not None and title["visible"], title)
    checks.check(f"{prefix} 보드 머리 제목이 폴더 이름",
                 text is not None and text["text"] == expected_title,
                 {"expected": expected_title, "actual": text and text["text"]})
    checks.check(f"{prefix} 보드 머리 제목 한 줄",
                 bool(text and text["whiteSpace"] == "nowrap"
                      and text["lineHeight"] is not None
                      and text["height"] <= text["lineHeight"] + EDGE_TOLERANCE),
                 text)
    boxes = metrics["boardActionBoxes"]
    checks.check(f"{prefix} 보드 머리 단추 셋 표시",
                 all(boxes.get(label) is not None and boxes[label]["visible"] for label in BOARD_LABELS),
                 boxes)
    tops = [boxes[label]["top"] for label in BOARD_LABELS if boxes.get(label)]
    checks.check(f"{prefix} 보드 머리 단추 셋 같은 줄",
                 len(tops) == 3 and max(tops) - min(tops) <= EDGE_TOLERANCE, tops)
    centers = [vertical_center(title)] + [vertical_center(boxes[label]) for label in BOARD_LABELS
                                          if boxes.get(label)]
    checks.check(f"{prefix} 제목과 단추 셋 세로 가운데",
                 all(value is not None for value in centers)
                 and max(centers) - min(centers) <= EDGE_TOLERANCE,
                 {"title": vertical_center(title), "centers": centers})
    first_left = min((boxes[label]["left"] for label in BOARD_LABELS if boxes.get(label)), default=None)
    checks.check(f"{prefix} 제목이 단추와 겹치지 않음",
                 bool(title and first_left is not None
                      and title["right"] <= first_left + EDGE_TOLERANCE),
                 {"title": title, "firstButtonLeft": first_left})
    if expect_ellipsis:
        checks.check(f"{prefix} 긴 제목 한 줄 말줄임",
                     bool(text and text["textOverflow"] == "ellipsis"
                          and text["scrollWidth"] > text["clientWidth"] + EDGE_TOLERANCE),
                     text)


def check_board_actions(prefix: str, metrics: dict, checks: Checks) -> None:
    checks.check(f"{prefix} 보드 본문 표시",
                 metrics["boardFrame"] is not None and metrics["boardFrame"]["visible"],
                 metrics["boardFrame"])
    check_header_without_board_actions(prefix, metrics, checks)


def check_card_create(prefix: str, metrics: dict, checks: Checks) -> None:
    title_input = metrics["cardTitleInput"]
    checks.check(f"{prefix} 드래프트 카드 추가로 카드 제목 입력 열림",
                 title_input is not None and title_input["visible"], title_input)


def check_expanded(prefix: str, metrics: dict, checks: Checks) -> None:
    expanded = metrics["cardBoardExpanded"]
    checks.check(f"{prefix} 보드 확대 단추로 확대 보드 열림",
                 expanded is not None and expanded["visible"], expanded)


def check_expanded_closed(prefix: str, metrics: dict, checks: Checks,
                          expected_title: str) -> None:
    checks.check(f"{prefix} 확대 보드 닫기 단추로 확대 보드 닫힘",
                 metrics["cardBoardExpanded"] is None, metrics["cardBoardExpanded"])
    checks.check(f"{prefix} 확대 보드를 닫으면 보드 머리 단추가 「보드 확대」로 돌아온다",
                 visible_label_count(metrics, "보드 확대") == 1
                 and visible_label_count(metrics, "보드 확대 닫기") == 0,
                 metrics["labelCounts"])
    heading = metrics["boardHeadingText"]
    checks.check(f"{prefix} 확대 보드를 닫은 뒤 보드 머리 제목이 그대로",
                 heading is not None and heading["text"].startswith(expected_title[:4]),
                 heading)


def capture_portrait(context: BrowserContext, base: str, out: Path, frame_id: str,
                     width: int, height: int, checks: Checks,
                     expected_title: str = FOLDER_TITLE,
                     expect_ellipsis: bool = False,
                     themes: tuple[str, ...] = THEMES) -> dict:
    states: dict[str, dict] = {}
    for theme in themes:
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
        check_header_alignment(name, existing, checks, "기존 보기")
        check_header_without_board_actions(f"{name} 기존 보기", existing, checks)
        check_menu_round(name, existing, checks)
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
        check_header_alignment(name, board, checks, "카드 보드")
        check_search_width_equal(name, existing, board, checks)
        check_menu_round(name, board, checks)
        check_board_heading(name, board, checks, expected_title, expect_ellipsis)

        try:
            page.get_by_label("완료·취소 숨김", exact=True).first.click(timeout=8000)
            page.wait_for_timeout(600)
        except Exception as error:  # noqa: BLE001
            notes.append(f"hide done: {error}")
        hidden = measure(page)
        states[f"{theme}-board-hide-done"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-hide-done", width, height),
            "metrics": hidden,
            "notes": list(notes),
        }
        checks.check(f"{name} 완료·취소 숨김 단추가 상태를 바꾼다",
                     hidden["completedToggleState"] == "off", hidden["completedToggleState"])
        try:
            page.get_by_label("완료·취소 숨김", exact=True).first.click(timeout=8000)
            page.wait_for_timeout(600)
        except Exception as error:  # noqa: BLE001
            notes.append(f"show done: {error}")
        restored = measure(page)
        checks.check(f"{name} 완료·취소 숨김 단추가 되돌아온다",
                     restored["completedToggleState"] == "on", restored["completedToggleState"])

        # 생성 시트를 먼저 확인하고 확대 보드를 맨 뒤에 열고 닫는다.
        try:
            page.get_by_label("드래프트 카드 추가", exact=True).first.click(timeout=8000)
            page.get_by_label("카드 제목", exact=True).first.wait_for(state="visible", timeout=8000)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            notes.append(f"card create: {error}")
        create = measure(page)
        states[f"{theme}-board-create"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-create", width, height),
            "metrics": create,
            "notes": list(notes),
        }
        check_card_create(name, create, checks)
        try:
            page.get_by_label("카드 작성 취소", exact=True).first.click(timeout=8000)
            page.get_by_label("카드 제목", exact=True).first.wait_for(state="detached", timeout=8000)
            page.wait_for_timeout(500)
        except Exception as error:  # noqa: BLE001
            notes.append(f"create close: {error}")

        try:
            page.get_by_label("보드 확대", exact=True).first.click(timeout=8000)
            page.get_by_test_id("card-board-expanded").wait_for(state="visible", timeout=8000)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            notes.append(f"expand: {error}")
        expanded = measure(page)
        states[f"{theme}-board-expanded"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-expanded", width, height),
            "metrics": expanded,
            "notes": list(notes),
        }
        check_expanded(name, expanded, checks)

        # 확대 보드가 열린 동안에는 모달 뒤 보드 머리의 확대 단추도 「보드 확대 닫기」라는
        # 이름이 된다. 모달 안의 닫기 단추를 누르도록 card-board-expanded 안에서 찾는다.
        try:
            (page.get_by_test_id("card-board-expanded")
             .get_by_label("보드 확대 닫기", exact=True).first.click(timeout=8000))
            page.get_by_test_id("card-board-expanded").wait_for(state="detached", timeout=8000)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            notes.append(f"expand close: {error}")
        closed = measure(page)
        states[f"{theme}-board-expanded-closed"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-board-expanded-closed", width, height),
            "metrics": closed,
            "notes": list(notes),
        }
        check_expanded_closed(name, closed, checks, expected_title)
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
        check_sidebar_search(name, existing, checks)

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
        checks.check(f"{name} 가로는 자체 보드 머리 줄 없음",
                     board["boardHeadingTitle"] is None, board["boardHeadingTitle"])
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


def capture_review_board(context: BrowserContext, base: str, out: Path, checks: Checks) -> dict:
    page, errors = open_page(context, base)
    url = review_board_url(base)
    page.goto(url, wait_until="load")
    settle(page, "card-board-frame")
    metrics = measure(page)
    screenshot = shot(page, out, "review-board-connected-light", 834, 1210)
    checks.check("검수 창 보드 본문 표시",
                 metrics["boardFrame"] is not None and metrics["boardFrame"]["visible"],
                 metrics["boardFrame"])
    checks.check("검수 창 보드는 제목을 넘기지 않는다",
                 metrics["boardHeadingTitle"] is None, metrics["boardHeadingTitle"])
    checks.check("검수 창 보드 페이지 오류 없음", not errors, errors)
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
        with BundleServer(bundle_root) as server, \
                BundleServer(bundle_root, long_name_substitutions()) as long_server:
            base = server.base
            long_base = long_server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    result["frames"] = {}
                    for frame_id, width, height in [PORTRAIT, LANDSCAPE, NARROW]:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=2,
                        )
                        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                        if frame_id == LANDSCAPE[0]:
                            result["frames"][frame_id] = capture_landscape(
                                context, base, out, frame_id, width, height, checks)
                        else:
                            result["frames"][frame_id] = capture_portrait(
                                context, base, out, frame_id, width, height, checks,
                                expect_ellipsis=frame_id == NARROW[0],
                                themes=THEMES if frame_id == PORTRAIT[0] else ("light",))
                        context.close()
                    context = browser.new_context(
                        viewport={"width": 669, "height": 951},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                    result["frames"]["duo-inner-portrait"] = capture_duo(context, base, out, checks)
                    context.close()
                    context = browser.new_context(
                        viewport={"width": 834, "height": 1210},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                    result["frames"]["review-board-connected"] = capture_review_board(
                        context, base, out, checks)
                    context.close()
                    context = browser.new_context(
                        viewport={"width": PORTRAIT[1], "height": PORTRAIT[2]},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": long_base}])
                    result["frames"]["portrait-long-name"] = capture_portrait(
                        context, long_base, out, "ipad-portrait-long-name",
                        PORTRAIT[1], PORTRAIT[2], checks,
                        expected_title=LONG_TITLE, expect_ellipsis=True, themes=("light",))
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

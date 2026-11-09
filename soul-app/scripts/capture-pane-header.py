#!/usr/bin/env python3
"""세션 대화 패널 머리와 iPad 입력 상자 시각 검수 (카드 #1095, #1118).

무엇을 검수하나
---------------
- 듀오 안쪽 가로(951x669)·안쪽 세로(669x951) 카드 오버레이 대화 패널 머리
  (`tablet-chat-header`)의 높이가 72pt이고, 세션 이름 글자의 세로 가운데가
  머리 위 끝에서 36pt다.
- iPad split(`cardChecks` 1210x834, 834x1210)에서 사이드바·메인·피드·대화 머리가
  한 줄에 서고, 위 끝과 아래 끝이 1px 이내로 같다.
- iPad 카드 상세(카드 커버)의 커멘트 입력 상자(`chat-composer-box`)가 카드 상세
  dock 안에서 불투명 배경(alpha 1)을 그려 목록 글자가 비치지 않는다.
- iPad 엔트리 셸(1210x834, 834x1210) 첫 화면의 사이드바·메인·피드 머리가 한 줄에
  서고, 피드 세션을 열면 폴더 커버와 대화 칸의 머리 위·아래 끝이 1px 이내로 같다.
- 가로 폴더 칸에서 제목 첫 줄 글자 가운데가 같은 줄 48 버튼들(별·달력·메뉴·닫기)의
  가운데와 1px 이내로 같다. 한 줄 제목이면 머리 72, 긴 제목이면 아래로 자라
  목록이 자란 머리 아래에서 시작한다.
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
HEADER_VERTICAL_PADDING = 12
TITLE_CENTER_FROM_TOP = 36
EDGE_TOLERANCE = 1

# planner.typography.navigation(20pt 활자)와 hitTarget.min에서 나온 값.
TITLE_LINE_HEIGHT = 26
TITLE_MIN_HEIGHT = 48
TITLE_VERTICAL_PADDING = 11
TITLE_TWO_LINE_HEIGHT = TITLE_VERTICAL_PADDING * 2 + TITLE_LINE_HEIGHT * 2  # 74
TWO_LINE_HEADER_HEIGHT = TITLE_TWO_LINE_HEIGHT + HEADER_VERTICAL_PADDING * 2  # 98
# 세로 커버에서는 제목 칸이 76px라 두 글자로 한 줄을 만든다(긴 제목의 두 줄 성장은 폴더 칸에서 본다).
SHORT_TITLE = "폴더"
TWO_LINE_TITLE = "두 줄로 늘어나는 폴더 제목 예시입니다"

# (id, width, height)
DUO_FRAMES = [
    ("inner-landscape", 951, 669),
    ("inner-portrait", 669, 951),
]
ENTRY_FRAMES = [
    ("ipad-entry-landscape", 1210, 834),
    ("ipad-entry-portrait", 834, 1210),
]
IPAD_FRAME = ("ipad-landscape", 1210, 834)
IPAD_PORTRAIT_FRAME = ("ipad-portrait", 834, 1210)
CARD_FRAMES = [IPAD_FRAME, IPAD_PORTRAIT_FRAME]
THEMES = ["light", "dark"]

SHELL_HEADER_IDS = [
    "tablet-sidebar-header",
    "tablet-main-header",
    "tablet-feed-header",
]

HEADER_IDS = [
    "tablet-sidebar-header",
    "tablet-main-header",
    "tablet-feed-header",
    "tablet-chat-header",
    "task-workspace-tablet-header",
    "card-detail-header",
]

TITLE_BUTTON_IDS = [
    "task-workspace-starred-toggle",
    "task-workspace-today-toggle",
    "folder-workspace-menu",
    "task-workspace-close",
]
TITLE_REQUIRED_BUTTON_IDS = [
    "task-workspace-starred-toggle",
    "task-workspace-today-toggle",
    "folder-workspace-menu",
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
  const headers = {};
  for (const id of HEADER_IDS_PLACEHOLDER) headers[id] = box(byTestId(id));
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
  const titleStyle = chatTitle ? getComputedStyle(chatTitle) : null;
  const titleElement = byTestId('task-workspace-tablet-title');
  let title = null;
  if (titleElement) {
    const style = getComputedStyle(titleElement);
    const rect = titleElement.getBoundingClientRect();
    const lineHeight = parseFloat(style.lineHeight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const text = (titleElement.value || '').trim();
    const firstChar = Array.from(text)[0] || '';
    const contentTop = rect.top + borderTop + paddingTop;
    const lineCenter = round(contentTop + lineHeight / 2);
    let glyphCenter = null;
    if (firstChar) {
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(firstChar);
      if (typeof metrics.fontBoundingBoxAscent === 'number'
          && typeof metrics.actualBoundingBoxAscent === 'number') {
        const baseline = contentTop
          + (lineHeight - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2
          + metrics.fontBoundingBoxAscent;
        glyphCenter = round(baseline
          - (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
      }
    }
    title = {
      box: box(titleElement), text: text.slice(0, 60), rows: titleElement.getAttribute('rows'),
      fontSize: style.fontSize, lineHeight, paddingTop, lineCenter, glyphCenter,
      firstLineCenter: glyphCenter === null ? lineCenter : glyphCenter,
    };
  }
  const buttons = {};
  for (const id of TITLE_BUTTON_IDS_PLACEHOLDER) {
    const element = byTestId(id);
    if (!element) { buttons[id] = null; continue; }
    const rect = element.getBoundingClientRect();
    buttons[id] = { box: box(element), center: round((rect.top + rect.bottom) / 2) };
  }
  const dock = byTestId('card-detail-dock');
  const composerBox = dock ? dock.querySelector('[data-testid="chat-composer-box"]') : null;
  const composerStyle = composerBox ? getComputedStyle(composerBox) : null;
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
    title,
    buttons,
    list: box(byTestId('task-workspace-scroll')),
    boardFrame: box(byTestId('card-board-frame')),
    composer: {
      dock: box(dock),
      box: box(composerBox),
      backgroundColor: composerStyle ? composerStyle.backgroundColor : null,
    },
  };
}
""".replace("HEADER_IDS_PLACEHOLDER", json.dumps(HEADER_IDS)).replace(
    "TITLE_BUTTON_IDS_PLACEHOLDER", json.dumps(TITLE_BUTTON_IDS))


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


def entry_url(base: str, theme: str) -> str:
    query = f"section=entryShell&safeArea=fixture&theme={theme}"
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


def color_alpha(color: str | None) -> float | None:
    if not color:
        return None
    color = color.strip()
    if color.startswith("rgba("):
        parts = color[color.index("(") + 1:color.rindex(")")].split(",")
        try:
            return float(parts[3])
        except (IndexError, ValueError):
            return None
    if color.startswith("rgb("):
        return 1.0
    return None


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


def check_title_alignment(prefix: str, metrics: dict, checks: Checks) -> None:
    title = metrics["title"]
    checks.check(f"{prefix} 폴더 제목 존재", title is not None, title)
    if title is None:
        return
    centers = {name: value["center"] for name, value in metrics["buttons"].items()
               if value is not None}
    missing = [name for name in TITLE_REQUIRED_BUTTON_IDS if name not in centers]
    checks.check(f"{prefix} 같은 줄 버튼 존재", not missing,
                 {"missing": missing, "present": sorted(centers)})
    if not centers:
        return
    offsets = {name: round(title["firstLineCenter"] - center, 2)
               for name, center in centers.items()}
    checks.check(f"{prefix} 제목 첫 줄 가운데가 버튼 가운데와 {EDGE_TOLERANCE}px 이내",
                 all(abs(offset) <= EDGE_TOLERANCE for offset in offsets.values()),
                 {"titleCenter": title["firstLineCenter"], "glyphCenter": title["glyphCenter"],
                  "buttons": centers, "offsets": offsets, "text": title["text"]})


def check_card_comment_surface(prefix: str, metrics: dict, checks: Checks) -> None:
    composer = metrics["composer"]
    checks.check(f"{prefix} 카드 상세 dock 존재", composer["dock"] is not None, composer["dock"])
    checks.check(f"{prefix} dock 안 커멘트 입력 상자 존재", composer["box"] is not None,
                 composer)
    alpha = color_alpha(composer["backgroundColor"])
    checks.check(f"{prefix} 커멘트 입력 상자 불투명 배경(alpha 1)",
                 alpha is not None and abs(alpha - 1.0) < 0.01,
                 {"backgroundColor": composer["backgroundColor"], "alpha": alpha,
                  "box": composer["box"]})


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


def capture_entry(context: BrowserContext, base: str, out: Path, frame_id: str,
                  width: int, height: int, checks: Checks, with_folder_state: bool) -> dict:
    states: dict[str, dict] = {}
    for theme in THEMES:
        name = f"{frame_id}-{theme}"
        url = entry_url(base, theme)

        page, errors = open_page(context, base)
        page.goto(url, wait_until="load")
        settle(page, "tablet-sidebar-header")
        initial = measure(page)
        states[f"{theme}-first"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-first", width, height),
            "metrics": initial,
        }
        check_header_row(f"{name} 첫 화면", initial, checks, SHELL_HEADER_IDS)
        for test_id in SHELL_HEADER_IDS:
            header = initial["headers"][test_id]
            checks.check(f"{name} 머리 높이 {HEADER_MIN_HEIGHT} ({test_id})",
                         header is not None
                         and abs(header["height"] - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                         header)
        checks.check(f"{name} 첫 화면 페이지 오류 없음", not errors, errors)
        page.close()

        page, errors = open_page(context, base)
        page.goto(url, wait_until="load")
        settle(page, "tablet-sidebar-header")
        try:
            page.get_by_text("공개 예시 세션 10", exact=True).first.click(timeout=8000)
            page.get_by_test_id("tablet-chat-header").wait_for(state="visible", timeout=8000)
        except Exception as error:  # noqa: BLE001 - 아래 존재 검사가 실패를 드러낸다
            errors.append(f"session open: {error}")
        page.wait_for_timeout(1000)
        try:
            page.get_by_test_id("task-workspace-tablet-title").fill(SHORT_TITLE)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            errors.append(f"title fill: {error}")
        cover = measure(page)
        states[f"{theme}-cover"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-cover", width, height),
            "metrics": cover,
            "errors": list(errors),
        }
        check_chat_header(f"{name} 대화 칸", cover, checks)
        check_title_alignment(f"{name} 폴더 커버", cover, checks)
        check_header_row(f"{name} 폴더 커버와 대화 머리", cover, checks,
                         ["task-workspace-tablet-header", "tablet-chat-header"])
        header = cover["headers"]["task-workspace-tablet-header"]
        checks.check(f"{name} 폴더 커버 머리 높이 {HEADER_MIN_HEIGHT}",
                     header is not None
                     and abs(header["height"] - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     header)
        checks.check(f"{name} 폴더 커버 페이지 오류 없음", not errors, errors)
        page.close()

        if not with_folder_state:
            continue
        page, errors = open_page(context, base)
        page.goto(url, wait_until="load")
        settle(page, "tablet-sidebar-header")
        try:
            page.get_by_test_id("sidebar-main-list").get_by_text("공개 예", exact=False).first.click(timeout=8000)
            page.get_by_test_id("task-workspace-tablet-header").wait_for(state="visible", timeout=8000)
        except Exception as error:  # noqa: BLE001
            errors.append(f"folder open: {error}")
        page.wait_for_timeout(1200)
        try:
            page.get_by_test_id("task-workspace-tablet-title").fill(SHORT_TITLE)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            errors.append(f"title fill: {error}")
        one_line = measure(page)
        states[f"{theme}-folder-one-line"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-folder-one-line", width, height),
            "metrics": one_line,
        }
        title = one_line["title"]
        checks.check(f"{name} 한 줄 제목 상자 높이 {TITLE_MIN_HEIGHT}",
                     title is not None
                     and abs(title["box"]["height"] - TITLE_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     title)
        checks.check(f"{name} 한 줄 머리 높이 {HEADER_MIN_HEIGHT}",
                     one_line["headers"]["task-workspace-tablet-header"] is not None
                     and abs(one_line["headers"]["task-workspace-tablet-header"]["height"]
                             - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     one_line["headers"]["task-workspace-tablet-header"])
        checks.check(f"{name} 한 줄 제목 textarea rows=1",
                     title is not None and title["rows"] == "1",
                     None if title is None else title["rows"])
        check_title_alignment(f"{name} 한 줄 제목", one_line, checks)

        try:
            page.get_by_test_id("task-workspace-tablet-title").fill(TWO_LINE_TITLE)
            page.wait_for_timeout(700)
        except Exception as error:  # noqa: BLE001
            errors.append(f"title fill: {error}")
        two_line = measure(page)
        states[f"{theme}-folder-two-line"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-folder-two-line", width, height),
            "metrics": two_line,
            "errors": list(errors),
        }
        two_title = two_line["title"]
        checks.check(f"{name} 두 줄 제목 상자 높이 {TITLE_TWO_LINE_HEIGHT}",
                     two_title is not None
                     and abs(two_title["box"]["height"] - TITLE_TWO_LINE_HEIGHT) <= EDGE_TOLERANCE,
                     two_title)
        checks.check(f"{name} 두 줄 머리 높이 {TWO_LINE_HEADER_HEIGHT}",
                     two_line["headers"]["task-workspace-tablet-header"] is not None
                     and abs(two_line["headers"]["task-workspace-tablet-header"]["height"]
                             - TWO_LINE_HEADER_HEIGHT) <= EDGE_TOLERANCE,
                     two_line["headers"]["task-workspace-tablet-header"])
        checks.check(f"{name} 제목이 아래로 자란다",
                     title is not None and two_title is not None
                     and abs(two_title["box"]["top"] - title["box"]["top"]) <= EDGE_TOLERANCE,
                     None if title is None or two_title is None
                     else {"oneLineTop": title["box"]["top"], "twoLineTop": two_title["box"]["top"]})
        check_title_alignment(f"{name} 두 줄 제목", two_line, checks)
        header = two_line["headers"]["task-workspace-tablet-header"]
        listing = two_line["list"]
        checks.check(f"{name} 목록 내용이 자란 머리 아래에서 시작",
                     header is not None and listing is not None
                     and listing["top"] >= header["bottom"] - EDGE_TOLERANCE,
                     {"listTop": None if listing is None else listing["top"],
                      "headerBottom": None if header is None else header["bottom"]})
        checks.check(f"{name} 폴더 칸 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def capture_ipad(context: BrowserContext, base: str, out: Path, frame_id: str,
                 width: int, height: int, checks: Checks) -> dict:
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
        check_card_comment_surface(name, metrics, checks)
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
                    for frame_id, width, height in ENTRY_FRAMES:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=2,
                        )
                        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                        result["frames"][frame_id] = capture_entry(
                            context, base, out, frame_id, width, height, checks,
                            with_folder_state=width > height)
                        context.close()
                    for frame_id, width, height in CARD_FRAMES:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=2,
                        )
                        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                        result["frames"][frame_id] = capture_ipad(
                            context, base, out, frame_id, width, height, checks)
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

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
from urllib.parse import quote, urlsplit

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
# 제목은 입력창에 타이핑하지 않고 표본 데이터(URL folderTitle)로 넣는다.
# 넣으면 포커스가 빠질 때 저장이 시도돼 실패 알림이 캡처를 덮기 때문이다.
SHORT_TITLE = "폴더"
TWO_LINE_TITLE = "두 줄로 늘어나는 폴더 제목 예시입니다"
LONG_TITLES = [
    "🗂️ 카드 뷰와 오케스트레이션",
    "🔔 백그라운드 태스크 알림 미도착 잔여 원인 조사·수정",
]
SAMPLE_COVER_SESSION = "공개 예시 세션 10"
# 표본 세션 10의 폴더(공개 예시 폴더 10)에 URL folderTitle로 긴 이름을 넣는다.
# 연결 카드가 있는 세션 0은 피드에서 누르면 카드가 열려 폴더 덮개가 보이지 않는다.
LONG_TITLE_FOLDER_ID = "public-shell-folder-9"
LONG_TITLE_SESSION = "공개 예시 세션 10"

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
  // 글자 첫 줄의 세로 위치는 읽기(Text)와 편집(textarea)에 같은 식을 쓴다.
  const inkMetrics = (element, text) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const lineHeight = parseFloat(style.lineHeight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const contentTop = rect.top + borderTop + paddingTop;
    const lineCenter = round(contentTop + lineHeight / 2);
    let glyphCenter = null;
    let glyphTop = null;
    const firstChar = Array.from(text || '')[0] || '';
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
        glyphTop = round(baseline - metrics.actualBoundingBoxAscent);
      }
    }
    return {
      box: box(element), fontSize: style.fontSize, lineHeight, paddingTop, lineCenter, glyphCenter,
      glyphTop, firstLineCenter: glyphCenter === null ? lineCenter : glyphCenter,
    };
  };
  const countLines = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    return new Set(rects.map((r) => Math.round(r.top))).size;
  };
  // 말줄임만 잠시 풀어 제목 전체가 몇 줄인지 잰다.
  // body에 붙인 사본은 상속 글꼴이 달라 줄수가 틀어지므로 제자리에서 재고 곧 되돌린다.
  const naturalLineCount = (element) => {
    const style = getComputedStyle(element);
    const lineHeight = parseFloat(style.lineHeight) || 0;
    if (!lineHeight) return null;
    const saved = {
      display: element.style.display,
      webkitLineClamp: element.style.webkitLineClamp,
      webkitBoxOrient: element.style.webkitBoxOrient,
      overflow: element.style.overflow,
      maxHeight: element.style.maxHeight,
      height: element.style.height,
    };
    element.style.display = 'block';
    element.style.webkitLineClamp = 'unset';
    element.style.webkitBoxOrient = 'unset';
    element.style.overflow = 'visible';
    element.style.maxHeight = 'none';
    element.style.height = 'auto';
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const count = new Set(rects.map((r) => Math.round(r.top))).size;
    element.style.display = saved.display;
    element.style.webkitLineClamp = saved.webkitLineClamp;
    element.style.webkitBoxOrient = saved.webkitBoxOrient;
    element.style.overflow = saved.overflow;
    element.style.maxHeight = saved.maxHeight;
    element.style.height = saved.height;
    return count;
  };
  const readText = byTestId('task-workspace-tablet-title-text');
  const editInput = byTestId('task-workspace-tablet-title');
  let title = null;
  let titleRead = null;
  let titleEdit = null;
  if (readText) {
    const metrics = inkMetrics(readText, readText.textContent);
    const style = getComputedStyle(readText);
    titleRead = {
      ...metrics,
      text: (readText.textContent || '').trim().slice(0, 60),
      lineCount: countLines(readText),
      naturalLineCount: naturalLineCount(readText),
      lineClamp: style.webkitLineClamp,
      display: style.display,
      minHeight: style.minHeight,
      // 위아래 여백은 바깥 Pressable이 갖는다. Text에 여백이 남으면 말줄임 아래 여백에 다음 줄이 그려진다.
      container: box(byTestId('task-workspace-tablet-title-read')),
      computedPaddingTop: style.paddingTop,
      computedPaddingBottom: style.paddingBottom,
    };
    title = {
      box: metrics.box, text: titleRead.text, rows: null, fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight, paddingTop: metrics.paddingTop, lineCenter: metrics.lineCenter,
      glyphCenter: metrics.glyphCenter, firstLineCenter: metrics.firstLineCenter,
    };
  }
  if (editInput) {
    const metrics = inkMetrics(editInput, editInput.value);
    const style = getComputedStyle(editInput);
    titleEdit = {
      ...metrics,
      text: (editInput.value || '').trim().slice(0, 60),
      rows: editInput.getAttribute('rows'),
      scrollHeight: editInput.scrollHeight,
      clientHeight: editInput.clientHeight,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
    };
    if (!title) {
      title = {
        box: metrics.box, text: titleEdit.text, rows: titleEdit.rows, fontSize: metrics.fontSize,
        lineHeight: metrics.lineHeight, paddingTop: metrics.paddingTop, lineCenter: metrics.lineCenter,
        glyphCenter: metrics.glyphCenter, firstLineCenter: metrics.firstLineCenter,
      };
    }
  }
  const buttons = {};
  for (const id of TITLE_BUTTON_IDS_PLACEHOLDER) {
    const element = byTestId(id);
    if (!element) { buttons[id] = null; continue; }
    const rect = element.getBoundingClientRect();
    buttons[id] = { box: box(element), center: round((rect.top + rect.bottom) / 2) };
  }
  const dock = byTestId('card-detail-dock');
  const composerBoxes = Array.from(document.querySelectorAll('[data-testid="chat-composer-box"]'))
    .map((element) => ({
      box: box(element),
      inDock: !!(dock && dock.contains(element)),
      backgroundColor: getComputedStyle(element).backgroundColor,
    }));
  const commentComposer = composerBoxes.find((entry) => entry.inDock) || null;
  const chatComposer = composerBoxes.find((entry) => !entry.inDock) || null;
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
    titleRead,
    titleEdit,
    buttons,
    list: box(byTestId('task-workspace-scroll')),
    boardFrame: box(byTestId('card-board-frame')),
    composer: {
      dock: box(dock),
      box: commentComposer ? commentComposer.box : null,
      backgroundColor: commentComposer ? commentComposer.backgroundColor : null,
    },
    composerBoxes,
    commentComposer: commentComposer ? commentComposer.box : null,
    chatComposer: chatComposer ? chatComposer.box : null,
    cardScroll: box(byTestId('card-detail-scroll')),
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


def entry_url(base: str, theme: str, folder_title: str | None = None) -> str:
    query = f"section=entryShell&safeArea=fixture&theme={theme}"
    if folder_title is not None:
        query += f"&folderTitle={quote(folder_title)}"
    return f"{base}{PREFIX}index.html?{query}"


def review_chat_url(base: str, theme: str) -> str:
    query = f"section=chat&theme={theme}"
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


def check_title_read(prefix: str, metrics: dict, checks: Checks) -> None:
    title = metrics["titleRead"]
    checks.check(f"{prefix} 읽기 상태 제목 존재", title is not None, title)
    if title is None:
        return
    natural = title["naturalLineCount"]
    container = title["container"]
    height = None if container is None else container["height"]
    visible_lines = (None if height is None
                     else round((height - TITLE_VERTICAL_PADDING * 2) / TITLE_LINE_HEIGHT))
    expected = (None if visible_lines is None
                else TITLE_VERTICAL_PADDING * 2 + visible_lines * TITLE_LINE_HEIGHT)
    checks.check(f"{prefix} 읽기 제목 상자 높이 {expected} ({visible_lines}줄)",
                 container is not None and natural is not None
                 and visible_lines in (1, 2, 3)
                 and abs(height - expected) <= EDGE_TOLERANCE,
                 {"height": height, "expected": expected, "container": container,
                  "naturalLineCount": natural, "lineCount": title["lineCount"],
                  "text": title["text"]})
    if natural is None:
        checks.check(f"{prefix} 읽기 제목 줄수 측정", False, title)
        return
    # 글자 Text는 여백 없이 줄 높이만 차지해야 한다(최대 세 줄 78).
    text_height = title["box"]["height"]
    text_expected = (None if visible_lines is None else visible_lines * TITLE_LINE_HEIGHT)
    checks.check(f"{prefix} 읽기 제목 글자 상자 높이 {text_expected} ({visible_lines}줄, 여백 제외)",
                 text_expected is not None and text_expected <= TITLE_LINE_HEIGHT * 3
                 and abs(text_height - text_expected) <= EDGE_TOLERANCE,
                 {"height": text_height, "expected": text_expected,
                  "computedPaddingTop": title["computedPaddingTop"],
                  "computedPaddingBottom": title["computedPaddingBottom"]})
    checks.check(f"{prefix} 읽기 제목 글자 위아래 여백 0",
                 title["computedPaddingTop"] == "0px"
                 and title["computedPaddingBottom"] == "0px",
                 {"computedPaddingTop": title["computedPaddingTop"],
                  "computedPaddingBottom": title["computedPaddingBottom"]})
    if natural > 3:
        checks.check(f"{prefix} 세 줄 넘는 제목 말줄임",
                     str(title["lineClamp"]) == "3" and visible_lines == 3,
                     {"lineClamp": title["lineClamp"], "visibleLines": visible_lines,
                      "naturalLineCount": natural, "display": title["display"]})
    else:
        checks.check(f"{prefix} 읽기 제목 줄수와 표시 줄수 일치",
                     visible_lines == natural and title["lineCount"] == natural,
                     {"visibleLines": visible_lines, "lineCount": title["lineCount"],
                      "naturalLineCount": natural})


def check_title_edit(prefix: str, read_metrics: dict, edit_metrics: dict,
                     checks: Checks) -> None:
    read_title = read_metrics["titleRead"]
    edit_title = edit_metrics["titleEdit"]
    checks.check(f"{prefix} 편집 상태 입력 존재", edit_title is not None, edit_title)
    if edit_title is None:
        return
    checks.check(f"{prefix} 편집 입력 안쪽 스크롤 없음",
                 edit_title["scrollHeight"] <= edit_title["clientHeight"] + EDGE_TOLERANCE,
                 {"scrollHeight": edit_title["scrollHeight"],
                  "clientHeight": edit_title["clientHeight"],
                  "maxHeight": edit_title["maxHeight"], "text": edit_title["text"]})
    checks.check(f"{prefix} 편집 입력 textarea rows=1", edit_title["rows"] == "1",
                 edit_title["rows"])
    read_glyph = None if read_title is None else read_title["glyphTop"]
    edit_glyph = edit_title["glyphTop"]
    diff = None if read_glyph is None or edit_glyph is None else round(
        abs(read_glyph - edit_glyph), 2)
    checks.check(f"{prefix} 읽기/편집 첫 줄 글자 위 끝 차이 {EDGE_TOLERANCE}px 이하",
                 diff is not None and diff <= EDGE_TOLERANCE,
                 {"readGlyphTop": read_glyph, "editGlyphTop": edit_glyph, "diff": diff})


def check_composer_pair(prefix: str, metrics: dict, checks: Checks) -> None:
    comment = metrics["commentComposer"]
    chat = metrics["chatComposer"]
    checks.check(f"{prefix} 커멘트·대화 입력 상자 쌍 존재",
                 comment is not None and chat is not None,
                 {"comment": comment, "chat": chat, "all": metrics["composerBoxes"]})
    if comment is None or chat is None:
        return
    top_diff = round(abs(comment["top"] - chat["top"]), 2)
    bottom_diff = round(abs(comment["bottom"] - chat["bottom"]), 2)
    checks.check(f"{prefix} 커멘트·대화 입력 위·아래 끝 차이 {EDGE_TOLERANCE}px 이하",
                 top_diff <= EDGE_TOLERANCE and bottom_diff <= EDGE_TOLERANCE,
                 {"topDiff": top_diff, "bottomDiff": bottom_diff,
                  "comment": comment, "chat": chat})


def check_scroll_above_dock(prefix: str, metrics: dict, checks: Checks) -> None:
    scroll = metrics["cardScroll"]
    dock = metrics["composer"]["dock"]
    checks.check(f"{prefix} 목록 스크롤 아래 끝이 커멘트 상자 위",
                 scroll is not None and dock is not None
                 and scroll["bottom"] <= dock["top"] + EDGE_TOLERANCE,
                 {"scrollBottom": None if scroll is None else scroll["bottom"],
                  "dockTop": None if dock is None else dock["top"]})


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
        if frame_id == "inner-landscape":
            check_composer_pair(f"{name} 커멘트·대화 입력", metrics, checks)
            check_scroll_above_dock(f"{name} 목록 스크롤", metrics, checks)
        checks.check(f"{name} 페이지 오류 없음", not errors, errors)
        page.close()
    return states


def scroll_lists_to_end(page: Page) -> None:
    page.evaluate("""() => {
      for (const element of document.querySelectorAll('div')) {
        const style = getComputedStyle(element);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll')
            && element.scrollHeight > element.clientHeight + 1) {
          element.scrollTop = element.scrollHeight;
        }
      }
    }""")


def open_session(page: Page, label: str) -> None:
    # 피드 목록은 가상 목록이라 아래쪽 세션 행은 스크롤해야 DOM에 붙는다.
    locator = page.get_by_text(label, exact=True).first
    try:
        locator.click(timeout=3000)
    except Exception:  # noqa: BLE001 - 스크롤해 행을 마운트한 뒤 다시 누른다
        for _ in range(8):
            scroll_lists_to_end(page)
            page.wait_for_timeout(500)
            try:
                locator.click(timeout=2000)
                break
            except Exception:  # noqa: BLE001
                continue
        else:
            locator.click(timeout=8000)
    page.get_by_test_id("tablet-chat-header").wait_for(state="visible", timeout=8000)
    page.wait_for_timeout(1000)


def open_title_folder(page: Page) -> None:
    locator = page.get_by_test_id(f"project-row-inner-{LONG_TITLE_FOLDER_ID}").first
    try:
        locator.click(timeout=3000)
    except Exception:  # noqa: BLE001 - 목록을 내려 행을 마운트한 뒤 다시 누른다
        for _ in range(8):
            scroll_lists_to_end(page)
            page.wait_for_timeout(500)
            try:
                locator.click(timeout=2000)
                break
            except Exception:  # noqa: BLE001
                continue
        else:
            locator.click(timeout=8000)
    page.get_by_test_id("task-workspace-tablet-header").wait_for(state="visible", timeout=8000)
    page.wait_for_timeout(1000)


def open_title_editor(page: Page, errors: list[str]) -> None:
    try:
        page.get_by_test_id("task-workspace-tablet-title-read").click(timeout=8000)
        page.wait_for_timeout(600)
    except Exception as error:  # noqa: BLE001 - 아래 존재 검사가 실패를 드러낸다
        errors.append(f"title read open: {error}")


def capture_entry(context: BrowserContext, base: str, out: Path, frame_id: str,
                  width: int, height: int, checks: Checks, with_folder_state: bool) -> dict:
    states: dict[str, dict] = {}
    for theme in THEMES:
        name = f"{frame_id}-{theme}"

        page, errors = open_page(context, base)
        url = entry_url(base, theme)
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

        # 이름을 바꾸지 않은 표본 그대로의 덮개.
        page, errors = open_page(context, base)
        url = entry_url(base, theme)
        page.goto(url, wait_until="load")
        settle(page, "tablet-sidebar-header")
        try:
            open_session(page, SAMPLE_COVER_SESSION)
        except Exception as error:  # noqa: BLE001 - 아래 존재 검사가 실패를 드러낸다
            errors.append(f"sample cover open: {error}")
        cover = measure(page)
        states[f"{theme}-cover"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-cover", width, height),
            "metrics": cover,
            "errors": list(errors),
        }
        check_chat_header(f"{name} 대화 칸", cover, checks)
        check_title_read(f"{name} 표본 그대로 커버", cover, checks)
        checks.check(f"{name} 표본 커버 페이지 오류 없음", not errors, errors)
        page.close()

        # 짧은 제목(같은 표본 폴더의 이름만 바꿈) 기준: 머리 72와 같은 줄 버튼 정렬,
        # 대화 머리와 아래 끝 정렬. 긴 이름은 제목이 자라 머리도 자라므로 이 정렬은
        # 한 줄 제목 상태에서 검사한다.
        page, errors = open_page(context, base)
        url = entry_url(base, theme, SHORT_TITLE)
        page.goto(url, wait_until="load")
        settle(page, "tablet-sidebar-header")
        try:
            open_session(page, LONG_TITLE_SESSION)
        except Exception as error:  # noqa: BLE001
            errors.append(f"short cover open: {error}")
        short_cover = measure(page)
        states[f"{theme}-cover-short"] = {
            "url": url,
            "screenshot": shot(page, out, f"{name}-cover-short", width, height),
            "metrics": short_cover,
            "errors": list(errors),
        }
        check_chat_header(f"{name} 짧은 제목 대화 칸", short_cover, checks)
        check_header_row(f"{name} 폴더 커버와 대화 머리", short_cover, checks,
                         ["task-workspace-tablet-header", "tablet-chat-header"])
        check_title_read(f"{name} 짧은 제목 커버", short_cover, checks)
        check_title_alignment(f"{name} 폴더 커버", short_cover, checks)
        header = short_cover["headers"]["task-workspace-tablet-header"]
        checks.check(f"{name} 폴더 커버 머리 높이 {HEADER_MIN_HEIGHT}",
                     header is not None
                     and abs(header["height"] - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                     header)
        checks.check(f"{name} 폴더 커버 페이지 오류 없음", not errors, errors)
        page.close()

        if with_folder_state:
            # 한 줄 제목.
            page, errors = open_page(context, base)
            url = entry_url(base, theme, SHORT_TITLE)
            page.goto(url, wait_until="load")
            settle(page, "tablet-sidebar-header")
            try:
                open_title_folder(page)
            except Exception as error:  # noqa: BLE001
                errors.append(f"folder open: {error}")
            one_line = measure(page)
            states[f"{theme}-folder-one-line"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-folder-one-line", width, height),
                "metrics": one_line,
            }
            title = one_line["titleRead"]
            checks.check(f"{name} 한 줄 제목 상자 높이 {TITLE_MIN_HEIGHT}",
                         title is not None and title["container"] is not None
                         and abs(title["container"]["height"] - TITLE_MIN_HEIGHT)
                         <= EDGE_TOLERANCE,
                         title)
            checks.check(f"{name} 한 줄 머리 높이 {HEADER_MIN_HEIGHT}",
                         one_line["headers"]["task-workspace-tablet-header"] is not None
                         and abs(one_line["headers"]["task-workspace-tablet-header"]["height"]
                                 - HEADER_MIN_HEIGHT) <= EDGE_TOLERANCE,
                         one_line["headers"]["task-workspace-tablet-header"])
            check_title_alignment(f"{name} 한 줄 제목", one_line, checks)
            checks.check(f"{name} 한 줄 제목 페이지 오류 없음", not errors, errors)
            page.close()

            # 두 줄 제목.
            page, errors = open_page(context, base)
            url = entry_url(base, theme, TWO_LINE_TITLE)
            page.goto(url, wait_until="load")
            settle(page, "tablet-sidebar-header")
            try:
                open_title_folder(page)
            except Exception as error:  # noqa: BLE001
                errors.append(f"folder open: {error}")
            two_line = measure(page)
            states[f"{theme}-folder-two-line"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-folder-two-line", width, height),
                "metrics": two_line,
                "errors": list(errors),
            }
            two_title = two_line["titleRead"]
            checks.check(f"{name} 두 줄 제목 상자 높이 {TITLE_TWO_LINE_HEIGHT}",
                         two_title is not None and two_title["container"] is not None
                         and abs(two_title["container"]["height"] - TITLE_TWO_LINE_HEIGHT)
                         <= EDGE_TOLERANCE,
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
                         else {"oneLineTop": title["box"]["top"],
                               "twoLineTop": two_title["box"]["top"]})
            check_title_alignment(f"{name} 두 줄 제목", two_line, checks)
            header = two_line["headers"]["task-workspace-tablet-header"]
            listing = two_line["list"]
            checks.check(f"{name} 목록 내용이 자란 머리 아래에서 시작",
                         header is not None and listing is not None
                         and listing["top"] >= header["bottom"] - EDGE_TOLERANCE,
                         {"listTop": None if listing is None else listing["top"],
                          "headerBottom": None if header is None else header["bottom"]})
            checks.check(f"{name} 두 줄 제목 페이지 오류 없음", not errors, errors)
            page.close()

            # 세 줄을 넘는 긴 이름: 읽기와 편집(포커스 유지).
            page, errors = open_page(context, base)
            url = entry_url(base, theme, LONG_TITLES[0])
            page.goto(url, wait_until="load")
            settle(page, "tablet-sidebar-header")
            try:
                open_title_folder(page)
            except Exception as error:  # noqa: BLE001
                errors.append(f"folder open: {error}")
            long_read = measure(page)
            states[f"{theme}-folder-long-read"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-folder-long-read", width, height),
                "metrics": long_read,
            }
            check_title_read(f"{name} 긴 이름 폴더 칸", long_read, checks)
            open_title_editor(page, errors)
            long_edit = measure(page)
            states[f"{theme}-folder-long-edit"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-folder-long-edit", width, height),
                "metrics": long_edit,
                "errors": list(errors),
            }
            check_title_edit(f"{name} 긴 이름 폴더 칸", long_read, long_edit, checks)
            checks.check(f"{name} 긴 이름 폴더 칸 페이지 오류 없음", not errors, errors)
            page.close()
            continue

        # 세로 덮개에서 세 줄을 넘는 긴 이름 두 가지: 읽기와 편집.
        for index, long_title in enumerate(LONG_TITLES, start=1):
            page, errors = open_page(context, base)
            url = entry_url(base, theme, long_title)
            page.goto(url, wait_until="load")
            settle(page, "tablet-sidebar-header")
            try:
                open_session(page, LONG_TITLE_SESSION)
            except Exception as error:  # noqa: BLE001
                errors.append(f"long cover open {index}: {error}")
            long_read = measure(page)
            states[f"{theme}-cover-long-{index}-read"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-cover-long-{index}-read",
                                   width, height),
                "metrics": long_read,
            }
            check_title_read(f"{name} 긴 이름 {index} 커버", long_read, checks)
            open_title_editor(page, errors)
            long_edit = measure(page)
            states[f"{theme}-cover-long-{index}-edit"] = {
                "url": url,
                "screenshot": shot(page, out, f"{name}-cover-long-{index}-edit",
                                   width, height),
                "metrics": long_edit,
                "errors": list(errors),
            }
            check_title_edit(f"{name} 긴 이름 {index} 커버", long_read, long_edit, checks)
            checks.check(f"{name} 긴 이름 {index} 커버 페이지 오류 없음", not errors, errors)
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
        check_composer_pair(f"{name} 커멘트·대화 입력", metrics, checks)
        check_scroll_above_dock(f"{name} 목록 스크롤", metrics, checks)
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


REVIEW_SAMPLE_JS = r"""
(id) => {
  const round = (value) => Math.round(value * 100) / 100;
  const root = document.querySelector(`[data-testid="${id}"]`);
  if (!root) return null;
  const rect = root.getBoundingClientRect();
  const boxes = Array.from(root.querySelectorAll('[data-testid="chat-composer-box"]'));
  const box = boxes.length ? boxes[0].getBoundingClientRect() : null;
  return {
    box: {top: round(rect.top), bottom: round(rect.bottom),
          width: round(rect.width), height: round(rect.height)},
    composerCount: boxes.length,
    composer: box ? {top: round(box.top), bottom: round(box.bottom), left: round(box.left),
                     right: round(box.right), width: round(box.width), height: round(box.height)}
                  : null,
    borderWidth: boxes.length ? getComputedStyle(boxes[0]).borderTopWidth : null,
    background: boxes.length ? getComputedStyle(boxes[0]).backgroundColor : null,
  };
}
"""


def capture_review_chat(context: BrowserContext, base: str, out: Path,
                        checks: Checks) -> dict:
    states: dict[str, dict] = {}
    width, height = 834, 1210
    for theme in THEMES:
        page, errors = open_page(context, base)
        url = review_chat_url(base, theme)
        page.goto(url, wait_until="load")
        sample = page.get_by_test_id("review-chat-composer-surface-none")
        try:
            sample.wait_for(state="visible", timeout=20000)
        except Exception as error:  # noqa: BLE001
            errors.append(f"surface none sample wait: {error}")
        page.wait_for_timeout(600)
        path = out / f"review-chat-surface-none-{theme}.png"
        try:
            sample.screenshot(path=str(path))
        except Exception as error:  # noqa: BLE001
            errors.append(f"surface none screenshot: {error}")
            path = Path("")
        metrics = page.evaluate(REVIEW_SAMPLE_JS, "review-chat-composer-surface-none")
        states[theme] = {"url": url, "screenshot": str(path), "metrics": metrics,
                         "errors": list(errors)}
        checks.check(f"review-chat {theme} surface none 샘플 존재",
                     metrics is not None, metrics)
        checks.check(f"review-chat {theme} surface none 입력 상자 하나",
                     metrics is not None and metrics["composerCount"] == 1, metrics)
        checks.check(f"review-chat {theme} surface none 테두리 없음",
                     metrics is not None and metrics["borderWidth"] == "0px", metrics)
        checks.check(f"review-chat {theme} 페이지 오류 없음", not errors, errors)
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
                    context = browser.new_context(
                        viewport={"width": 834, "height": 1210},
                        device_scale_factor=2,
                    )
                    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
                    result["reviewChat"] = capture_review_chat(context, base, out, checks)
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

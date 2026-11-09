#!/usr/bin/env python3
"""듀오 레일 캡슐의 적응형 리퀴드 글래스와 PAS 카드 목록 겹침 시각 검수.

무엇을 검수하나
---------------
- 레일 캡슐(`RailCapsule`)은 `colorScheme="adaptive"`다. 웹 하네스는 native 유리가 없어
  blur 대체 경로로 렌더되며, 이 경로는 앱 테마 토큰을 따른다(예전의 고정 밝은 유리와
  고정 `#111111`/`#002b66` 색은 제거됐다).
  - 캡슐 배경: 다크 `rgba(28, 28, 30, 0.58)`, 라이트 `rgba(242, 242, 247, 0.58)` (chrome blur).
  - 아이콘: 비선택 다크 `rgb(212, 212, 219)` / 라이트 `rgb(83, 87, 93)`,
    선택 다크 `rgb(74, 158, 255)` / 라이트 `rgb(10, 132, 255)` (하단 탭바와 같은 토큰).
  - 배지: 배경 다크 `rgb(23, 53, 82)` / 라이트 `rgb(216, 235, 255)`, 글자는 선택 아이콘 색.
  - 점: 선택 아이콘 색.
- 캡슐 크기 계약(폭 48)과 24pt 곡률, 외곽선 0, blur, 반투명을 유지한다.
- context·nav 캡슐 사이에는 compact 4px, 기본 8px의 레이아웃 간격이 남는다.
- 불변: 캡슐이 아닌 chrome(하단 탭바 유리)은 다크 테마에서 계속 어두운 유리를 쓰고
  외곽선을 두지 않는다. 새 대화 합성기도 바깥 유리 한 겹과 경계선 없는 입력 박스를 유지한다.
- 리뷰 화면 `?theme=dark`는 루트 프레임과 NavigationContainer 배경을 `#0f0f0f`로 칠한다.
- PAS 카드 목록(`?sample=pas-layout&board=ops`, 운영 형태 카드 15장):
  - 듀오 안쪽 세로(duoTopBand): 목록 영역이 캡슐 때문에 줄어들지 않고 화면 아래까지 이어지며,
    캡슐이 목록 위에 떠 있고, 스크롤 끝에서 마지막 카드가 캡슐 위로 온전히 보인다.
  - 듀오 안쪽 세로에서 목록 스크롤 영역의 아래 끝은 화면 아래 끝과 같고(1px 허용), 스크롤 끝에서
    마지막 카드와 캡슐 사이 간격은 8px다. 주간 사용량 열이 켜진 경로도 같은 값을 낸다.
  - 로딩·빈 목록·실패 화면(`state=loading|empty|error`)의 스피너·글자·다시 시도 단추는
    상단 홈 캡슐(`duo-rail-back-capsule`)과 겹치지 않는다.
  - 듀오 안쪽 가로(duoSideBand): 캡슐이 오른쪽 띠에 있고, 스크롤 끝에서 마지막 카드가
    캡슐에 가리지 않는다.
  첫 화면 캡처는 목록의 첫 카드 위치가 그대로인지 보여 준다. 중간 스크롤 캡처는 목록이
  캡슐 뒤로 이어지는 모습을 보여 준다.
- 듀오 펼침 가로 메인 보드(`board-corner-*`): 오른쪽 위 모서리 확대 캡처에서 숨은 카드 시트
  그림자가 보드 오른쪽 가장자리에 어두운 띠나 네모 조각을 만들지 않는다(그림자 알파 0).
  공용 `CardPanelOverlayFrame`을 쓰는 PAS 카드 시트의 열림 상태도 함께 캡처해 그림자가 남는지 본다.
- 캡슐이 떠 있는 다른 레이아웃(B2):
  - 듀오 안쪽 세로 메인 카드 보드·폴더 서랍·피드 서랍: 캡슐은 상단 상태 띠(duo-top-band)에 있고
    안전 영역 콘텐츠/서랍과 겹치지 않는다. 콘텐츠 영역은 캡슐 때문에 줄지 않는다.
  - 듀오 안쪽 가로 메인: 캡슐은 오른쪽 띠에 있고 안전 영역 콘텐츠와 겹치지 않는다.
  - 듀오 접힘(바깥 세로·가로): 캡슐은 `phone-rail-tab-rail` 띠 안에 있고, 카드 보드를
    가로 끝까지 스크롤해도 마지막 레인 열이 캡슐과 겹치지 않는다.
  - iPad: 떠 있는 레일 캡슐이 없다. `TabletPersistentEntry`는 헤더의 LiquidGlassButton이다.

native 유리 가장자리는 웹 하네스에 보이지 않는다(blur 대체 경로). native 경로의
overflow/borderCurve 계약은 Jest 렌더 테스트가 검증하며, 실기기 빌드에서만 눈으로 확인된다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 리포 루트에서 이 스크립트를 실행한다(사용자 site-packages의 Playwright 사용):
       python3 -P soul-app/scripts/capture-duo-rail-capsule.py \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out /home/eias/workspace/.local/tmp/duo-rail-capsule-1095

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

PREFIX = "/assets/ios-components/"

# (id, width, height, 캡슐 testID)
CAPSULE_FRAMES = [
    ("outer-portrait", 466, 678, "phone-rail-tab-cluster"),
    ("outer-landscape", 678, 466, "phone-rail-tab-cluster"),
    ("inner-landscape", 951, 669, "duo-main-navigation-capsule"),
]
THEMES = ("dark", "light")

# B2: 캡슐이 떠 있는 레이아웃별 콘텐츠 겹침 검수.
# mode top: 캡슐이 상단 상태 띠에 있어 콘텐츠 영역 위에서 끝난다.
# mode side: 캡슐이 오른쪽 띠에 있어 콘텐츠 영역 오른쪽에서 시작한다.
# mode band: 캡슐이 레일 띠 안에 있고, 보드를 끝까지 스크롤한 마지막 레인도 겹치지 않는다.
# mode none: 떠 있는 레일 캡슐이 없어야 한다(iPad).
B2_LAYOUTS = [
    {"id": "main-inner-portrait", "frame": "inner-portrait", "width": 669, "height": 951,
     "capsules": ["duo-top-band-capsule", "duo-top-band-navigation-capsule"],
     "contents": ["tablet-safe-area-content"], "mode": "top", "extra": "project-view=board",
     "board": True},
    {"id": "folder-inner-portrait", "frame": "inner-portrait", "width": 669, "height": 951,
     "capsules": ["duo-top-band-capsule", "duo-top-band-navigation-capsule"],
     "contents": ["duo-folder-drawer"], "mode": "top", "extra": "project-view=board",
     "click": "duo-main-menu"},
    {"id": "feed-inner-portrait", "frame": "inner-portrait", "width": 669, "height": 951,
     "capsules": ["duo-top-band-capsule", "duo-top-band-navigation-capsule"],
     "contents": ["duo-feed-drawer"], "mode": "top", "extra": "project-view=board",
     "click": "duo-main-feed"},
    {"id": "main-inner-landscape", "frame": "inner-landscape", "width": 951, "height": 669,
     "capsules": ["duo-main-band-capsule", "duo-main-navigation-capsule"],
     "contents": ["tablet-safe-area-content"], "mode": "side", "extra": "project-view=board",
     "board": True},
    {"id": "folded-outer-portrait", "frame": "outer-portrait", "width": 466, "height": 678,
     "capsules": ["phone-rail-tab-cluster", "duo-rail-context-capsule"],
     "contents": ["phone-rail-tab-rail"], "mode": "band", "boardEnd": True},
    {"id": "folded-outer-landscape", "frame": "outer-landscape", "width": 678, "height": 466,
     "capsules": ["phone-rail-tab-cluster", "duo-rail-context-capsule"],
     "contents": ["phone-rail-tab-rail"], "mode": "band", "boardEnd": True},
    {"id": "ipad-portrait", "frame": "ipad-pro-13-portrait", "width": 1032, "height": 1376,
     "capsules": ["phone-rail-tab-cluster", "duo-main-band-capsule", "duo-top-band-capsule",
                  "persistent-session-duo-capsule"],
     "contents": ["tablet-persistent-entry"], "mode": "none"},
]

# expo-blur의 웹 구현은 tint별 자체 배경색을 style 뒤에 덧붙여 앱 토큰 배경을 덮는다.
# 그래서 웹 캡처에서 보이는 캡슐 색은 tint('dark'/'light')의 expo-blur 기본값이다.
# (intensity 74 → alpha 74 * 0.78 / 100 = 0.5772, 브라우저 표기 0.58)
# tint는 앱 외양(t.mode)에서 고르므로 캡슐은 여전히 앱 테마를 따른다.
CAPSULE_FILL_RGBA = {"dark": (25.0, 25.0, 25.0, 0.5772), "light": (249.0, 249.0, 249.0, 0.5772)}
UNSELECTED_ICON_RGB = {"dark": (212, 212, 219), "light": (83, 87, 93)}
SELECTED_ICON_RGB = {"dark": (74, 158, 255), "light": (10, 132, 255)}
BADGE_BG_RGB = {"dark": (23, 53, 82), "light": (216, 235, 255)}
DARK_CANVAS_RGB = (15, 15, 15)

MEASURE_JS = r"""
(capsuleTestId) => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const capsule = document.querySelector(`[data-testid="${capsuleTestId}"]`);
  const style = capsule ? getComputedStyle(capsule) : null;
  const iconLeaves = capsule
    ? [...capsule.querySelectorAll('*')].filter((element) => (
        element.children.length === 0
        && getComputedStyle(element).fontSize === '18px'
        && getComputedStyle(element).color !== 'rgba(0, 0, 0, 0)'
      ))
    : [];
  const fullFrame = [...document.querySelectorAll('div')]
    .filter((element) => {
      const r = element.getBoundingClientRect();
      return Math.abs(r.left) < 0.5 && Math.abs(r.top) < 0.5
        && Math.abs(r.width - innerWidth) < 0.5 && Math.abs(r.height - innerHeight) < 0.5
        && getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)';
    })
    .map((element) => getComputedStyle(element).backgroundColor);
  return {
    window: { width: innerWidth, height: innerHeight },
    capsule: capsule ? {
      rect: box(capsule),
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
      borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      borderRadius: style.borderTopLeftRadius,
    } : null,
    icons: iconLeaves.map((element) => getComputedStyle(element).color),
    fullFrameBackgrounds: fullFrame,
  };
}
"""

CLUSTER_GAP_JS = r"""
([contextTestId, navTestId]) => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (testId) => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), height: round(r.height) };
  };
  const context = box(contextTestId);
  const nav = box(navTestId);
  return {
    context,
    nav,
    gap: context && nav ? round(nav.top - context.bottom) : null,
  };
}
"""

BADGE_JS = r"""
() => {
  const info = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    return { testId: element.dataset ? element.dataset.testid : undefined,
      rect: { width: Math.round(r.width), height: Math.round(r.height) },
      backgroundColor: style.backgroundColor, color: style.color };
  };
  const bySuffix = (suffix) => [...document.querySelectorAll('[data-testid]')]
    .filter((element) => element.dataset.testid.endsWith(suffix))
    .map(info);
  return { badges: bySuffix('-badge'), dots: bySuffix('-dot') };
}
"""

PAS_LIST_JS = r"""
({ scroll, top, mid }) => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const list = document.querySelector('[data-testid="persistent-task-list"]');
  if (!list) return { list: null };
  const scroller = [list, ...list.querySelectorAll('*')].find((element) => {
    const style = getComputedStyle(element);
    return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  }) || list;
  if (top) scroller.scrollTop = 0;
  if (mid) scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
  if (scroll) scroller.scrollTop = scroller.scrollHeight;
  const capsule = document.querySelector('[data-testid="persistent-session-duo-capsule"]');
  const screen = document.querySelector('[data-testid="persistent-session-screen"]');
  const panel = document.querySelector('[data-testid="persistent-session-card-panel"]');
  const band = document.querySelector('[data-testid="persistent-session-duo-band"]');
  const usageColumn = document.querySelector('[data-testid="persistent-session-usage-column"]');
  const rows = [...document.querySelectorAll('[data-testid^="card-row-"]')]
    .map((element) => box(element))
    .filter((rect) => rect.height > 0);
  return {
    window: { width: innerWidth, height: innerHeight },
    list: box(list),
    screen: screen ? box(screen) : null,
    panel: panel ? box(panel) : null,
    band: band ? box(band) : null,
    usageColumn: usageColumn ? box(usageColumn) : null,
    scroller: { rect: box(scroller), scrollTop: round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    capsule: capsule ? box(capsule) : null,
    rowCount: rows.length,
    firstRow: rows[0] ?? null,
    lastRow: rows[rows.length - 1] ?? null,
    atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1,
  };
}
"""

STATE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom) };
  };
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  // Text 요소의 상자에는 paddingTop이 포함되므로, 캡슐과 겹치는지는 글자 줄 사각형으로 잰다.
  const lineRects = (element) => {
    if (!element) return [];
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()]
      .map((rect) => ({ left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom) }));
  };
  const errorText = q('persistent-task-list-error');
  const textRects = lineRects(errorText);
  const emptyText = q('persistent-task-list-empty');
  const emptyTextRects = lineRects(emptyText);
  const errorState = q('persistent-task-list-error-state');
  return {
    window: { width: innerWidth, height: innerHeight },
    panel: box(q('persistent-session-card-panel')),
    home: box(q('duo-rail-back-capsule')),
    capsule: box(q('persistent-session-duo-capsule')),
    loading: box(q('persistent-task-list-loading')),
    spinner: box(q('persistent-task-list-loading')?.firstElementChild),
    errorState: box(errorState),
    errorText: box(errorText),
    errorTextRects: textRects,
    retryButton: box(errorState?.lastElementChild),
    empty: box(emptyText),
    emptyTextRects,
  };
}
"""

BOARD_EDGE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const pane = document.querySelector('[data-testid="split-panel-main"]');
  if (!pane) return { pane: null, sheet: null };
  const sheet = document.querySelector('[data-testid="task-workspace-sheet"]');
  const r = pane.getBoundingClientRect();
  const paneStyle = getComputedStyle(pane);
  const sheetStyle = sheet ? getComputedStyle(sheet) : null;
  return {
    window: { width: innerWidth, height: innerHeight },
    pane: { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      backgroundColor: paneStyle.backgroundColor, borderRadius: paneStyle.borderTopRightRadius,
      borderColor: paneStyle.borderTopColor, borderWidth: paneStyle.borderTopWidth },
    sheet: sheet ? { boxShadow: sheetStyle.boxShadow, opacity: sheetStyle.opacity,
      transform: sheetStyle.transform } : null,
  };
}
"""

OPEN_SHEET_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const sheet = document.querySelector('[data-testid="persistent-card-overlay-sheet"]');
  if (!sheet) return { sheet: null };
  const style = getComputedStyle(sheet);
  const r = sheet.getBoundingClientRect();
  return { sheet: { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
    boxShadow: style.boxShadow, opacity: style.opacity, transform: style.transform } };
}
"""

B2_JS = r"""
({ capsuleIds, contentIds }) => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const find = (id) => document.querySelector(`[data-testid="${id}"]`);
  const found = {};
  const capsules = [];
  for (const id of capsuleIds) {
    const element = find(id);
    found[id] = Boolean(element);
    if (element) capsules.push({ id, ...box(element) });
  }
  const contents = [];
  for (const id of contentIds) {
    const element = find(id);
    if (element) contents.push({ id, ...box(element) });
  }
  const board = find('card-board');
  const columns = [...document.querySelectorAll('[data-testid^="card-board-column-"]')]
    .map((element) => ({ id: element.dataset.testid, ...box(element) }));
  return {
    window: { width: innerWidth, height: innerHeight },
    found,
    capsules,
    contents,
    board: board ? { ...box(board), scrollLeft: round(board.scrollLeft),
      scrollWidth: board.scrollWidth, clientWidth: board.clientWidth } : null,
    columns,
  };
}
"""

B2_BOARD_END_JS = r"""
() => {
  const board = document.querySelector('[data-testid="card-board"]');
  if (!board) return null;
  board.scrollLeft = board.scrollWidth;
  return { scrollLeft: board.scrollLeft, scrollWidth: board.scrollWidth, clientWidth: board.clientWidth };
}
"""

TAB_BAR_GLASS_JS = r"""
() => {
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist || !tablist.parentElement) return null;
  const glass = [...tablist.parentElement.querySelectorAll('*')].filter((element) => {
    const style = getComputedStyle(element);
    return (style.backdropFilter || style.webkitBackdropFilter || 'none') !== 'none';
  });
  return glass.map((element) => ({
    backgroundColor: getComputedStyle(element).backgroundColor,
    borderColor: getComputedStyle(element).borderTopColor,
    borderWidth: getComputedStyle(element).borderTopWidth,
    backdropFilter: getComputedStyle(element).backdropFilter
      || getComputedStyle(element).webkitBackdropFilter,
  }));
}
"""

COMPOSER_JS = r"""
() => {
  const frame = document.querySelector('[data-testid="card-composer"]');
  const box = frame ? frame.querySelector('[data-testid="chat-composer-box"]') : null;
  if (!frame || !box) return null;
  const boxStyle = getComputedStyle(box);
  const glassLayers = [...frame.querySelectorAll('*')].filter((element) => {
    const style = getComputedStyle(element);
    return (style.backdropFilter || style.webkitBackdropFilter || 'none') !== 'none';
  });
  return {
    box: {
      backdropFilter: boxStyle.backdropFilter || boxStyle.webkitBackdropFilter || 'none',
      borderWidth: boxStyle.borderTopWidth,
      backgroundColor: boxStyle.backgroundColor,
    },
    glassLayers: glassLayers.map((element) => ({
      borderWidth: getComputedStyle(element).borderTopWidth,
      borderRadius: getComputedStyle(element).borderTopLeftRadius,
      backdropFilter: getComputedStyle(element).backdropFilter
        || getComputedStyle(element).webkitBackdropFilter,
    })),
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
            def log_message(self, *args):  # noqa: D401 - fixture server logs are noise
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
    """검수 항목을 모두 기록한다. 실패해도 나머지 프레임 캡처를 계속해 증거를 남긴다."""

    def __init__(self):
        self.entries: list[dict] = []

    def check(self, name: str, condition: bool, detail):
        self.entries.append({"name": name, "passed": bool(condition), "detail": detail})


def parse_rgb(value: str) -> tuple[tuple[float, float, float], float]:
    text = value.strip()
    if text.startswith("rgb("):
        channels = [float(part) for part in text[4:-1].split(",")]
        return (channels[0], channels[1], channels[2]), 1.0
    if text.startswith("rgba("):
        channels = [float(part) for part in text[5:-1].split(",")]
        return (channels[0], channels[1], channels[2]), channels[3]
    raise ValueError(f"지원하지 않는 색 형식: {value}")


def rgb_text(rgb: tuple[int, int, int]) -> str:
    return f"rgb({rgb[0]}, {rgb[1]}, {rgb[2]})"


def shadow_max_alpha(value: str | None) -> float:
    """box-shadow 문자열에서 가장 큰 알파를 읽는다. none/투명 그림자는 0."""
    if not value or value.strip() == "none":
        return 0.0
    alphas = [float(match.group(1)) for match in re.finditer(r"rgba\([^)]*,\s*([0-9.]+)\)", value)]
    return max(alphas) if alphas else 1.0


def page_url(base: str, frame_id: str, theme: str, extra: str = "") -> str:
    query = f"section=iphoneDuo&sample=main-layout&frame={frame_id}&board=ops&theme={theme}"
    if extra:
        query += f"&{extra}"
    return f"{base}{PREFIX}index.html?{query}"


def pas_url(base: str, frame_id: str, theme: str, extra: str = "") -> str:
    query = (f"section=iphoneDuo&sample=pas-layout&frame={frame_id}&board=ops&theme={theme}")
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


def shot(page: Page, out: Path, name: str, width: int, height: int) -> str:
    path = out / f"{name}.png"
    page.screenshot(path=str(path), clip={"x": 0, "y": 0, "width": width, "height": height})
    return str(path)


def open_page(context: BrowserContext, base: str, url: str) -> tuple[Page, list[str]]:
    page = context.new_page()
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", lambda route: route.continue_()
               if route.request.url.startswith(base) else route.abort())
    page.goto(url, wait_until="load")
    return page, errors


def capture_capsule_frame(browser: Browser, base: str, out: Path, frame_id: str,
                          width: int, height: int, capsule_test_id: str,
                          theme: str, checks: Checks) -> dict:
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = page_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    settle(page, capsule_test_id)
    metrics = page.evaluate(MEASURE_JS, capsule_test_id)
    cluster_gap = None
    if frame_id in ("outer-portrait", "outer-landscape"):
        cluster_gap = page.evaluate(
            CLUSTER_GAP_JS, ["duo-rail-context-capsule", "phone-rail-tab-cluster"])
    screenshot = shot(page, out, f"capsule-{frame_id}-{theme}", width, height)
    page.close()
    context.close()

    prefix = f"{frame_id}/{theme}"
    capsule = metrics["capsule"]
    checks.check(f"{prefix} 캡슐 존재", capsule is not None, metrics)
    checks.check(f"{prefix} 캡슐 폭 48", capsule and abs(capsule["rect"]["width"] - 48) <= 1,
                 capsule["rect"] if capsule else None)
    checks.check(f"{prefix} 24pt 곡률", capsule and capsule["borderRadius"] == "24px",
                 capsule["borderRadius"] if capsule else None)

    fill_rgb, fill_alpha = parse_rgb(capsule["backgroundColor"])
    expected_fill = CAPSULE_FILL_RGBA[theme]
    fill_matches = (abs(fill_rgb[0] - expected_fill[0]) <= 0.6
                    and abs(fill_rgb[1] - expected_fill[1]) <= 0.6
                    and abs(fill_rgb[2] - expected_fill[2]) <= 0.6
                    and abs(fill_alpha - expected_fill[3]) <= 0.02)
    checks.check(f"{prefix} 캡슐이 앱 테마 유리 {capsule['backgroundColor']}",
                 fill_matches, {"backgroundColor": capsule["backgroundColor"],
                                "expected": f"rgba({expected_fill[0]:.0f}, {expected_fill[1]:.0f}, "
                                            f"{expected_fill[2]:.0f}, {expected_fill[3]})"})
    checks.check(f"{prefix} 캡슐이 반투명", fill_alpha < 1, capsule["backgroundColor"])
    checks.check(f"{prefix} backdrop blur", "blur(" in (capsule["backdropFilter"] or ""),
                 capsule["backdropFilter"])
    checks.check(f"{prefix} 외곽선 0", capsule["borderWidth"] == "0px", capsule["borderWidth"])

    if cluster_gap is not None:
        expected_gap = 4 if width > height else 8
        checks.check(f"{prefix} 캡슐 사이 레이아웃 간격 {expected_gap}px",
                     cluster_gap["gap"] is not None
                     and abs(cluster_gap["gap"] - expected_gap) <= 0.5,
                     cluster_gap)

    expected_unselected = rgb_text(UNSELECTED_ICON_RGB[theme])
    expected_selected = rgb_text(SELECTED_ICON_RGB[theme])
    unselected = [color for color in metrics["icons"] if color == expected_unselected]
    unknown = [color for color in metrics["icons"] if color not in (expected_unselected, expected_selected)]
    checks.check(f"{prefix} 비선택 아이콘 색", bool(unselected), metrics["icons"])
    checks.check(f"{prefix} 예상 밖 아이콘 색 없음", not unknown, unknown)

    canvas = metrics["fullFrameBackgrounds"]
    if theme == "dark":
        expected_canvas = rgb_text(DARK_CANVAS_RGB)
        checks.check(f"{prefix} 다크 캔버스(루트+내비게이션) 2겹", canvas.count(expected_canvas) >= 2, canvas)

    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "screenshot": screenshot, "metrics": metrics, "clusterGap": cluster_gap}


def capture_badge_states(browser: Browser, base: str, out: Path, checks: Checks) -> dict:
    states: dict[str, dict] = {}
    for view in ("rail-badge", "rail-dot"):
        for theme in THEMES:
            context = browser.new_context(viewport={"width": 466, "height": 678}, device_scale_factor=2)
            context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
            url = page_url(base, "outer-portrait", theme, f"view={view}")
            page, errors = open_page(context, base, url)
            settle(page, "duo-rail-context-capsule")
            metrics = page.evaluate(BADGE_JS)
            screenshot = shot(page, out, f"capsule-{view}-{theme}", 466, 678)
            page.close()
            context.close()

            prefix = f"{view}/{theme}"
            expected_bg = rgb_text(BADGE_BG_RGB[theme])
            expected_accent = rgb_text(SELECTED_ICON_RGB[theme])
            if view == "rail-badge":
                badge = metrics["badges"][0] if metrics["badges"] else None
                checks.check(f"{prefix} 배지 존재", badge is not None, metrics)
                checks.check(f"{prefix} 배경 {expected_bg}", badge and badge["backgroundColor"] == expected_bg,
                             badge)
                checks.check(f"{prefix} 글자 {expected_accent}", badge and badge["color"] == expected_accent,
                             badge)
            else:
                dot = metrics["dots"][0] if metrics["dots"] else None
                checks.check(f"{prefix} 점 존재", dot is not None, metrics)
                checks.check(f"{prefix} 점 {expected_accent}",
                             dot and dot["backgroundColor"] == expected_accent, dot)
            checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
            states[f"{view}-{theme}"] = {"url": url, "screenshot": screenshot, "metrics": metrics}
    return states


def overlaps(first: dict | None, second: dict | None) -> bool:
    if not first or not second:
        return False
    return (first["left"] < second["right"] and first["right"] > second["left"]
            and first["top"] < second["bottom"] and first["bottom"] > second["top"])


def capture_pas_card_list(browser: Browser, base: str, out: Path, frame_id: str,
                          width: int, height: int, theme: str, checks: Checks) -> dict:
    """PAS 카드 목록이 떠 있는 캡슐 뒤로 이어지고, 스크롤 끝에서 마지막 카드가 보이는지."""
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = pas_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    settle(page, "persistent-session-duo-tasks")
    page.get_by_test_id("persistent-session-duo-tasks").click()
    page.wait_for_selector('[data-testid^="card-row-"]', timeout=20000)
    # 기본 설정은 todo 그룹을 접어 둔다. 운영 형태 카드 10장 이상을 보이도록 펼친다.
    todo_header = page.get_by_test_id("persistent-task-group-header-todo")
    if todo_header.count():
        todo_header.click()
    page.wait_for_timeout(600)

    # 그룹 헤더 클릭이 스크롤을 옮길 수 있으므로 첫 화면은 맨 위로 되돌린 뒤 잰다.
    page.evaluate(PAS_LIST_JS, {"scroll": False, "top": True, "mid": False})
    page.wait_for_timeout(300)
    first = page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": False})
    first_shot = shot(page, out, f"pas-list-{frame_id}-{theme}-first", width, height)
    page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": True})
    page.wait_for_timeout(400)
    mid = page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": False})
    mid_shot = shot(page, out, f"pas-list-{frame_id}-{theme}-mid", width, height)
    page.evaluate(PAS_LIST_JS, {"scroll": True, "top": False, "mid": False})
    page.wait_for_timeout(500)
    end = page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": False})
    end_shot = shot(page, out, f"pas-list-{frame_id}-{theme}-end", width, height)
    page.close()
    context.close()

    prefix = f"pas-list/{frame_id}/{theme}"
    checks.check(f"{prefix} 카드 목록 존재", first["list"] is not None, first)
    checks.check(f"{prefix} 운영 형태 카드 10장 이상", first["rowCount"] >= 10, first["rowCount"])
    checks.check(f"{prefix} 캡슐 존재", first["capsule"] is not None, first["capsule"])

    list_rect = first["list"]
    capsule = first["capsule"]
    if list_rect and capsule:
        layout_detail = {"window": first["window"], "screen": first["screen"], "panel": first["panel"],
                         "list": list_rect, "band": first["band"], "capsule": capsule}
        if frame_id.startswith("inner-portrait"):
            # duoTopBand: 목록 영역이 캡슐 때문에 줄지 않고, 캡슐이 목록 위에 떠 있다.
            checks.check(f"{prefix} 목록 영역이 캡슐에 줄지 않고 캡슐 뒤로 이어진다",
                         overlaps(list_rect, capsule), layout_detail)
        else:
            # duoSideBand: 캡슐은 오른쪽 띠에 있어 목록 영역과 겹치지 않는다.
            checks.check(f"{prefix} 캡슐이 목록 영역 밖 오른쪽 띠에 있다",
                         not overlaps(list_rect, capsule), layout_detail)
        checks.check(f"{prefix} 첫 카드가 목록 안에 보인다",
                     first["firstRow"] is not None
                     and first["firstRow"]["top"] >= list_rect["top"] - 0.5
                     and first["firstRow"]["bottom"] <= list_rect["bottom"] + 0.5,
                     {"firstRow": first["firstRow"], "list": list_rect})
        checks.check(f"{prefix} 스크롤이 끝까지 간다", end["atEnd"], end["scroller"])
        checks.check(f"{prefix} 스크롤 끝 마지막 카드가 캡슐에 가리지 않는다",
                     end["lastRow"] is not None and not overlaps(end["lastRow"], capsule),
                     {"lastRow": end["lastRow"], "capsule": capsule,
                      "gap": round(capsule["top"] - end["lastRow"]["bottom"], 2)
                      if end["lastRow"] else None})
        if frame_id == "inner-portrait":
            # R1: duoTopBand에서 패널 paddingBottom이 0이라야 목록이 화면 아래 끝까지 이어진다.
            checks.check(f"{prefix} 목록이 화면 아래 끝까지 이어진다",
                         abs(list_rect["bottom"] - first["window"]["height"]) <= 1,
                         {"list": list_rect, "panel": first["panel"], "window": first["window"]})
            gap = round(capsule["top"] - end["lastRow"]["bottom"], 2) if end["lastRow"] else None
            checks.check(f"{prefix} 스크롤 끝 마지막 카드와 캡슐 간격 8px",
                         gap is not None and abs(gap - 8) <= 1,
                         {"gap": gap, "lastRow": end["lastRow"], "capsule": capsule})
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "first": first, "mid": mid, "end": end,
            "screenshots": {"first": first_shot, "mid": mid_shot, "end": end_shot}}


def capture_pas_usage_list(browser: Browser, base: str, out: Path, width: int, height: int,
                           theme: str, checks: Checks) -> dict:
    """주간 사용량 열이 켜진(usageInColumn) PAS 목록도 같은 아래 끝과 끝 간격인지."""
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = pas_url(base, "inner-portrait", theme)
    page, errors = open_page(context, base, url)
    settle(page, "persistent-session-duo-tasks")
    page.get_by_test_id("persistent-session-duo-tasks").click()
    page.wait_for_selector('[data-testid^="card-row-"]', timeout=20000)
    todo_header = page.get_by_test_id("persistent-task-group-header-todo")
    if todo_header.count():
        todo_header.click()
    # 레일의 주간 사용량 캡슐을 눌러 사용량 열 경로로 만든다.
    page.get_by_test_id("persistent-session-duo-usage").click()
    page.wait_for_timeout(900)
    page.evaluate(PAS_LIST_JS, {"scroll": False, "top": True, "mid": False})
    page.wait_for_timeout(300)
    first = page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": False})
    first_shot = shot(page, out, f"pas-usage-{theme}-first", width, height)
    page.evaluate(PAS_LIST_JS, {"scroll": True, "top": False, "mid": False})
    page.wait_for_timeout(500)
    end = page.evaluate(PAS_LIST_JS, {"scroll": False, "top": False, "mid": False})
    end_shot = shot(page, out, f"pas-usage-{theme}-end", width, height)
    page.close()
    context.close()

    prefix = f"pas-usage/{theme}"
    checks.check(f"{prefix} 사용량 열(usageInColumn) 경로다", first["usageColumn"] is not None,
                 first["usageColumn"])
    checks.check(f"{prefix} 목록이 화면 아래 끝까지 이어진다",
                 first["list"] is not None
                 and abs(first["list"]["bottom"] - first["window"]["height"]) <= 1,
                 {"list": first["list"], "window": first["window"], "panel": first["panel"]})
    checks.check(f"{prefix} 스크롤이 끝까지 간다", end["atEnd"], end["scroller"])
    gap = (round(first["capsule"]["top"] - end["lastRow"]["bottom"], 2)
           if first["capsule"] and end["lastRow"] else None)
    checks.check(f"{prefix} 스크롤 끝 마지막 카드와 캡슐 간격 8px",
                 gap is not None and abs(gap - 8) <= 1,
                 {"gap": gap, "lastRow": end["lastRow"], "capsule": first["capsule"]})
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "first": first, "end": end,
            "screenshots": {"first": first_shot, "end": end_shot}}


def capture_pas_states(browser: Browser, base: str, out: Path, width: int, height: int,
                       checks: Checks) -> dict:
    """로딩·빈 목록·실패 화면이 상단 홈 캡슐과 겹치지 않는지."""
    states: dict[str, dict] = {}
    for state in ("loading", "empty", "error"):
        for theme in THEMES:
            context = browser.new_context(viewport={"width": width, "height": height},
                                          device_scale_factor=2)
            context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
            url = pas_url(base, "inner-portrait", theme, f"state={state}")
            page, errors = open_page(context, base, url)
            settle(page, "persistent-session-duo-tasks")
            page.get_by_test_id("persistent-session-duo-tasks").click()
            page.wait_for_timeout(1200)
            metrics = page.evaluate(STATE_JS)
            screenshot = shot(page, out, f"pas-state-{state}-{theme}", width, height)
            page.close()
            context.close()

            prefix = f"pas-state/{state}/{theme}"
            home = metrics["home"]
            checks.check(f"{prefix} 홈 캡슐 존재", home is not None, metrics)
            checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
            if state == "loading":
                rects = [metrics["spinner"]]
                checks.check(f"{prefix} 로딩 화면 존재", metrics["loading"] is not None, metrics)
            elif state == "empty":
                rects = metrics["emptyTextRects"] or [metrics["empty"]]
                checks.check(f"{prefix} 빈 목록 화면 존재", metrics["empty"] is not None, metrics)
            else:
                rects = [*metrics["errorTextRects"], metrics["retryButton"]]
                checks.check(f"{prefix} 실패 화면 존재", metrics["errorState"] is not None, metrics)
                checks.check(f"{prefix} 다시 시도 단추 존재", metrics["retryButton"] is not None, metrics)
            present = [rect for rect in rects if rect]
            checks.check(f"{prefix} 상태 내용이 홈 캡슐과 겹치지 않는다",
                         home is not None and bool(present)
                         and all(not overlaps(rect, home) for rect in present),
                         {"home": home, "content": rects})
            states[f"{state}-{theme}"] = {"url": url, "screenshot": screenshot, "metrics": metrics}
    return states


def capture_board_corner(browser: Browser, base: str, out: Path, theme: str,
                         checks: Checks) -> dict:
    """R3: 듀오 펼침 가로 메인 보드 오른쪽 위 모서리 확대와 숨은 카드 시트 그림자."""
    context = browser.new_context(viewport={"width": 951, "height": 669}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = page_url(base, "inner-landscape", theme, "project-view=board")
    page, errors = open_page(context, base, url)
    settle(page, "card-board")
    metrics = page.evaluate(BOARD_EDGE_JS)
    corner_path = out / f"board-corner-{theme}.png"
    if metrics["pane"]:
        pane = metrics["pane"]
        page.screenshot(path=str(corner_path), clip={
            "x": max(0, pane["right"] - 140), "y": max(0, pane["top"] - 16),
            "width": 160, "height": 160})
    page.close()
    context.close()

    prefix = f"board-corner/{theme}"
    checks.check(f"{prefix} 보드 패널 존재", metrics["pane"] is not None, metrics)
    checks.check(f"{prefix} 숨은 카드 시트가 그림자를 비추지 않는다",
                 metrics["sheet"] is not None
                 and shadow_max_alpha(metrics["sheet"]["boxShadow"]) == 0,
                 metrics["sheet"])
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "screenshot": str(corner_path), "metrics": metrics}


def capture_open_card_overlay(browser: Browser, base: str, out: Path, checks: Checks) -> dict:
    """공용 CardPanelOverlayFrame을 쓰는 다른 화면(PAS 카드 시트)의 열림 상태 그림자 불변."""
    context = browser.new_context(viewport={"width": 669, "height": 951}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = pas_url(base, "inner-portrait", "light")
    page, errors = open_page(context, base, url)
    settle(page, "persistent-session-duo-tasks")
    page.get_by_test_id("persistent-session-duo-tasks").click()
    page.wait_for_selector('[data-testid^="card-row-"]', timeout=20000)
    page.locator('[data-testid^="card-row-"]').first.click()
    page.wait_for_timeout(1400)
    metrics = page.evaluate(OPEN_SHEET_JS)
    screenshot = shot(page, out, "open-card-overlay-inner-portrait-light", 669, 951)
    page.close()
    context.close()

    checks.check("공용 카드 시트(열림)가 화면에 있다", metrics["sheet"] is not None, metrics)
    checks.check("공용 카드 시트(열림) 그림자 유지",
                 metrics["sheet"] is not None
                 and shadow_max_alpha(metrics["sheet"]["boxShadow"]) > 0.2,
                 metrics["sheet"])
    checks.check("공용 카드 시트(열림) 페이지 오류 없음", not errors, errors)
    return {"url": url, "screenshot": screenshot, "metrics": metrics}


def capture_b2_layout(browser: Browser, base: str, out: Path, spec: dict, theme: str,
                      checks: Checks) -> dict:
    """B2: 캡슐이 떠 있는 레이아웃에서 콘텐츠 겹침과 스크롤 끝 마지막 항목을 잰다."""
    context = browser.new_context(viewport={"width": spec["width"], "height": spec["height"]},
                                  device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = page_url(base, spec["frame"], theme, spec.get("extra", ""))
    page, errors = open_page(context, base, url)
    wait_id = spec["capsules"][0] if spec["mode"] != "none" else spec["contents"][0]
    settle(page, wait_id)
    if spec.get("click"):
        page.get_by_test_id(spec["click"]).click()
        page.wait_for_timeout(800)
    initial = page.evaluate(B2_JS, {"capsuleIds": spec["capsules"],
                                    "contentIds": spec["contents"]})
    screenshot = shot(page, out, f"b2-{spec['id']}-{theme}", spec["width"], spec["height"])
    end = None
    end_shot = None
    if spec.get("boardEnd"):
        page.evaluate(B2_BOARD_END_JS)
        page.wait_for_timeout(500)
        end = page.evaluate(B2_JS, {"capsuleIds": spec["capsules"],
                                    "contentIds": spec["contents"]})
        end_shot = shot(page, out, f"b2-{spec['id']}-{theme}-end", spec["width"], spec["height"])
    page.close()
    context.close()

    prefix = f"b2/{spec['id']}/{theme}"
    capsules = initial["capsules"]
    contents = {entry["id"]: entry for entry in initial["contents"]}
    if spec["mode"] in ("top", "side"):
        checks.check(f"{prefix} 캡슐 존재", len(capsules) == len(spec["capsules"]), initial["found"])
        content = contents.get(spec["contents"][0])
        checks.check(f"{prefix} 콘텐츠 영역 존재", content is not None, initial["contents"])
        if content:
            for capsule in capsules:
                if spec["mode"] == "top":
                    checks.check(f"{prefix} {capsule['id']}가 콘텐츠 영역 위 띠에서 끝난다",
                                 capsule["bottom"] <= content["top"] + 0.5,
                                 {"capsule": capsule, "content": content})
                else:
                    checks.check(f"{prefix} {capsule['id']}가 콘텐츠 영역 오른쪽 띠에서 시작한다",
                                 capsule["left"] >= content["right"] - 0.5,
                                 {"capsule": capsule, "content": content})
    elif spec["mode"] == "band":
        band = contents.get(spec["contents"][0])
        checks.check(f"{prefix} 레일 띠 존재", band is not None, initial["contents"])
        if band:
            checks.check(f"{prefix} 레일 띠가 화면 오른쪽 끝 84px",
                         abs(band["right"] - initial["window"]["width"]) <= 0.5
                         and abs(band["width"] - 84) <= 0.5, band)
            for capsule in capsules:
                checks.check(f"{prefix} {capsule['id']}가 레일 띠 안에 있다",
                             capsule["left"] >= band["left"] - 0.5
                             and capsule["right"] <= band["right"] + 0.5,
                             {"capsule": capsule, "band": band})
        if spec.get("boardEnd"):
            checks.check(f"{prefix} 카드 보드 존재", initial["board"] is not None, initial["board"])
            checks.check(f"{prefix} 카드 보드를 가로 끝까지 스크롤했다",
                         end is not None and end["board"] is not None
                         and end["board"]["scrollLeft"] + end["board"]["clientWidth"]
                         >= end["board"]["scrollWidth"] - 1,
                         end["board"] if end else None)
            if end:
                collisions = [
                    {"column": column, "capsule": capsule}
                    for column in end["columns"] for capsule in end["capsules"]
                    if overlaps(column, capsule)
                ]
                checks.check(f"{prefix} 스크롤 끝 마지막 레인이 캡슐에 가리지 않는다",
                             not collisions, {"collisions": collisions, "columns": end["columns"]})
    else:
        present = [name for name, exists in initial["found"].items() if exists]
        checks.check(f"{prefix} 떠 있는 레일 캡슐 없음", not present, initial["found"])
        checks.check(f"{prefix} TabletPersistentEntry 헤더 버튼 존재",
                     spec["contents"][0] in contents, initial["contents"])
    if spec.get("board"):
        checks.check(f"{prefix} 메인 카드 보드 존재", initial["board"] is not None, initial["board"])
    if spec.get("click"):
        drawer = contents.get(spec["contents"][0])
        checks.check(f"{prefix} 서랍이 열려 화면 안에 있다",
                     drawer is not None and drawer["left"] >= -0.5 and drawer["width"] > 0,
                     drawer)
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "initial": initial, "end": end,
            "screenshots": {"initial": screenshot, "end": end_shot}}


def capture_non_capsule_chrome(browser: Browser, base: str, out: Path, checks: Checks) -> dict:
    """캡슐이 아닌 chrome(하단 탭바 유리)은 다크 테마에서 계속 어두운 유리다."""
    context = browser.new_context(viewport={"width": 393, "height": 852}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = page_url(base, "iphone-17", "dark")
    page, errors = open_page(context, base, url)
    settle(page, "phone-tab-DailyTab")
    glass = page.evaluate(TAB_BAR_GLASS_JS)
    composer = page.evaluate(COMPOSER_JS)
    screenshot = shot(page, out, "invariant-tabbar-dark", 393, 852)
    page.close()
    context.close()

    luminance_ok = []
    for entry in glass or []:
        rgb, alpha = parse_rgb(entry["backgroundColor"])
        luminance_ok.append(max(rgb) <= 40 and alpha < 1)
    checks.check("불변: 하단 탭바 chrome은 어두운 유리", bool(glass) and all(luminance_ok), glass)
    checks.check("불변: 하단 탭바에 blur 유지",
                 bool(glass) and all("blur(" in (entry["backdropFilter"] or "") for entry in glass), glass)
    checks.check("불변: 하단 탭바 chrome 외곽선 0",
                 bool(glass) and all(entry["borderWidth"] == "0px" for entry in glass),
                 [entry["borderWidth"] for entry in glass])
    checks.check("새 대화 합성기 존재", composer is not None, composer)
    if composer:
        checks.check("새 대화 바깥 유리 한 겹", len(composer["glassLayers"]) == 1, composer["glassLayers"])
        checks.check("새 대화 바깥 유리 외곽선 0",
                     all(layer["borderWidth"] == "0px" for layer in composer["glassLayers"]),
                     [layer["borderWidth"] for layer in composer["glassLayers"]])
        checks.check("새 대화 내부 입력 박스 backdrop 없음",
                     composer["box"]["backdropFilter"] == "none", composer["box"])
        checks.check("새 대화 내부 입력 박스 경계선 0",
                     composer["box"]["borderWidth"] == "0px", composer["box"])
    checks.check("불변: 하단 탭바 페이지 오류 없음", not errors, errors)
    return {"url": url, "screenshot": screenshot, "glass": glass, "composer": composer}


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
                    result["capsules"] = {}
                    for frame_id, width, height, capsule_test_id in CAPSULE_FRAMES:
                        for theme in THEMES:
                            result["capsules"][f"{frame_id}-{theme}"] = capture_capsule_frame(
                                browser, base, out, frame_id, width, height, capsule_test_id, theme, checks)
                    result["badges"] = capture_badge_states(browser, base, out, checks)
                    result["pasCardList"] = {}
                    for frame_id, width, height in (("inner-portrait", 669, 951),
                                                    ("inner-landscape", 951, 669)):
                        for theme in THEMES:
                            result["pasCardList"][f"{frame_id}-{theme}"] = capture_pas_card_list(
                                browser, base, out, frame_id, width, height, theme, checks)
                    result["pasUsageList"] = {}
                    for theme in THEMES:
                        result["pasUsageList"][theme] = capture_pas_usage_list(
                            browser, base, out, 669, 951, theme, checks)
                    result["pasStates"] = capture_pas_states(browser, base, out, 669, 951, checks)
                    result["boardCorner"] = {}
                    for theme in THEMES:
                        result["boardCorner"][theme] = capture_board_corner(
                            browser, base, out, theme, checks)
                    result["openCardOverlay"] = capture_open_card_overlay(browser, base, out, checks)
                    result["b2Layouts"] = {}
                    for spec in B2_LAYOUTS:
                        for theme in THEMES:
                            result["b2Layouts"][f"{spec['id']}-{theme}"] = capture_b2_layout(
                                browser, base, out, spec, theme, checks)
                    result["invariant"] = capture_non_capsule_chrome(browser, base, out, checks)
                finally:
                    browser.close()
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "duo-rail-capsule.json").write_text(
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

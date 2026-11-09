#!/usr/bin/env python3
"""듀오 설정 시트 닫기 단추와 포스트잇 카드 제목 위 여백의 전후 시각 검수.

무엇을 검수하나
---------------
1. 설정 시트 닫기 단추 (카드 #1095)
   - 듀오 세로·아이패드 설정 시트의 닫기가 헤더 오른쪽의 유리 원형 X다: 32pt 원,
     999pt 곡률, Ionicons `close`, 접근성 이름 「설정 닫기」, 헤더에 글자 「완료」 없음.
   - X의 시각 원 중심이 제목(styles.title)과 세로 가운데 1px 이내, 오른쪽 끝이
     본문 카드(settings-section-display) 오른쪽 끝선과 1px 이내로 맞는다.
   - 듀오 가로(사이드 밴드)는 헤더 닫기가 없고 레일의 유리 원형 X
     (duo-rail-action-back, 이름 「설정 닫기」)가 그대로 보인다.
   - 유리 원의 위 여백(closeVisual.top - header.top)이 오른쪽 여백(원 오른쪽 끝에서
     화면 끝까지, pageInset)과 같다. 제목과 원은 헤더 안에서 세로 가운데다.
   - 시트 위 끝이 보이도록 하네스가 시트를 안전 영역 위에서 띄운다
     (settings-layout-sheet-frame). 헤더는 시트 위 끝에서 시작한다.
   - 변경 전 상태(`--phase before`)는 헤더에 글자 「완료」가 있고 유리 원이 없다.
   - 아이폰 설정 탭 색인과 하위 화면의 헤더 높이와 제목 윗선이 같다.
   - 시트 사이드바는 바닥까지 채우고 마지막 항목은 바닥 안전 영역 위에 있다.
     본문과 저장 줄의 바닥 좌표는 --baseline으로 변경 전과 비교한다.
1b. 하위 화면 헤더의 뒤로 원 (카드 #1095)
   - 설정 항목 하위, 반복 작업 목록·편집·이력에서 뒤로 단추가 X와 같은 유리 원형
     GlassButton(32pt, 999pt 곡률, Ionicons chevron-back, textPrimary)이다.
   - 뒤로 원과 X 원의 크기·세로 가운데가 같고, 뒤로 원의 왼쪽 끝과 X의 오른쪽 끝이
     본문 내용 끝선과 맞는다(넓은 2단 레이아웃은 헤더가 사이드바 위에 걸쳐 있어
     헤더 줄 기준으로 재고, 본문 카드 끝선과의 차이를 함께 기록한다).
   - 헤더에 글자 「설정」「목록」「편집」이 남지 않는다.
2. 포스트잇 카드 제목 위 여백
   - 카드 위 끝에서 제목까지가 변경 전보다 gap만큼 늘고(paddingTop), 왼쪽·오른쪽
     여백과 푸터 위치는 그대로다. 아래 여백은 늘어난 제목 위 gap을 상쇄하도록
     푸터 간격(footerGap)만큼 줄어든다.
   - 두 줄 제목 카드에서 제목은 두 줄을 유지하고, 본문 요약 1줄과 「볼 것」 줄의
     글자는 잘리지 않는다(넘침 1px 이하).
   - 본문 칸의 자식(진행 줄·본문·「볼 것」 상자)은 네이티브처럼 줄어들지 않고
     (flexShrink 0), 「볼 것」 상자의 자연 높이와 아래끝이 본문 칸 안에 들어온다.
     상자 아래끝에서 푸터 완료 원 단추 윗면까지는 제목↔본문 사이 간격(gap)과 같은
     리듬(2px 이내)이다.
   - 카드 크기(width/height)는 그대로다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
2. 변경 전(프로덕션 파일 세 개를 되돌린 번들)과 후의 번들을 각각 만들어 실행한다:
       python3 -P soul-app/scripts/capture-duo-settings-postit.py --phase before \
           --bundle unified-dashboard/dist/assets/ios-components --out .local/tmp/card1095/visual/before
       python3 -P soul-app/scripts/capture-duo-settings-postit.py --phase after \
           --bundle unified-dashboard/dist/assets/ios-components --out .local/tmp/card1095/visual/after \
           --compare .local/tmp/card1095/visual/before/duo-settings-postit.json
   안전 영역 이동 전후를 비교할 때는 변경 전 결과를 --baseline에 추가한다.

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
캡처 페이지에는 스크롤바 폭을 0으로 두는 스타일을 넣는다. iOS에는 스크롤바가 없고,
헤더 내용 끝선과 본문 카드 끝선의 정렬을 재는 데 브라우저 스크롤바 폭이 끼면 안 된다.

500줄을 넘는 이유: 두 화면의 측정 JS가 Playwright 인자로 넘길 문자열이라 이 파일에 함께 있다.
서버·측정·비교가 한 실행 단위라 파일을 쪼개면 실행 절차만 흩어진다.
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
THEMES = ("dark", "light")
# 듀오 세로(안쪽), 듀오 가로(안쪽, 사이드 밴드), 아이패드 세로와 가로
SETTINGS_FRAMES = [
    ("inner-portrait", 669, 951),
    ("inner-landscape", 951, 669),
    ("ipad-pro-13-portrait", 1032, 1376),
    ("ipad-pro-13-landscape", 1376, 1032),
]
# 하위 화면: (frame, width, height, wide, states). wide는 본문 카드가 오른쪽 열에 있는
# 2단 레이아웃이라는 뜻이다. 폰(iphone-17)은 헤더와 본문이 같은 열이라 끝선을 직접 맞춘다.
NESTED_FRAMES = [
    ("iphone-17", 393, 852, False, ("sub", "list", "editor", "history")),
    ("inner-portrait", 669, 951, True, ("list", "editor", "history")),
    ("ipad-pro-13-portrait", 1032, 1376, True, ("list", "editor")),
]
BOARD_FRAMES = [
    ("inner-portrait", 669, 951),
    ("inner-landscape", 951, 669),
]
# 거의 확실한 시각 차이만 잡고 픽셀 반올림은 허용한다.
ALIGN_TOLERANCE_PX = 1.0
SIZE_TOLERANCE_PX = 0.5
# 「볼 것」 상자는 본문 칸의 남는 높이(slack)만큼 칸 아래끝보다 위에 놓인다.
# 그래서 상자 아래끝→완료 원 윗면의 시각 간격은 제목 리듬(gap)보다 slack만큼 크다.
RHYTHM_TOLERANCE_PX = 2.0

HIDE_SCROLLBAR_CSS = "::-webkit-scrollbar { width: 0; height: 0; } * { scrollbar-width: none; }"

SETTINGS_MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const styleOf = (element) => (element ? getComputedStyle(element) : null);
  const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
  const header = byId('settings-modal-header');
  const title = header
    ? [...header.children].find((element) => styleOf(element).flexGrow === '1') ?? null
    : null;
  const close = byId('settings-modal-close');
  const descendants = close ? [...close.querySelectorAll('*')] : [];
  const icon = descendants.find((element) => {
    const style = styleOf(element);
    return element.children.length === 0 && (element.textContent || '').trim()
      && style.fontFamily.toLowerCase().includes('ionicons');
  }) ?? null;
  const circle = descendants.find((element) => {
    const style = styleOf(element);
    return parseFloat(style.borderTopLeftRadius) >= 16 && parseFloat(style.width) >= 16;
  }) ?? null;
  const rail = byId('duo-rail-action-back');
  const railCapsule = byId('duo-rail-override');
  const headerStyle = styleOf(header);
  return {
    window: { width: innerWidth, height: innerHeight },
    sheetFrame: box(byId('settings-layout-sheet-frame')),
    header: box(header),
    headerPaddingTop: headerStyle ? round(parseFloat(headerStyle.paddingTop || '0')) : null,
    headerText: header ? (header.textContent || '').trim() : null,
    title: box(title),
    titleText: title ? (title.textContent || '').trim() : null,
    close: box(close),
    closeLabel: close ? close.getAttribute('aria-label') : null,
    closeText: close ? (close.textContent || '').trim() : null,
    closeIcon: icon ? {
      glyph: icon.textContent,
      fontFamily: styleOf(icon).fontFamily,
      fontSize: parseFloat(styleOf(icon).fontSize),
      color: styleOf(icon).color,
    } : null,
    closeVisual: circle ? {
      rect: box(circle),
      borderRadius: styleOf(circle).borderTopLeftRadius,
      backgroundColor: styleOf(circle).backgroundColor,
      backdropFilter: styleOf(circle).backdropFilter || styleOf(circle).webkitBackdropFilter || 'none',
      borderWidth: styleOf(circle).borderTopWidth,
    } : null,
    bodySection: box(byId('settings-section-display')),
    detail: box(byId('settings-detail-display')),
    sidebar: box(byId('settings-sidebar-scroll')),
    lastCategory: box(byId('settings-category-diagnostics')),
    rail: box(rail),
    railLabel: rail ? rail.getAttribute('aria-label') : null,
    railCapsule: box(railCapsule),
  };
}
"""

BOARD_MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const styleOf = (element) => (element ? getComputedStyle(element) : null);
  const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
  const cards = [...document.querySelectorAll('[data-testid^="postit-card-"]')].map((card) => {
    // 카드가 ±0.8° 회전해 있으면 자식의 getBoundingClientRect는 회전을 감싼 AABB라
    // 높이가 최대 2.76pt 부풀어 줄어든 글자를 가린다. 측정 동안만 회전을 끈다.
    const rotation = card.style.transform;
    card.style.transform = 'none';
    const id = card.dataset.testid.slice('postit-card-'.length);
    const open = byId(`postit-open-${id}`);
    const title = byId(`postit-title-${id}`);
    const body = byId(`postit-body-${id}`);
    const bodyArea = byId(`postit-body-area-${id}`);
    const ask = byId(`postit-${id}-ask-preview`);
    const footer = byId(`postit-footer-${id}`);
    const progress = byId(`postit-${id}-item-summary`);
    const complete = byId(`postit-complete-${id}`);
    const openStyle = styleOf(open);
    const titleStyle = styleOf(title);
    const bodyStyle = styleOf(body);
    const bodyAreaStyle = styleOf(bodyArea);
    const askStyle = styleOf(ask);
    const footerStyle = styleOf(footer);
    const cardRect = box(card);
    const titleRect = box(title);
    const footerRect = box(footer);
    const bodyAreaRect = box(bodyArea);
    const askRect = box(ask);
    const completeRect = box(complete);
    // 「볼 것」 상자의 자연 높이(줄 높이 + 위아래 padding). 웹이 flex-shrink로
    // 상자를 줄이면 getBoundingClientRect는 줄어든 높이를 돌려주므로, 글자가 잘렸는지는
    // 줄어든 상자 끝이 아니라 자연 높이로 계산한다. 상자는 numberOfLines 1(compact)이다.
    const askPaddingTop = askStyle ? parseFloat(askStyle.paddingTop || '0') : null;
    const askPaddingBottom = askStyle ? parseFloat(askStyle.paddingBottom || '0') : null;
    const askLineHeight = askStyle && askStyle.lineHeight !== 'normal' ? parseFloat(askStyle.lineHeight) : null;
    const askNaturalHeight = askLineHeight !== null && askPaddingTop !== null && askPaddingBottom !== null
      ? round(askLineHeight + askPaddingTop + askPaddingBottom) : null;
    const askTextBottom = askRect && askNaturalHeight !== null && askPaddingBottom !== null
      ? round(askRect.top + askNaturalHeight - askPaddingBottom) : null;
    const askNaturalBottom = askRect && askNaturalHeight !== null
      ? round(askRect.top + askNaturalHeight) : null;
    const askToCompleteGap = askRect && completeRect ? round(completeRect.top - askRect.bottom) : null;
    const footerImages = footer
      ? [...footer.querySelectorAll('*')].filter((element) => {
          if (element.tagName === 'IMG') return true;
          const background = styleOf(element).backgroundImage;
          return background && background !== 'none';
        }).length
      : 0;
    const result = {
      id,
      card: cardRect,
      cardSize: { width: card.offsetWidth, height: card.offsetHeight },
      padding: openStyle ? {
        top: round(parseFloat(openStyle.paddingTop)),
        left: round(parseFloat(openStyle.paddingLeft)),
        right: round(parseFloat(openStyle.paddingRight)),
        bottom: round(parseFloat(openStyle.paddingBottom)),
      } : null,
      paddingGap: bodyAreaStyle ? round(parseFloat(bodyAreaStyle.marginTop)) : null,
      title: titleRect,
      titleText: title ? (title.textContent || '').trim() : null,
      titleLineHeight: titleStyle ? round(parseFloat(titleStyle.lineHeight)) : null,
      titleOffsetFromCardTop: cardRect && titleRect ? round(titleRect.top - cardRect.top) : null,
      bodyClamp: bodyStyle ? (bodyStyle.webkitLineClamp || '') : '',
      body: box(body),
      bodyLineHeight: bodyStyle ? round(parseFloat(bodyStyle.lineHeight)) : null,
      bodyText: body ? (body.textContent || '').trim() : '',
      bodyArea: bodyAreaRect,
      progress: box(progress),
      progressText: progress ? (progress.textContent || '').trim() : null,
      ask: askRect,
      askLineHeight,
      askNaturalHeight,
      askShrunk: askRect && askNaturalHeight !== null ? round(askRect.height - askNaturalHeight) : null,
      askTextBottom,
      askTextClipped: askRect && askTextBottom !== null && bodyAreaRect
        ? round(askTextBottom - bodyAreaRect.bottom) > 0
        : null,
      askBoxOverflow: askRect && bodyAreaRect ? round(askRect.bottom - bodyAreaRect.bottom) : null,
      askNaturalBottom,
      askNaturalOverflow: askNaturalBottom !== null && bodyAreaRect
        ? round(askNaturalBottom - bodyAreaRect.bottom) : null,
      complete: completeRect,
      askToCompleteGap,
      footer: footerRect,
      footerInset: footerStyle ? {
        bottom: round(parseFloat(footerStyle.bottom)),
        left: round(parseFloat(footerStyle.left)),
        right: round(parseFloat(footerStyle.right)),
      } : null,
      footerBottomGap: footerRect && cardRect ? round(cardRect.bottom - footerRect.bottom) : null,
      footerText: footer ? (footer.textContent || '').trim() : null,
      footerImages,
    };
    card.style.transform = rotation;
    return result;
  });
  return {
    window: { width: innerWidth, height: innerHeight },
    boardFrame: box(byId('card-board-frame')),
    cards,
  };
}
"""


NESTED_MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const styleOf = (element) => (element ? getComputedStyle(element) : null);
  const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
  const visible = (element) => Boolean(element) && element.getBoundingClientRect().height > 0;
  // Ionicons 글리프는 화면 글자가 아니므로 뺀다. 글자 단추가 남아 있으면 그 글자가 잡힌다.
  const textOf = (root) => {
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node.textContent || '').trim()) continue;
      const family = styleOf(node.parentElement).fontFamily.toLowerCase();
      if (family.includes('ionicons')) continue;
      parts.push((node.textContent || '').trim());
    }
    return parts.join('');
  };
  const header = byId('settings-modal-header');
  const title = header
    ? [...header.children].find((element) => styleOf(element).flexGrow === '1') ?? null
    : null;
  const circleOf = (root) => {
    if (!root) return null;
    return [...root.querySelectorAll('*')].find((element) => {
      const style = styleOf(element);
      return parseFloat(style.width) >= 16 && parseFloat(style.borderTopLeftRadius) >= 16;
    }) ?? null;
  };
  const iconOf = (root) => {
    if (!root) return null;
    return [...root.querySelectorAll('*')].find((element) => {
      const style = styleOf(element);
      return element.children.length === 0 && (element.textContent || '').trim()
        && style.fontFamily.toLowerCase().includes('ionicons');
    }) ?? null;
  };
  const visualOf = (element) => {
    if (!element) return null;
    const style = styleOf(element);
    return {
      rect: box(element),
      borderRadius: style.borderTopLeftRadius,
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter || style.webkitBackdropFilter || 'none',
      borderWidth: style.borderTopWidth,
    };
  };
  const iconOfElement = (element) => element ? {
    glyph: element.textContent,
    fontFamily: styleOf(element).fontFamily,
    fontSize: parseFloat(styleOf(element).fontSize),
    color: styleOf(element).color,
  } : null;
  const backButtons = [...document.querySelectorAll('[data-testid="settings-modal-back"]')].filter(visible);
  const back = backButtons[0] ?? null;
  const close = byId('settings-modal-close');
  const headerStyle = styleOf(header);
  const headerRect = header ? header.getBoundingClientRect() : null;
  const headerEdge = header && headerStyle ? {
    left: round(headerRect.left + parseFloat(headerStyle.paddingLeft || '0')),
    right: round(headerRect.right - parseFloat(headerStyle.paddingRight || '0')),
  } : null;
  // 지금 보이는 본문 블록의 끝선. 폰에서는 헤더와 같은 열이라 카드 끝선과 바로 맞춘다.
  const contentRoot = [
    ...[...document.querySelectorAll('[data-testid="recurring-jobs-list"]')].filter(visible),
    ...[...document.querySelectorAll('[data-testid="recurring-job-editor"]')].filter(visible),
    ...[...document.querySelectorAll('[data-testid="recurring-job-history"]')].filter(visible),
    ...[...document.querySelectorAll('[data-testid="settings-section-display"]')].filter(visible),
  ][0] ?? null;
  return {
    window: { width: innerWidth, height: innerHeight },
    sheetFrame: box(byId('settings-layout-sheet-frame')),
    header: box(header),
    headerPaddingTop: headerStyle ? round(parseFloat(headerStyle.paddingTop || '0')) : null,
    headerText: textOf(header),
    headerEdge,
    title: box(title),
    titleText: title ? (title.textContent || '').trim() : null,
    contentRoot: box(contentRoot),
    backCount: backButtons.length,
    back: box(back),
    backLabel: back ? back.getAttribute('aria-label') : null,
    backVisual: visualOf(circleOf(back)),
    backIcon: iconOfElement(iconOf(back)),
    close: box(close),
    closeLabel: close ? close.getAttribute('aria-label') : null,
    closeVisual: visualOf(circleOf(close)),
    closeIcon: iconOfElement(iconOf(close)),
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

    def check(self, name: str, condition: bool, detail=None):
        self.entries.append({"name": name, "passed": bool(condition), "detail": detail})


def rounded(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def center_y(rect: dict | None) -> float | None:
    return None if rect is None else rect["top"] + rect["height"] / 2


def settings_url(base: str, frame_id: str, theme: str) -> str:
    return f"{base}{PREFIX}index.html?section=iphoneDuo&sample=settings-layout&frame={frame_id}&theme={theme}"


def board_url(base: str, frame_id: str, theme: str) -> str:
    query = (f"section=iphoneDuo&sample=main-layout&frame={frame_id}"
             f"&board=ops&project-view=board&theme={theme}")
    return f"{base}{PREFIX}index.html?{query}"


def settle(page: Page) -> None:
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
    # iOS에는 스크롤바가 없다. 브라우저 스크롤바 폭이 정렬 측정에 끼지 않게 지운다.
    page.add_style_tag(content=HIDE_SCROLLBAR_CSS)
    return page, errors


def capture_settings(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                     width: int, height: int, theme: str, checks: Checks) -> dict:
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = settings_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.get_by_test_id("settings-layout-safe-area").wait_for(state="attached", timeout=20000)
    settle(page)
    metrics = page.evaluate(SETTINGS_MEASURE_JS)
    screenshot = shot(page, out, f"settings-{frame_id}-{theme}", width, height)
    page.get_by_test_id('settings-sidebar-scroll').evaluate('(element) => { element.scrollTop = element.scrollHeight; }')
    settle(page)
    scrolled = page.evaluate(SETTINGS_MEASURE_JS)
    sidebar_screenshot = shot(page, out, f"sidebar-{frame_id}-{theme}", width, height)
    page.get_by_test_id('settings-category-connection').click()
    page.get_by_test_id('settings-active-footer').wait_for(state='visible')
    settle(page)
    connection = page.evaluate("""() => {
      const box = (id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      return { detail: box('settings-detail-connection'), footer: box('settings-active-footer') };
    }""")
    connection_screenshot = shot(page, out, f"connection-{frame_id}-{theme}", width, height)
    page.close()
    context.close()

    duo = frame_id == "inner-landscape"
    prefix = f"settings/{frame_id}/{theme}"
    checks.check(f"{prefix} 헤더 존재", metrics["header"] is not None, metrics["header"])
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    checks.check(f"{prefix} 본문 카드 존재", metrics["bodySection"] is not None, metrics["bodySection"])
    inset = 24 if frame_id.startswith('inner-') else 20
    checks.check(f"{prefix} 사이드바 바닥 = 시트 바닥",
                 metrics['sidebar'] is not None and metrics['sheetFrame'] is not None
                 and abs(metrics['sidebar']['bottom'] - metrics['sheetFrame']['bottom']) <= ALIGN_TOLERANCE_PX,
                 {'sidebar': metrics['sidebar'], 'sheet': metrics['sheetFrame']})
    checks.check(f"{prefix} 마지막 항목은 바닥 안전 영역 위",
                 scrolled['lastCategory'] is not None and scrolled['sheetFrame'] is not None
                 and scrolled['lastCategory']['bottom'] <= scrolled['sheetFrame']['bottom'] - inset + ALIGN_TOLERANCE_PX,
                 {'last': scrolled['lastCategory'], 'sheet': scrolled['sheetFrame'], 'inset': inset})
    sheet = metrics["sheetFrame"]
    checks.check(f"{prefix} 시트 위 끝이 보이고 헤더가 그 위에서 시작",
                 sheet is not None and metrics["header"] is not None
                 and abs(sheet["top"] - metrics["header"]["top"]) <= ALIGN_TOLERANCE_PX,
                 {"sheet": sheet, "header": metrics["header"]})
    if metrics["header"] and metrics["title"]:
        title_center_delta = rounded(abs(center_y(metrics["title"]) - center_y(metrics["header"])))
        checks.check(f"{prefix} 제목이 헤더 세로 가운데 {ALIGN_TOLERANCE_PX}px 이내",
                     title_center_delta <= ALIGN_TOLERANCE_PX,
                     {"delta": title_center_delta, "header": metrics["header"], "title": metrics["title"]})

    if duo:
        checks.check(f"{prefix} 헤더 닫기 없음(레일이 닫기)", metrics["close"] is None, metrics["close"])
        checks.check(f"{prefix} 레일 X 존재", metrics["rail"] is not None, metrics["rail"])
        checks.check(f"{prefix} 레일 X 이름 「설정 닫기」", metrics["railLabel"] == "설정 닫기",
                     metrics["railLabel"])
        checks.check(f"{prefix} 레일 캡슐 존재", metrics["railCapsule"] is not None,
                     metrics["railCapsule"])
    else:
        checks.check(f"{prefix} 헤더 닫기 이름 「설정 닫기」",
                     metrics["closeLabel"] == "설정 닫기", metrics["closeLabel"])
        if phase == "before":
            checks.check(f"{prefix} 변경 전: 글자 「완료」", metrics["closeText"] == "완료",
                         metrics["closeText"])
            checks.check(f"{prefix} 변경 전: 유리 원 없음", metrics["closeVisual"] is None,
                         metrics["closeVisual"])
        else:
            visual = metrics["closeVisual"]
            checks.check(f"{prefix} 유리 원 X 존재", visual is not None, visual)
            if visual:
                checks.check(f"{prefix} 시각 원 32pt",
                             abs(visual["rect"]["width"] - 32) <= SIZE_TOLERANCE_PX
                             and abs(visual["rect"]["height"] - 32) <= SIZE_TOLERANCE_PX,
                             visual["rect"])
                checks.check(f"{prefix} 원형 곡률 999px",
                             visual["borderRadius"] == "999px", visual["borderRadius"])
                checks.check(f"{prefix} 유리 표면(backdrop blur)",
                             "blur(" in (visual["backdropFilter"] or ""), visual["backdropFilter"])
                center_delta = None
                if metrics["title"]:
                    center_delta = rounded(abs(center_y(visual["rect"]) - center_y(metrics["title"])))
                checks.check(f"{prefix} 제목과 세로 가운데 {ALIGN_TOLERANCE_PX}px 이내",
                             center_delta is not None and center_delta <= ALIGN_TOLERANCE_PX,
                             {"delta": center_delta, "title": metrics["title"],
                              "visual": visual["rect"]})
                right_delta = rounded(visual["rect"]["right"] - metrics["bodySection"]["right"]) \
                    if metrics["bodySection"] else None
                checks.check(f"{prefix} 오른쪽 끝 카드 끝선 {ALIGN_TOLERANCE_PX}px 이내",
                             right_delta is not None and abs(right_delta) <= ALIGN_TOLERANCE_PX,
                             {"delta": right_delta, "visual": visual["rect"],
                              "bodySection": metrics["bodySection"]})
                # S1: 원의 위 여백은 오른쪽 여백(pageInset)과 같다.
                top_gap = rounded(visual["rect"]["top"] - metrics["header"]["top"]) \
                    if metrics["header"] else None
                right_margin = rounded(metrics["window"]["width"] - visual["rect"]["right"])
                checks.check(f"{prefix} 원 위 여백 = 오른쪽 여백 {ALIGN_TOLERANCE_PX}px 이내",
                             top_gap is not None
                             and abs(top_gap - right_margin) <= ALIGN_TOLERANCE_PX,
                             {"topGap": top_gap, "rightMargin": right_margin,
                              "header": metrics["header"], "visual": visual["rect"]})
            icon = metrics["closeIcon"]
            checks.check(f"{prefix} Ionicons close 아이콘",
                         icon is not None
                         and "ionicons" in (icon["fontFamily"] or "").lower()
                         and abs(icon["fontSize"] - 18) <= SIZE_TOLERANCE_PX,
                         icon)
            checks.check(f"{prefix} 헤더에 글자 「완료」 없음",
                         "완료" not in (metrics["headerText"] or ""), metrics["headerText"])
    return {"url": url, "screenshot": screenshot, "metrics": metrics, "scrolled": scrolled,
            "sidebarScreenshot": sidebar_screenshot, "connection": connection,
            "connectionScreenshot": connection_screenshot, "errors": errors}


NESTED_BACK_LABELS = {
    "sub": "모든 설정으로 돌아가기",
    "list": "모든 설정으로 돌아가기",
    "editor": "반복 작업 이전 화면으로 돌아가기",
    "history": "반복 작업 이전 화면으로 돌아가기",
}


def measure_nested_state(page: Page, out: Path, frame_id: str, theme: str, state: str,
                         width: int, height: int, errors: list[str], checks: Checks,
                         wide: bool) -> dict:
    """지금 화면의 헤더·뒤로 원·X 원·본문 끝선을 재고 검사한다."""
    metrics = page.evaluate(NESTED_MEASURE_JS)
    name = f"nested-{frame_id}-{theme}-{state}"
    path = out / f"{name}.png"
    page.screenshot(path=str(path), clip={"x": 0, "y": 0, "width": width, "height": min(height, 420)})
    prefix = f"nested/{frame_id}/{theme}/{state}"
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    checks.check(f"{prefix} 상태 화면 표시", metrics["contentRoot"] is not None, metrics["contentRoot"])
    checks.check(f"{prefix} 헤더 글자는 제목뿐(글자 뒤로 없음)",
                 metrics["headerText"] is not None and metrics["headerText"] == metrics["titleText"],
                 {"headerText": metrics["headerText"], "titleText": metrics["titleText"]})
    expected_back = not (wide and state == "list")
    close_visual = metrics["closeVisual"]
    content_root = metrics["contentRoot"]
    checks.check(f"{prefix} X 원 존재", close_visual is not None, close_visual)
    if close_visual:
        checks.check(f"{prefix} X 원 32pt",
                     abs(close_visual["rect"]["width"] - 32) <= SIZE_TOLERANCE_PX
                     and abs(close_visual["rect"]["height"] - 32) <= SIZE_TOLERANCE_PX,
                     close_visual["rect"])
        checks.check(f"{prefix} X 원 곡률 999px",
                     close_visual["borderRadius"] == "999px", close_visual["borderRadius"])
        if content_root:
            close_right_delta = rounded(close_visual["rect"]["right"] - content_root["right"])
            checks.check(f"{prefix} X 오른쪽 끝 = 본문 내용 끝선 {ALIGN_TOLERANCE_PX}px 이내",
                         abs(close_right_delta) <= ALIGN_TOLERANCE_PX,
                         {"delta": close_right_delta, "visual": close_visual["rect"],
                          "contentRoot": content_root})
    checks.check(f"{prefix} X 이름 「설정 닫기」", metrics["closeLabel"] == "설정 닫기",
                 metrics["closeLabel"])
    if not expected_back:
        checks.check(f"{prefix} 뒤로 단추 없음(넓은 2단 목록, 현행 구조)",
                     metrics["backCount"] == 0, metrics["backCount"])
        return {"screenshot": str(path), "metrics": metrics}
    checks.check(f"{prefix} 뒤로 단추 하나", metrics["backCount"] == 1, metrics["backCount"])
    checks.check(f"{prefix} 뒤로 이름 유지", metrics["backLabel"] == NESTED_BACK_LABELS[state],
                 metrics["backLabel"])
    back_visual = metrics["backVisual"]
    checks.check(f"{prefix} 뒤로 유리 원 존재", back_visual is not None, back_visual)
    if back_visual:
        checks.check(f"{prefix} 뒤로 원 32pt",
                     abs(back_visual["rect"]["width"] - 32) <= SIZE_TOLERANCE_PX
                     and abs(back_visual["rect"]["height"] - 32) <= SIZE_TOLERANCE_PX,
                     back_visual["rect"])
        checks.check(f"{prefix} 뒤로 원 곡률 999px",
                     back_visual["borderRadius"] == "999px", back_visual["borderRadius"])
        if close_visual:
            size_delta = {
                "width": rounded(back_visual["rect"]["width"] - close_visual["rect"]["width"]),
                "height": rounded(back_visual["rect"]["height"] - close_visual["rect"]["height"]),
            }
            checks.check(f"{prefix} 뒤로 원과 X 원 크기 같음(0.5px)",
                         abs(size_delta["width"]) <= SIZE_TOLERANCE_PX
                         and abs(size_delta["height"]) <= SIZE_TOLERANCE_PX, size_delta)
            center_delta = rounded(abs(center_y(back_visual["rect"]) - center_y(close_visual["rect"])))
            checks.check(f"{prefix} 뒤로 원과 X 원 세로 가운데 {ALIGN_TOLERANCE_PX}px 이내",
                         center_delta <= ALIGN_TOLERANCE_PX,
                         {"delta": center_delta, "back": back_visual["rect"],
                          "close": close_visual["rect"]})
        icon = metrics["backIcon"]
        close_icon = metrics["closeIcon"]
        checks.check(f"{prefix} Ionicons chevron-back 아이콘 18pt",
                     icon is not None and "ionicons" in (icon["fontFamily"] or "").lower()
                     and abs(icon["fontSize"] - 18) <= SIZE_TOLERANCE_PX, icon)
        checks.check(f"{prefix} 뒤로 아이콘 색 = X 아이콘 색(textPrimary)",
                     icon is not None and close_icon is not None and icon["color"] == close_icon["color"],
                     {"back": icon and icon["color"], "close": close_icon and close_icon["color"]})
        if wide:
            # 넓은 2단은 헤더가 사이드바 위까지 걸쳐 있어 본문 카드가 오른쪽 열에 있다.
            # CardDetail 관례(음수 margin)대로 헤더 줄의 왼쪽 끝에 맞추고, 본문 카드 끝선과의
            # 차이를 함께 남긴다.
            header_edge = metrics["headerEdge"]
            left_delta = rounded(back_visual["rect"]["left"] - header_edge["left"]) \
                if header_edge else None
            content_delta = rounded(back_visual["rect"]["left"] - content_root["left"]) \
                if content_root else None
            checks.check(f"{prefix} 뒤로 원 왼쪽 = 헤더 줄 왼쪽(넓은 2단)",
                         left_delta is not None and abs(left_delta) <= ALIGN_TOLERANCE_PX,
                         {"delta": left_delta, "visual": back_visual["rect"],
                          "headerEdge": header_edge, "contentRoot": content_root,
                          "contentDelta": content_delta})
        elif content_root:
            left_delta = rounded(back_visual["rect"]["left"] - content_root["left"])
            checks.check(f"{prefix} 뒤로 원 왼쪽 끝 = 본문 내용 끝선 {ALIGN_TOLERANCE_PX}px 이내",
                         abs(left_delta) <= ALIGN_TOLERANCE_PX,
                         {"delta": left_delta, "visual": back_visual["rect"],
                          "contentRoot": content_root})
    return {"screenshot": str(path), "metrics": metrics}


def capture_nested(browser: Browser, base: str, out: Path, frame_id: str, width: int, height: int,
                   theme: str, checks: Checks, wide: bool, states: tuple[str, ...]) -> dict:
    """설정 항목 하위와 반복 작업 목록·편집·이력을 실제 조작으로 열어 헤더를 잰다."""
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = settings_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.get_by_test_id("settings-layout-safe-area").wait_for(state="attached", timeout=20000)
    settle(page)
    results: dict = {"url": url, "errors": errors, "states": {}}
    try:
        if "sub" in states:
            page.get_by_test_id("settings-category-display").click()
            page.wait_for_selector('[data-testid="settings-section-display"]', state="visible")
            settle(page)
            results["states"]["sub"] = measure_nested_state(
                page, out, frame_id, theme, "sub", width, height, errors, checks, wide)
            page.get_by_label("모든 설정으로 돌아가기").first.click()
            page.wait_for_selector('[data-testid="settings-phone-index"]', state="visible")
            settle(page)
        page.get_by_test_id("settings-category-recurring-jobs").click()
        page.wait_for_selector('[data-testid="recurring-jobs-list"]', state="visible")
        settle(page)
        results["states"]["list"] = measure_nested_state(
            page, out, frame_id, theme, "list", width, height, errors, checks, wide)
        page.get_by_test_id("recurring-job-review-job-0").click()
        page.wait_for_selector('[data-testid="recurring-job-editor"]', state="visible")
        settle(page)
        results["states"]["editor"] = measure_nested_state(
            page, out, frame_id, theme, "editor", width, height, errors, checks, wide)
        if "history" in states:
            page.locator('[data-testid="recurring-job-history"]').first.click()
            page.get_by_text("최근 실행", exact=True).first.wait_for(state="visible")
            settle(page)
            results["states"]["history"] = measure_nested_state(
                page, out, frame_id, theme, "history", width, height, errors, checks, wide)
    except Exception as error:  # noqa: BLE001 - 상태를 못 만들면 사유를 남긴다
        results["error"] = str(error)
        checks.check(f"nested/{frame_id}/{theme} 상태 재현", False, str(error))
    finally:
        page.close()
        context.close()
    return results


def capture_settings_tab(browser: Browser, base: str, out: Path, theme: str, checks: Checks) -> dict:
    """하단 탭을 통해 설정 색인과 하위 화면을 실제로 연다."""
    width, height = 393, 852
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = f"{base}{PREFIX}index.html?section=nativeSettings&entry=tab&safeArea=fixture&theme={theme}"
    page, errors = open_page(context, base, url)
    result = {"url": url, "errors": errors}
    try:
        page.wait_for_timeout(2500)
        page.mouse.click(334, 794)
        page.get_by_test_id('settings-modal-header').wait_for(state='visible')
        settle(page)
        result['index'] = page.evaluate(NESTED_MEASURE_JS)
        result['indexScreenshot'] = shot(page, out, f"tab-{theme}-index", width, height)
        page.get_by_test_id('settings-category-display').first.click()
        page.get_by_test_id('settings-section-display').wait_for(state='visible')
        settle(page)
        result['sub'] = page.evaluate(NESTED_MEASURE_JS)
        result['subScreenshot'] = shot(page, out, f"tab-{theme}-sub", width, height)
        index, sub = result['index'], result['sub']
        checks.check(f"tab/{theme} 헤더 높이 68로 동일",
                     abs(index['header']['height'] - 68) <= ALIGN_TOLERANCE_PX
                     and abs(index['header']['height'] - sub['header']['height']) <= ALIGN_TOLERANCE_PX,
                     {'index': index['header'], 'sub': sub['header']})
        checks.check(f"tab/{theme} 제목 윗선 동일",
                     abs(index['title']['top'] - sub['title']['top']) <= ALIGN_TOLERANCE_PX,
                     {'index': index['title'], 'sub': sub['title']})
        checks.check(f"tab/{theme} 페이지 오류 없음", not errors, errors)
    except Exception as error:  # noqa: BLE001
        result['error'] = str(error)
        checks.check(f"tab/{theme} 상태 재현", False, str(error))
    finally:
        page.close()
        context.close()
    return result


def compare_inset_baseline(before: dict, after: dict, checks: Checks) -> None:
    """안전 영역 이동 전후에 본문과 저장 줄의 실제 위치가 같은지 확인한다."""
    for key, current in after['settings'].items():
        prior = before['settings'][key]
        for label, old, new in (
            ('화면과 배경 본문', prior['metrics']['detail'], current['metrics']['detail']),
            ('서버 연결 본문', prior['connection']['detail'], current['connection']['detail']),
            ('저장 줄', prior['connection']['footer'], current['connection']['footer']),
        ):
            checks.check(f"전후 {key} {label} 바닥 동일",
                         old is not None and new is not None
                         and abs(old['bottom'] - new['bottom']) <= ALIGN_TOLERANCE_PX,
                         {'before': old, 'after': new})
    for theme in THEMES:
        old, new = before['tab'][theme]['sub'], after['tab'][theme]['sub']
        for label in ('header', 'title', 'contentRoot'):
            a, b = old[label], new[label]
            checks.check(f"전후 tab/{theme} 하위 {label} 위치 동일",
                         a is not None and b is not None
                         and abs(a['top'] - b['top']) <= ALIGN_TOLERANCE_PX
                         and abs(a['bottom'] - b['bottom']) <= ALIGN_TOLERANCE_PX,
                         {'before': a, 'after': b})


def capture_board(browser: Browser, base: str, out: Path, frame_id: str, width: int, height: int,
                  theme: str, checks: Checks) -> dict:
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = board_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.wait_for_selector('[data-testid^="postit-card-"]', state="attached", timeout=20000)
    settle(page)
    metrics = page.evaluate(BOARD_MEASURE_JS)
    screenshot = shot(page, out, f"board-{frame_id}-{theme}", width, height)
    page.close()
    context.close()

    prefix = f"board/{frame_id}/{theme}"
    cards = metrics["cards"]
    checks.check(f"{prefix} 카드 존재(6장 이상)", len(cards) >= 6, len(cards))
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    long_titles = [card for card in cards if len(card["titleText"] or "") > 24]
    checks.check(f"{prefix} 긴 제목 카드 존재", bool(long_titles), len(long_titles))
    two_line = [card for card in long_titles if card["title"] and card["titleLineHeight"]
                and card["title"]["height"] >= card["titleLineHeight"] * 1.9]
    checks.check(f"{prefix} 긴 제목은 두 줄", len(two_line) == len(long_titles),
                 {"long": len(long_titles), "twoLine": len(two_line)})
    progress_cards = [card for card in cards if card["progress"] is not None]
    checks.check(f"{prefix} 진행 표시(볼 것 줄) 존재", bool(progress_cards), len(progress_cards))
    ask_cards = [card for card in cards if card["ask"] is not None]
    checks.check(f"{prefix} 「볼 것」 말풍선 존재", bool(ask_cards), len(ask_cards))
    avatar_cards = [card for card in cards if card["footerImages"] > 0]
    checks.check(f"{prefix} 담당 아바타 이미지 존재", bool(avatar_cards), len(avatar_cards))
    for card in cards:
        label = f"{prefix}/{card['id']}"
        checks.check(f"{label} 본문 요약 1줄",
                     bool(card["bodyLineHeight"]) and card["body"] is not None
                     and card["body"]["height"] <= card["bodyLineHeight"] * 1.5
                     and bool(card["bodyText"]),
                     {"height": card["body"] and card["body"]["height"],
                      "lineHeight": card["bodyLineHeight"], "clamp": card["bodyClamp"]})
        checks.check(f"{label} 제목 두 줄 유지",
                     bool(card["titleLineHeight"]) and card["title"]
                     and card["title"]["height"] >= card["titleLineHeight"] * 1.9,
                     {"title": card["title"], "lineHeight": card["titleLineHeight"]})
        checks.check(f"{label} 본문 글자 줄지 않음(flexShrink 0)",
                     bool(card["bodyLineHeight"]) and card["body"] is not None
                     and card["body"]["height"] >= card["bodyLineHeight"] - ALIGN_TOLERANCE_PX,
                     {"height": card["body"] and card["body"]["height"],
                      "lineHeight": card["bodyLineHeight"]})
        checks.check(f"{label} 「볼 것」 상자 줄지 않음(flexShrink 0)",
                     card["ask"] is None or (card["askNaturalHeight"] is not None
                     and card["ask"]["height"] >= card["askNaturalHeight"] - ALIGN_TOLERANCE_PX),
                     {"height": card["ask"] and card["ask"]["height"],
                      "naturalHeight": card["askNaturalHeight"], "shrunk": card["askShrunk"]})
        checks.check(f"{label} 「볼 것」 상자 자연 아래끝 ≤ 본문 칸 아래끝",
                     card["askNaturalOverflow"] is None or card["askNaturalOverflow"] <= ALIGN_TOLERANCE_PX,
                     {"naturalOverflow": card["askNaturalOverflow"], "bodyArea": card["bodyArea"]})
        checks.check(f"{label} 「볼 것」 글자 잘리지 않음", card["askTextClipped"] is False,
                     {"askTextBottom": card["askTextBottom"], "bodyArea": card["bodyArea"]})
        checks.check(f"{label} 「볼 것」↔완료 버튼 간격 = 제목 리듬(2px)",
                     card["askToCompleteGap"] is None or (card["paddingGap"] is not None
                     and abs(card["askToCompleteGap"] - card["paddingGap"]) <= RHYTHM_TOLERANCE_PX),
                     {"askToCompleteGap": card["askToCompleteGap"], "paddingGap": card["paddingGap"]})
        checks.check(f"{label} 「볼 것」 상자 넘침 1px 이하",
                     card["askBoxOverflow"] is None or card["askBoxOverflow"] <= ALIGN_TOLERANCE_PX,
                     card["askBoxOverflow"])
        checks.check(f"{label} 카드 폭 225.88", card["cardSize"]["width"]
                     and abs(card["cardSize"]["width"] - 225.88) <= ALIGN_TOLERANCE_PX,
                     card["cardSize"])
        checks.check(f"{label} 카드 높이 197.65", card["cardSize"]["height"]
                     and abs(card["cardSize"]["height"] - 197.65) <= ALIGN_TOLERANCE_PX,
                     card["cardSize"])
    return {"url": url, "screenshot": screenshot, "metrics": metrics, "errors": errors}


def compare_phases(before: dict, after: dict, checks: Checks) -> dict:
    """변경 전/후 측정값을 카드·시트 키로 맞춰 계약 델타를 검사한다."""
    summary: dict = {"settings": {}, "board": {}}

    for key, after_sheet in after.get("settings", {}).items():
        before_sheet = before.get("settings", {}).get(key)
        if not before_sheet:
            continue
        b = before_sheet["metrics"]
        a = after_sheet["metrics"]
        entry = {"frame": key.split("/")[1], "theme": key.split("/")[2]}
        if a["close"] is None:
            entry["close"] = "none(duo rail)"
            checks.check(f"전후 settings/{key} 듀오 가로는 헤더 닫기 없음(공통)",
                         b["close"] is None and a["rail"] is not None, {"before": b["close"], "after": a["close"]})
        else:
            b_visual = b["closeVisual"]
            a_visual = a["closeVisual"]
            entry["close"] = {
                "before": {"text": b["closeText"], "visual": b_visual and b_visual["rect"]},
                "after": {"text": a["closeText"], "visual": a_visual and a_visual["rect"]},
                "rightDelta": rounded(a_visual["rect"]["right"] - a["bodySection"]["right"])
                if a_visual and a["bodySection"] else None,
                "centerDelta": rounded(abs(center_y(a_visual["rect"]) - center_y(a["title"])))
                if a_visual and a["title"] else None,
            }
            checks.check(f"전후 settings/{key} 글자 완료 → 유리 원 X",
                         b_visual is None and a_visual is not None, entry["close"])
            checks.check(f"전후 settings/{key} X 정렬 유지(가운데/오른쪽 1px)",
                         entry["close"]["centerDelta"] is not None
                         and entry["close"]["centerDelta"] <= ALIGN_TOLERANCE_PX
                         and entry["close"]["rightDelta"] is not None
                         and abs(entry["close"]["rightDelta"]) <= ALIGN_TOLERANCE_PX,
                         entry["close"])
        summary["settings"][key] = entry

    for key, after_board in after.get("board", {}).items():
        before_board = before.get("board", {}).get(key)
        if not before_board:
            continue
        before_cards = {card["id"]: card for card in before_board["metrics"]["cards"]}
        deltas = []
        for card in after_board["metrics"]["cards"]:
            prior = before_cards.get(card["id"])
            if not prior:
                continue
            gap = card["paddingGap"]
            entry = {
                "id": card["id"],
                "paddingTop": {"before": prior["padding"]["top"], "after": card["padding"]["top"]},
                "gap": gap,
                "titleOffset": {"before": prior["titleOffsetFromCardTop"],
                                "after": card["titleOffsetFromCardTop"]},
                "leftDelta": rounded(card["padding"]["left"] - prior["padding"]["left"]),
                "rightDelta": rounded(card["padding"]["right"] - prior["padding"]["right"]),
                "bottomDelta": rounded(card["padding"]["bottom"] - prior["padding"]["bottom"]),
                "footerDelta": rounded(card["footerBottomGap"] - prior["footerBottomGap"]),
                "sizeBefore": prior["cardSize"],
                "sizeAfter": card["cardSize"],
                "askBoxOverflow": {"before": prior["askBoxOverflow"], "after": card["askBoxOverflow"]},
                "askNaturalOverflow": {"before": prior.get("askNaturalOverflow"),
                                       "after": card["askNaturalOverflow"]},
            }
            deltas.append(entry)
            label = f"전후 board/{key}/{card['id']}"
            checks.check(f"{label} 제목 위 여백 +gap",
                         gap is not None
                         and abs((card["padding"]["top"] - prior["padding"]["top"]) - gap) <= 0.05,
                         entry["paddingTop"])
            checks.check(f"{label} 제목 위치 +gap",
                         card["titleOffsetFromCardTop"] is not None
                         and prior["titleOffsetFromCardTop"] is not None
                         and abs((card["titleOffsetFromCardTop"] - prior["titleOffsetFromCardTop"]) - gap) <= ALIGN_TOLERANCE_PX,
                         entry["titleOffset"])
            checks.check(f"{label} 왼쪽/오른쪽 여백 그대로",
                         abs(entry["leftDelta"]) <= 0.01 and abs(entry["rightDelta"]) <= 0.01, entry)
            checks.check(f"{label} 아래 여백은 제목 위 gap만큼 회수(줄어듦)",
                         entry["bottomDelta"] <= 0.01
                         and (gap is None or entry["bottomDelta"] >= -gap - 0.01),
                         {"before": prior["padding"]["bottom"], "after": card["padding"]["bottom"],
                          "delta": entry["bottomDelta"]})
            checks.check(f"{label} 푸터 위치 그대로", abs(entry["footerDelta"]) <= SIZE_TOLERANCE_PX,
                         entry["footerDelta"])
            checks.check(f"{label} 카드 크기 그대로",
                         abs(card["cardSize"]["width"] - prior["cardSize"]["width"]) <= SIZE_TOLERANCE_PX
                         and abs(card["cardSize"]["height"] - prior["cardSize"]["height"]) <= SIZE_TOLERANCE_PX,
                         entry["sizeBefore"])
            checks.check(f"{label} 「볼 것」 상자 자연 넘침 1px 이하",
                         card["askNaturalOverflow"] is None
                         or card["askNaturalOverflow"] <= ALIGN_TOLERANCE_PX,
                         entry["askNaturalOverflow"])
        summary["board"][key] = deltas
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    parser.add_argument("--phase", required=True, choices=("before", "after"),
                        help="프로덕션 변경 전/후 번들")
    parser.add_argument("--compare", help="비교할 반대 단계의 duo-settings-postit.json")
    parser.add_argument("--baseline", help="안전 영역 변경 전 측정 JSON")
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"phase": args.phase, "passed": False, "errors": [], "warnings": [],
                    "settings": {}, "nested": {}, "tab": {}, "board": {}}
    checks = Checks()
    try:
        with BundleServer(bundle_root) as server:
            base = server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for frame_id, width, height in SETTINGS_FRAMES:
                        for theme in THEMES:
                            key = f"settings/{frame_id}/{theme}"
                            result["settings"][key] = capture_settings(
                                browser, base, out, args.phase, frame_id, width, height, theme, checks)
                    for frame_id, width, height, wide, states in NESTED_FRAMES:
                        for theme in THEMES:
                            key = f"nested/{frame_id}/{theme}"
                            result["nested"][key] = capture_nested(
                                browser, base, out, frame_id, width, height, theme, checks, wide, states)
                    for theme in THEMES:
                        result['tab'][theme] = capture_settings_tab(browser, base, out, theme, checks)
                        portrait = result['settings'][f'settings/inner-portrait/{theme}']['metrics']
                        landscape = result['settings'][f'settings/inner-landscape/{theme}']['metrics']
                        portrait_gap = portrait['title']['top'] - portrait['header']['top']
                        landscape_gap = landscape['title']['top'] - landscape['header']['top']
                        checks.check(f"settings/{theme} 듀오 세로와 가로 제목 위 여백 동일",
                                     abs(portrait_gap - landscape_gap) <= ALIGN_TOLERANCE_PX,
                                     {'portrait': portrait_gap, 'landscape': landscape_gap})
                    for frame_id, width, height in BOARD_FRAMES:
                        for theme in THEMES:
                            key = f"board/{frame_id}/{theme}"
                            result["board"][key] = capture_board(
                                browser, base, out, frame_id, width, height, theme, checks)
                finally:
                    browser.close()
        if args.compare:
            prior = json.loads(Path(args.compare).read_text(encoding="utf-8"))
            result["comparison"] = compare_phases(prior, result, checks)
        if args.baseline:
            prior = json.loads(Path(args.baseline).read_text(encoding='utf-8'))
            compare_inset_baseline(prior, result, checks)
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "duo-settings-postit.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "phase": result["phase"],
        "passed": result["passed"],
        "errors": result["errors"],
        "checks": len(result["checks"]),
        "failed": [entry["name"] for entry in result["checks"] if not entry["passed"]],
    }, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

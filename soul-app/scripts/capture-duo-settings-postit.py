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
   - 변경 전 상태(`--phase before`)는 헤더에 글자 「완료」가 있고 유리 원이 없다.
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
# 듀오 세로(안쪽), 듀오 가로(안쪽, 사이드 밴드), 아이패드 세로
SETTINGS_FRAMES = [
    ("inner-portrait", 669, 951),
    ("inner-landscape", 951, 669),
    ("ipad-pro-13-portrait", 1032, 1376),
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
  return {
    window: { width: innerWidth, height: innerHeight },
    header: box(header),
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
    page.close()
    context.close()

    duo = frame_id == "inner-landscape"
    prefix = f"settings/{frame_id}/{theme}"
    checks.check(f"{prefix} 헤더 존재", metrics["header"] is not None, metrics["header"])
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    checks.check(f"{prefix} 본문 카드 존재", metrics["bodySection"] is not None, metrics["bodySection"])

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
            icon = metrics["closeIcon"]
            checks.check(f"{prefix} Ionicons close 아이콘",
                         icon is not None
                         and "ionicons" in (icon["fontFamily"] or "").lower()
                         and abs(icon["fontSize"] - 18) <= SIZE_TOLERANCE_PX,
                         icon)
            checks.check(f"{prefix} 헤더에 글자 「완료」 없음",
                         "완료" not in (metrics["headerText"] or ""), metrics["headerText"])
    return {"url": url, "screenshot": screenshot, "metrics": metrics, "errors": errors}


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
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"phase": args.phase, "passed": False, "errors": [], "warnings": [],
                    "settings": {}, "board": {}}
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

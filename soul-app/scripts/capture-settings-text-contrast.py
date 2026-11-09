#!/usr/bin/env python3
"""설정 화면 글자 대비와 토글 구분선의 전후 시각 검수 (카드 #1116, #1119).

무엇을 검수하나
---------------
1. 「서버 연결」의 현재 연결 세 줄(저장 URL, 저장 유형, 확인된 실행 모드)이 테마의
   textPrimary 색으로 읽히고, 같은 블록의 「이 기기에 연결 설정을 저장했습니다.」
   줄도 함께 기록한다. (#1116이 이미 main에 머지돼 before/after 모두 통과해야 한다.)
2. 「화면과 배경」의 영구 세션 토글 행 아래 구분선이 없다(border-bottom-width 0).
3. 「요청 검수」의 빈 입력에서 비활성인 GlassButton(추가)의 바탕이 투명하고, 입력을
   채워 활성화한 상태도 함께 캡처한다.
4. 공유 값 표본: 「서버 연결」에서 URL을 지워 비활성으로 만든 보조 버튼
   settings-test-connection과 component-review의 autoRefresh 화면 비활성 보조 버튼
   refresh-finish. 둘 다 투명 바탕이어야 한다.
5. 비활성 primary의 캡처 픽셀 대비 (#1119): 「서버 연결」의 settings-save(연결 저장)와
   「요청 검수」의 review-policy-save(정책 저장)를 비활성 상태로 캡처해, 단추 상자
   안쪽 6 CSS px를 잘라 최빈색(바탕)과 바탕에서 휘도가 가장 먼 픽셀(글자)의 WCAG
   대비를 잰다. 4.5:1 이상이어야 한다. 같은 단추의 활성 상태도 캡처해 계산 색과
   상자 좌표를 함께 남긴다.
6. --compare: 세 화면의 설정 카드 좌표(left, top, width, height)가 변경 전과 1px 이내.
   비활성 primary는 바뀌고(바탕 투명 + textPrimary 글자 + chrome 판), 활성 primary와
   두 primary 버튼의 상자 좌표는 변경 전과 같아야 한다.

대비 수치는 computed color, opacity, 가장 가까운 불투명 배경색과의 대비, 그리고
캡처 픽셀 측정치를 JSON에 남긴다. 픽셀 측정은 둥근 모서리 바깥 배경을 배제하도록
상자 안쪽 6 CSS px만 본다(모서리 픽셀이 글자 후보로 잡히던 오측정 보정).

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy runner 경유):
       node soul-app/scripts/export-components.mjs
2. 변경 전과 후 번들로 각각 실행한다(python3 -P, 사용자 site-packages 사용):
       python3 -P soul-app/scripts/capture-settings-text-contrast.py --phase before \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1116/visual/before
       python3 -P soul-app/scripts/capture-settings-text-contrast.py --phase after \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1116/visual/after \
           --compare .local/tmp/card1116/visual/before/settings-text-contrast.json

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
서버·페이지·정리·캡처 도우미는 이 파일에 둔다(이전에 불러다 쓰던
`capture-duo-settings-postit.py`가 #1753에서 삭제됐다).

이 파일은 리포에 두는 단일 시각 검수 스크립트라 측정 JS와 검사 문자열을 한 파일에 둔다.
그래서 500줄을 넘는다(공통 rules-extra module-size-limit의 사유 명시 예외).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import threading
from collections import Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

PREFIX = "/assets/ios-components/"
HIDE_SCROLLBAR_CSS = "::-webkit-scrollbar { width: 0; height: 0; } * { scrollbar-width: none; }"


class BundleServer:
    """번들 디렉토리만 정적으로 제공하고 /api/auth/status fixture만 응답한다."""

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
                    self._send(200, json.dumps({"authenticated": authenticated}).encode(),
                               "application/json")
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


def settings_url(base: str, frame_id: str, theme: str) -> str:
    return (f"{base}{PREFIX}index.html?section=iphoneDuo&sample=settings-layout"
            f"&frame={frame_id}&theme={theme}")


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

THEMES = ("dark", "light")
# 세 화면 모두를 이 프레임에서 캡처한다(카드 #1116 요청).
FRAMES = (
    ("ipad-pro-13-portrait", 1032, 1376),
    ("ipad-pro-13-landscape", 1376, 1032),
    ("inner-portrait", 669, 951),
)
# autoRefresh 표본은 한 프레임에서만 본다.
SAMPLE_FRAME = ("ipad-pro-13-portrait", 1032, 1376)
# getComputedStyle은 #ffffff를 rgb(255, 255, 255)로 정규화한다.
TEXT_PRIMARY_RGB = {"dark": "rgb(255, 255, 255)", "light": "rgb(0, 0, 0)"}
ALIGN_TOLERANCE_PX = 1.0
TRANSPARENT_ALPHA = 0.5
CONTRAST_MIN = 4.5
# 둥근 모서리 바깥 배경 픽셀이 글자 후보로 잡히지 않도록 상자 안쪽만 잰다.
PIXEL_INSET_CSS = 6.0
# getComputedStyle의 link 토큰 값(theme/colors.ts).
LINK_RGB = {"dark": "rgb(105, 177, 255)", "light": "rgb(0, 102, 204)"}
# 같은 글자색이면 픽셀 합성 결과의 채도 차이가 1~2 수준이다. 링크 색 글자는 80 이상 벌어진다.
TEXT_FAMILY_CHROMA_TOLERANCE = 8
# 하단 단추 두 개의 폭 차이 허용치(카드 #1124).
FOOTER_WIDTH_TOLERANCE_PX = 1.0

MEASURE_BASE_JS = r"""
  const round = (value) => Math.round(value * 100) / 100;
  const parseColor = (value) => {
    const match = /^rgba?\(([^)]+)\)$/.exec((value || '').trim());
    if (!match) return null;
    const parts = match[1].split(',').map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const styleOf = (element) => getComputedStyle(element);
  const visible = (element) => {
    if (!element) return false;
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: round(rect.left), top: round(rect.top), right: round(rect.right),
      bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
  };
  const describe = (element) => element
    ? (element.getAttribute('data-testid') || element.tagName.toLowerCase())
    : null;
  const nearestOpaqueBackground = (element) => {
    let node = element.parentElement;
    while (node) {
      const value = styleOf(node).backgroundColor;
      const color = parseColor(value);
      if (color && color.a >= 0.999) return { color: value, source: describe(node) };
      node = node.parentElement;
    }
    return { color: null, source: null };
  };
  const ancestorOpacity = (element) => {
    let opacity = 1;
    let node = element.parentElement;
    while (node) {
      opacity *= parseFloat(styleOf(node).opacity || '1');
      node = node.parentElement;
    }
    return round(opacity);
  };
  const sample = (element) => {
    if (!element) return null;
    const style = styleOf(element);
    return {
      text: (element.textContent || '').trim().slice(0, 80),
      color: style.color,
      backgroundColor: style.backgroundColor,
      opacity: parseFloat(style.opacity || '1'),
      ancestorOpacity: ancestorOpacity(element),
      fontSize: style.fontSize,
      borderBottomWidth: style.borderBottomWidth,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomColor: style.borderBottomColor,
      background: nearestOpaqueBackground(element),
      box: box(element),
    };
  };
  const surfaceOf = (element) => {
    const surface = element ? element.parentElement : null;
    if (!surface) return null;
    const style = styleOf(surface);
    return {
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter || style.webkitBackdropFilter || 'none',
      borderRadius: style.borderTopLeftRadius,
      box: box(surface),
    };
  };
  const buttonSample = (element) => {
    if (!element) return null;
    const style = styleOf(element);
    const content = [...element.querySelectorAll('*')].find((node) => (node.textContent || '').trim());
    const contentStyle = content ? styleOf(content) : null;
    return {
      text: (element.textContent || '').trim().slice(0, 40),
      backgroundColor: style.backgroundColor,
      background: nearestOpaqueBackground(element),
      opacity: parseFloat(style.opacity || '1'),
      ariaDisabled: element.getAttribute('aria-disabled'),
      contentColor: contentStyle ? contentStyle.color : null,
      contentOpacity: contentStyle ? parseFloat(contentStyle.opacity || '1') : null,
      surface: surfaceOf(element),
      box: box(element),
    };
  };
  const cardRects = (root) => {
    const children = [...root.children].filter(visible);
    let row = null;
    for (const child of children) {
      const style = styleOf(child);
      if (style.display.includes('flex') && style.flexDirection === 'row'
          && style.flexWrap === 'wrap' && child.children.length > 0) {
        row = child;
        break;
      }
    }
    const cards = row ? [...row.children].filter(visible) : children;
    return cards.map((card, index) => ({ index, box: box(card) }));
  };
  const sectionRects = () => [...document.querySelectorAll('[data-testid^="settings-section-"]')]
    .filter((root) => visible(root) && !root.querySelector('[data-testid^="settings-section-"]'))
    .map((root) => ({ id: root.getAttribute('data-testid'), cards: cardRects(root) }));
"""

CONNECTION_JS = "() => {" + MEASURE_BASE_JS + r"""
  const detail = document.querySelector('[data-testid="settings-detail-connection"]');
  const root = detail || document;
  const label = [...root.querySelectorAll('*')].find((element) =>
    element.children.length === 0 && (element.textContent || '').trim() === '현재 연결');
  const block = label ? label.parentElement : null;
  const lines = block
    ? [...block.children].map((child) => sample(child)).filter((entry) => entry && entry.text)
    : [];
  const input = document.querySelector('[data-testid="settings-server-input"]');
  return { detailVisible: visible(detail), labelFound: Boolean(label), lines,
    referenceTextColor: input ? styleOf(input).color : null, sections: sectionRects() };
}"""

CONNECTION_BUTTONS_JS = "() => {" + MEASURE_BASE_JS + r"""
  const byTestID = (id) => document.querySelector(`[data-testid="${id}"]`);
  return {
    testConnection: buttonSample(byTestID('settings-test-connection')),
    save: buttonSample(byTestID('settings-save')),
    inputValue: byTestID('settings-server-input') ? byTestID('settings-server-input').value : null,
  };
}"""

DISPLAY_JS = "() => {" + MEASURE_BASE_JS + r"""
  const toggle = document.querySelector('[data-testid="settings-persistent-session-open-on-start"]');
  const label = '시작할 때 영구 세션으로 열기';
  let row = toggle;
  while (row && !((row.textContent || '').includes(label))) row = row.parentElement;
  const chain = [];
  let node = toggle;
  for (let depth = 0; node && depth < 5; depth += 1) {
    chain.push({ tag: node.tagName.toLowerCase(), testid: node.getAttribute('data-testid'),
      borderBottomWidth: styleOf(node).borderBottomWidth });
    node = node.parentElement;
  }
  return { toggleFound: Boolean(toggle), rowFound: Boolean(row), row: sample(row),
    chain, sections: sectionRects() };
}"""

REVIEW_JS = "() => {" + MEASURE_BASE_JS + r"""
  const add = document.querySelector('[data-testid="review-policy-add"]');
  const save = document.querySelector('[data-testid="review-policy-save"]');
  const reload = document.querySelector('[data-testid="review-policy-reload"]');
  const input = document.querySelector('[data-testid="review-policy-source-input"]');
  return { add: buttonSample(add), save: buttonSample(save),
    reload: buttonSample(reload),
    inputValue: input ? input.value : null, sections: sectionRects() };
}"""

AUTO_REFRESH_JS = "() => {" + MEASURE_BASE_JS + r"""
  const byTestID = (id) => document.querySelector(`[data-testid="${id}"]`);
  return { finish: buttonSample(byTestID('refresh-finish')),
    begin: buttonSample(byTestID('refresh-begin')),
    phase: byTestID('refresh-phase') ? byTestID('refresh-phase').textContent : null };
}"""

FOOTER_JS = "() => {" + MEASURE_BASE_JS + r"""
  const footer = document.querySelector('[data-testid="settings-active-footer"]');
  if (!footer) return { found: false, footer: null, buttons: [] };
  const buttons = [...footer.children].filter(visible);
  return {
    found: true,
    footer: box(footer),
    buttons: buttons.map((element) => ({
      text: (element.textContent || '').trim().slice(0, 40),
      box: box(element),
      sample: buttonSample(element),
    })),
  };
}"""


def parse_rgba(value: str | None):
    match = re.match(r"rgba?\(([^)]+)\)", (value or "").strip())
    if not match:
        return None
    parts = [float(part.strip()) for part in match.group(1).split(",")]
    if len(parts) < 3:
        return None
    return (parts[0], parts[1], parts[2], parts[3] if len(parts) > 3 else 1.0)


def relative_luminance(rgb) -> float:
    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])


def contrast_ratio(color: str | None, background: str | None):
    foreground, backdrop = parse_rgba(color), parse_rgba(background)
    if foreground is None or backdrop is None:
        return None
    high, low = relative_luminance(foreground), relative_luminance(backdrop)
    if high < low:
        high, low = low, high
    return round((high + 0.05) / (low + 0.05), 2)


def parse_px(value: str | None):
    match = re.match(r"(-?\d+(?:\.\d+)?)px", (value or "").strip())
    return float(match.group(1)) if match else None


def annotate_text(sample: dict | None) -> dict | None:
    if not sample:
        return sample
    sample["contrast"] = contrast_ratio(sample.get("color"),
                                        (sample.get("background") or {}).get("color"))
    return sample


def annotate_button(sample: dict | None) -> dict | None:
    if not sample:
        return sample
    own = parse_rgba(sample.get("backgroundColor"))
    background = (sample.get("background") or {}).get("color")
    if own and own[3] >= 0.999:
        background = sample["backgroundColor"]
    sample["contentContrast"] = contrast_ratio(sample.get("contentColor"), background)
    return sample


def is_transparent(background: str | None) -> bool:
    color = parse_rgba(background)
    return color is not None and color[3] <= TRANSPARENT_ALPHA


def measure_pixel_contrast(png_path: str | None, box: dict | None,
                           dpr: float = 2.0) -> dict | None:
    """캡처 PNG의 단추 상자 안쪽에서 바탕(최빈색)과 글자(휘도 최대 차) 대비를 잰다."""
    if not png_path or not box:
        return None
    left = round((box["left"] + PIXEL_INSET_CSS) * dpr)
    top = round((box["top"] + PIXEL_INSET_CSS) * dpr)
    right = round((box["right"] - PIXEL_INSET_CSS) * dpr)
    bottom = round((box["bottom"] - PIXEL_INSET_CSS) * dpr)
    if right <= left or bottom <= top:
        return None
    with Image.open(png_path) as image:
        crop = image.convert("RGB").crop((left, top, right, bottom))
    pixels = list(crop.getdata())
    if not pixels:
        return None
    background = Counter(pixels).most_common(1)[0][0]
    background_luminance = relative_luminance(background)
    text_pixel = max(pixels, key=lambda pixel:
                     abs(relative_luminance(pixel) - background_luminance))
    high, low = relative_luminance(text_pixel), background_luminance
    if high < low:
        high, low = low, high
    return {
        "background": "#%02x%02x%02x" % background,
        "text": "#%02x%02x%02x" % text_pixel,
        "contrast": round((high + 0.05) / (low + 0.05), 2),
        "insetCss": PIXEL_INSET_CSS,
        "dpr": dpr,
    }


def text_chroma(pixel: dict | None) -> int | None:
    """픽셀 글자색의 채도(max−min). 같은 색 계열 판정에 쓴다."""
    value = (pixel or {}).get("text", "").lstrip("#")
    if len(value) != 6:
        return None
    try:
        channels = [int(value[index:index + 2], 16) for index in (0, 2, 4)]
    except ValueError:
        return None
    return max(channels) - min(channels)


def text_family_gap(secondary: dict | None, primary: dict | None) -> dict:
    """두 픽셀 글자색의 채도 차이. 같은 글자색이면 0~2다."""
    secondary_chroma = text_chroma(secondary)
    primary_chroma = text_chroma(primary)
    gap = (None if secondary_chroma is None or primary_chroma is None
           else abs(secondary_chroma - primary_chroma))
    return {"secondaryChroma": secondary_chroma, "primaryChroma": primary_chroma,
            "gap": gap, "secondaryText": (secondary or {}).get("text"),
            "primaryText": (primary or {}).get("text")}


def open_settings(browser: Browser, base: str, frame_id: str, width: int, height: int, theme: str):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = settings_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.get_by_test_id("settings-layout-safe-area").wait_for(state="attached", timeout=20000)
    settle(page)
    return context, page, errors


def capture_connection(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                       width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"connection/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-connection").first.click()
        settle(page)
        metrics = page.evaluate(CONNECTION_JS)
        entry["detailVisible"] = metrics["detailVisible"]
        entry["referenceTextColor"] = metrics["referenceTextColor"]
        lines = [line for line in metrics["lines"] if line["text"] != "현재 연결"][:3]
        entry["lines"] = [annotate_text(line) for line in lines]
        entry["notice"] = next((annotate_text(line) for line in metrics["lines"]
                                if "저장했습니다" in line["text"]), None)
        entry["sections"] = metrics["sections"]

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 서버 연결 상세가 보임", metrics["detailVisible"],
                     {"detailVisible": metrics["detailVisible"]})
        checks.check(f"{key} 현재 연결 세 줄 존재", len(lines) == 3,
                     [line["text"] for line in metrics["lines"]])
        expected = TEXT_PRIMARY_RGB[theme]
        detail = [{"text": line["text"], "color": line["color"],
                   "contrast": line["contrast"]} for line in entry["lines"]]
        checks.check(f"{key} 현재 연결 세 줄 색이 테마 textPrimary",
                     len(lines) == 3
                     and all(line["color"] == expected for line in lines), detail)

        original_url = page.get_by_test_id("settings-server-input").input_value()
        page.get_by_test_id("settings-server-input").fill("")
        settle(page)
        buttons = page.evaluate(CONNECTION_BUTTONS_JS)
        entry["samples"] = {
            "testConnection": annotate_button(buttons["testConnection"]),
            "save": annotate_button(buttons["save"]),
        }
        entry["clearedInputValue"] = buttons["inputValue"]
        screenshot = shot(page, out, f"connection-{frame_id}-{theme}", width, height)
        entry["screenshot"] = screenshot
        # 주소를 지우면 저장 범위가 dirty가 되어 하단 단추 두 개가 선다.
        footer = page.evaluate(FOOTER_JS)
        entry["footer"] = footer
        entry["footerScreenshot"] = shot(
            page, out, f"connection-active-footer-{frame_id}-{theme}", width, height)
        footer_buttons = footer.get("buttons") or []
        checks.check(f"{key} 하단 단추 두 개가 보임",
                     footer.get("found") and len(footer_buttons) == 2,
                     {"found": footer.get("found"),
                      "labels": [button.get("text") for button in footer_buttons]})
        if len(footer_buttons) == 2:
            width_gap = round(abs(footer_buttons[0]["box"]["width"]
                                  - footer_buttons[1]["box"]["width"]), 2)
            entry["footerWidthGap"] = width_gap
            detail = {"labels": [button.get("text") for button in footer_buttons],
                      "widths": [button["box"]["width"] for button in footer_buttons],
                      "gap": width_gap}
            if phase == "before":
                checks.check(f"{key} 변경 전 결함 재현: 하단 단추 폭 차이가 "
                             f"{FOOTER_WIDTH_TOLERANCE_PX}px 초과",
                             width_gap > FOOTER_WIDTH_TOLERANCE_PX, detail)
            else:
                checks.check(f"{key} 하단 단추 폭 차이가 {FOOTER_WIDTH_TOLERANCE_PX}px 이내",
                             width_gap <= FOOTER_WIDTH_TOLERANCE_PX, detail)

        test_connection = entry["samples"]["testConnection"]
        save = entry["samples"]["save"]
        checks.check(f"{key} URL을 지워 연결 확인 버튼이 비활성",
                     test_connection is not None and test_connection["opacity"] == 0.55,
                     {"opacity": test_connection["opacity"] if test_connection else None})
        checks.check(f"{key} URL을 지워 저장 버튼이 비활성",
                     save is not None and save["opacity"] == 0.55,
                     {"opacity": save["opacity"] if save else None})
        background = test_connection["backgroundColor"] if test_connection else None
        checks.check(f"{key} 비활성 보조 버튼 바탕이 투명",
                     test_connection is not None and is_transparent(background),
                     {"backgroundColor": background})
        save["pixelContrast"] = measure_pixel_contrast(screenshot, save["box"])
        pixel = save["pixelContrast"]
        entry["samples"]["saveDisabledContrast"] = pixel
        checks.check(f"{key} 비활성 primary 픽셀 대비 {CONTRAST_MIN}:1 이상",
                     pixel is not None and pixel["contrast"] >= CONTRAST_MIN, pixel)
        if test_connection is not None:
            test_connection["pixelContrast"] = measure_pixel_contrast(
                screenshot, test_connection["box"])
        test_connection_pixel = (test_connection or {}).get("pixelContrast")
        entry["samples"]["testConnectionDisabledContrast"] = test_connection_pixel
        family = text_family_gap(test_connection_pixel, pixel)
        entry["samples"]["testConnectionFamily"] = family
        if phase == "before":
            checks.check(f"{key} 변경 전 결함 재현: 비활성 보조 글자 픽셀이 저장 버튼 글자색 계열이 아님",
                         family["gap"] is not None
                         and family["gap"] > TEXT_FAMILY_CHROMA_TOLERANCE, family)
            checks.check(f"{key} 변경 전 비활성 보조 글자색이 link",
                         test_connection is not None
                         and test_connection["contentColor"] == LINK_RGB[theme],
                         {"contentColor": (test_connection or {}).get("contentColor")})
        else:
            checks.check(f"{key} 비활성 보조 글자 픽셀이 저장 버튼과 같은 색 계열",
                         family["gap"] is not None
                         and family["gap"] <= TEXT_FAMILY_CHROMA_TOLERANCE, family)
            checks.check(f"{key} 비활성 보조 글자색이 textPrimary",
                         test_connection is not None
                         and test_connection["contentColor"] == TEXT_PRIMARY_RGB[theme],
                         {"contentColor": (test_connection or {}).get("contentColor")})
            checks.check(f"{key} 비활성 보조 픽셀 대비 {CONTRAST_MIN}:1 이상",
                         test_connection_pixel is not None
                         and test_connection_pixel["contrast"] >= CONTRAST_MIN,
                         test_connection_pixel)

        page.get_by_test_id("settings-server-input").fill(original_url or "https://example.test")
        settle(page)
        enabled = page.evaluate(CONNECTION_BUTTONS_JS)
        entry["samples"]["saveEnabled"] = annotate_button(enabled["save"])
        entry["samples"]["testConnectionEnabled"] = annotate_button(enabled["testConnection"])
        enabled_png = shot(page, out, f"connection-enabled-{frame_id}-{theme}", width, height)
        entry["enabledScreenshot"] = enabled_png
        enabled_save = entry["samples"]["saveEnabled"]
        enabled_save["pixelContrast"] = measure_pixel_contrast(enabled_png, enabled_save["box"])
        enabled_connection = entry["samples"]["testConnectionEnabled"]
        if enabled_connection is not None:
            enabled_connection["pixelContrast"] = measure_pixel_contrast(
                enabled_png, enabled_connection["box"])
            checks.check(f"{key} 활성 보조 글자색이 link",
                         enabled_connection["contentColor"] == LINK_RGB[theme],
                         {"contentColor": enabled_connection["contentColor"]})
        checks.check(f"{key} URL을 채우면 저장 버튼이 활성",
                     enabled_save is not None and enabled_save["opacity"] == 1
                     and enabled_save["ariaDisabled"] != "true",
                     {"opacity": enabled_save["opacity"] if enabled_save else None,
                      "ariaDisabled": enabled_save["ariaDisabled"] if enabled_save else None})
    finally:
        page.close()
        context.close()
    return entry


def capture_display(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                    width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"display/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-display").first.click()
        settle(page)
        metrics = page.evaluate(DISPLAY_JS)
        entry["toggleFound"] = metrics["toggleFound"]
        entry["rowFound"] = metrics["rowFound"]
        entry["row"] = metrics["row"]
        entry["ancestorChain"] = metrics["chain"]
        entry["sections"] = metrics["sections"]
        entry["screenshot"] = shot(page, out, f"display-{frame_id}-{theme}", width, height)

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 영구 세션 토글 행 존재", metrics["rowFound"],
                     {"toggleFound": metrics["toggleFound"], "chain": metrics["chain"]})
        border = parse_px((metrics["row"] or {}).get("borderBottomWidth"))
        checks.check(f"{key} 토글 행 아래 구분선 없음", border == 0,
                     {"borderBottomWidth": (metrics["row"] or {}).get("borderBottomWidth")})
    finally:
        page.close()
        context.close()
    return entry


def capture_review_policy(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                          width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"reviewPolicy/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-review-policy").first.click()
        settle(page)
        page.get_by_test_id("review-policy-add").wait_for(state="attached", timeout=20000)
        settle(page)
        # 낮은 프레임에서는 입력 줄과 추가 단추가 화면 아래에 있다. 픽셀을 잴 수 있게 먼저 올린다.
        page.get_by_test_id("review-policy-source-input").scroll_into_view_if_needed()
        settle(page)
        empty = page.evaluate(REVIEW_JS)
        entry["empty"] = annotate_button(empty["add"])
        entry["saveDisabled"] = annotate_button(empty["save"])
        entry["reload"] = annotate_button(empty["reload"])
        entry["sections"] = empty["sections"]
        disabled_png = shot(page, out, f"review-policy-{frame_id}-{theme}", width, height)
        entry["screenshots"] = [disabled_png]
        if entry["saveDisabled"] is not None:
            entry["saveDisabled"]["pixelContrast"] = measure_pixel_contrast(
                disabled_png, entry["saveDisabled"]["box"])
        if entry["empty"] is not None:
            entry["empty"]["pixelContrast"] = measure_pixel_contrast(
                disabled_png, entry["empty"]["box"])
        add_pixel = (entry["empty"] or {}).get("pixelContrast")
        entry["addDisabledContrast"] = add_pixel
        family = text_family_gap(add_pixel, (entry["saveDisabled"] or {}).get("pixelContrast"))
        entry["addFamily"] = family

        # 스위치를 한 번 뒤집어 dirty를 만들고 하단 단추 두 개의 폭을 잰다(카드 #1124).
        page.get_by_test_id("review-policy-switch-slack").click()
        settle(page)
        footer = page.evaluate(FOOTER_JS)
        entry["footer"] = footer
        entry["footerScreenshot"] = shot(
            page, out, f"settings-active-footer-{frame_id}-{theme}", width, height)
        footer_buttons = footer.get("buttons") or []
        checks.check(f"{key} 하단 단추 두 개가 보임",
                     footer.get("found") and len(footer_buttons) == 2,
                     {"found": footer.get("found"),
                      "labels": [button.get("text") for button in footer_buttons]})
        if len(footer_buttons) == 2:
            width_gap = round(abs(footer_buttons[0]["box"]["width"]
                                  - footer_buttons[1]["box"]["width"]), 2)
            entry["footerWidthGap"] = width_gap
            detail = {"labels": [button.get("text") for button in footer_buttons],
                      "widths": [button["box"]["width"] for button in footer_buttons],
                      "gap": width_gap}
            if phase == "before":
                checks.check(f"{key} 변경 전 결함 재현: 하단 단추 폭 차이가 "
                             f"{FOOTER_WIDTH_TOLERANCE_PX}px 초과",
                             width_gap > FOOTER_WIDTH_TOLERANCE_PX, detail)
            else:
                checks.check(f"{key} 하단 단추 폭 차이가 {FOOTER_WIDTH_TOLERANCE_PX}px 이내",
                             width_gap <= FOOTER_WIDTH_TOLERANCE_PX, detail)
        page.get_by_test_id("review-policy-switch-slack").click()
        settle(page)

        page.get_by_test_id("review-policy-source-input").fill("review-check")
        settle(page)
        enabled = page.evaluate(REVIEW_JS)
        entry["enabled"] = annotate_button(enabled["add"])
        enabled_png = shot(page, out, f"review-policy-enabled-{frame_id}-{theme}",
                           width, height)
        entry["screenshots"].append(enabled_png)
        if entry["enabled"] is not None:
            entry["enabled"]["pixelContrast"] = measure_pixel_contrast(
                enabled_png, entry["enabled"]["box"])

        page.get_by_test_id("review-policy-add").click()
        settle(page)
        dirty = page.evaluate(REVIEW_JS)
        entry["saveEnabled"] = annotate_button(dirty["save"])
        save_png = shot(page, out, f"review-policy-save-enabled-{frame_id}-{theme}",
                        width, height)
        entry["saveScreenshot"] = save_png
        if entry["saveEnabled"] is not None:
            entry["saveEnabled"]["pixelContrast"] = measure_pixel_contrast(
                save_png, entry["saveEnabled"]["box"])

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 추가 버튼 존재", entry["empty"] is not None and entry["enabled"] is not None,
                     {"empty": entry["empty"] is not None,
                      "enabled": entry["enabled"] is not None})
        if entry["empty"] is not None:
            background = entry["empty"]["backgroundColor"]
            checks.check(f"{key} 빈 입력 추가 버튼 바탕이 투명",
                         is_transparent(background), {"backgroundColor": background})
        if entry["enabled"] is not None:
            checks.check(f"{key} 입력 후 추가 버튼 바탕이 투명",
                         is_transparent(entry["enabled"]["backgroundColor"])
                         and entry["enabled"]["opacity"] == 1,
                         {"backgroundColor": entry["enabled"]["backgroundColor"],
                          "opacity": entry["enabled"]["opacity"]})
        save_disabled = entry["saveDisabled"]
        checks.check(f"{key} 정책 저장 버튼이 처음에 비활성",
                     save_disabled is not None and save_disabled["opacity"] == 0.55,
                     {"opacity": save_disabled["opacity"] if save_disabled else None,
                      "ariaDisabled": save_disabled["ariaDisabled"] if save_disabled else None})
        pixel = (save_disabled or {}).get("pixelContrast")
        checks.check(f"{key} 비활성 primary 픽셀 대비 {CONTRAST_MIN}:1 이상",
                     pixel is not None and pixel["contrast"] >= CONTRAST_MIN, pixel)
        if phase == "before":
            checks.check(f"{key} 변경 전 결함 재현: 비활성 보조 글자 픽셀이 저장 버튼 글자색 계열이 아님",
                         family["gap"] is not None
                         and family["gap"] > TEXT_FAMILY_CHROMA_TOLERANCE, family)
            checks.check(f"{key} 변경 전 비활성 보조 글자색이 link",
                         entry["empty"] is not None
                         and entry["empty"]["contentColor"] == LINK_RGB[theme],
                         {"contentColor": (entry["empty"] or {}).get("contentColor")})
        else:
            checks.check(f"{key} 비활성 보조 글자 픽셀이 저장 버튼과 같은 색 계열",
                         family["gap"] is not None
                         and family["gap"] <= TEXT_FAMILY_CHROMA_TOLERANCE, family)
            checks.check(f"{key} 비활성 보조 글자색이 textPrimary",
                         entry["empty"] is not None
                         and entry["empty"]["contentColor"] == TEXT_PRIMARY_RGB[theme],
                         {"contentColor": (entry["empty"] or {}).get("contentColor")})
            checks.check(f"{key} 비활성 보조 픽셀 대비 {CONTRAST_MIN}:1 이상",
                         add_pixel is not None and add_pixel["contrast"] >= CONTRAST_MIN,
                         add_pixel)
        if entry["enabled"] is not None:
            checks.check(f"{key} 활성 보조 글자색이 link",
                         entry["enabled"]["contentColor"] == LINK_RGB[theme],
                         {"contentColor": entry["enabled"]["contentColor"]})
        save_enabled = entry["saveEnabled"]
        checks.check(f"{key} 출처를 추가하면 정책 저장 버튼이 활성",
                     save_enabled is not None and save_enabled["opacity"] == 1
                     and save_enabled["ariaDisabled"] != "true",
                     {"opacity": save_enabled["opacity"] if save_enabled else None,
                      "ariaDisabled": save_enabled["ariaDisabled"] if save_enabled else None})
    finally:
        page.close()
        context.close()
    return entry


def capture_auto_refresh(browser: Browser, base: str, out: Path, phase: str,
                         checks: Checks) -> dict:
    frame_id, width, height = SAMPLE_FRAME
    entry: dict = {"skipped": None}
    checks_by_theme: list[dict] = []
    for theme in THEMES:
        key = f"autoRefresh/{frame_id}/{theme}"
        context = browser.new_context(viewport={"width": width, "height": height},
                                      device_scale_factor=2)
        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
        url = f"{base}{PREFIX}index.html?section=autoRefresh&theme={theme}"
        page, errors = open_page(context, base, url)
        try:
            try:
                page.get_by_test_id("refresh-finish").wait_for(state="attached", timeout=20000)
            except Exception as error:  # noqa: BLE001 - 하네스에서 안 열리면 사유를 남긴다
                entry["skipped"] = f"autoRefresh 화면에서 refresh-finish를 열지 못함: {error}"
                checks_by_theme.append({"theme": theme, "skipped": entry["skipped"]})
                continue
            settle(page)
            metrics = page.evaluate(AUTO_REFRESH_JS)
            sample = annotate_button(metrics["finish"])
            checks_by_theme.append({"theme": theme, "finish": sample, "begin": metrics["begin"],
                                    "phase": metrics["phase"], "errors": errors,
                                    "screenshot": shot(page, out,
                                                       f"autoRefresh-{frame_id}-{theme}",
                                                       width, height)})
            checks.check(f"{key} 페이지 오류 없음", not errors, errors)
            background = sample["backgroundColor"] if sample else None
            checks.check(f"{key} 비활성 보조 버튼 바탕이 투명",
                         sample is not None and is_transparent(background),
                         {"backgroundColor": background})
        finally:
            page.close()
            context.close()
    entry["themes"] = checks_by_theme
    return entry


def primary_states(entry: dict | None, screen: str) -> tuple:
    """화면별 primary 표본(비활성, 활성, 같은 판을 견줄 보조 단추)을 꺼낸다."""
    entry = entry or {}
    if screen == "connection":
        samples = entry.get("samples") or {}
        return samples.get("save"), samples.get("saveEnabled"), samples.get("testConnection")
    return entry.get("saveDisabled"), entry.get("saveEnabled"), entry.get("reload")


def secondary_states(entry: dict | None, screen: str) -> tuple:
    """화면별 보조 단추 표본(비활성, 활성)을 꺼낸다."""
    entry = entry or {}
    if screen == "connection":
        samples = entry.get("samples") or {}
        return samples.get("testConnection"), samples.get("testConnectionEnabled")
    return entry.get("empty"), entry.get("enabled")


def in_footer(entry: dict | None, sample: dict | None) -> bool:
    """표본 단추가 하단 저장 줄의 단추인지 좌표로 가른다."""
    box = (sample or {}).get("box") or {}
    for button in ((entry or {}).get("footer") or {}).get("buttons") or []:
        other = button.get("box") or {}
        if (abs(other.get("left", 0) - box.get("left", 0)) <= ALIGN_TOLERANCE_PX
                and abs(other.get("top", 0) - box.get("top", 0)) <= ALIGN_TOLERANCE_PX
                and abs(other.get("width", 0) - box.get("width", 0)) <= ALIGN_TOLERANCE_PX):
            return True
    return False


def compare_phases(before: dict, after: dict, checks: Checks) -> dict:
    """카드 좌표 1px, 비활성 primary의 불변과 보조 글자색·하단 폭의 변화를 본다."""
    summary: dict = {}
    for screen in ("connection", "display", "reviewPolicy"):
        for key, current in after.get("screens", {}).get(screen, {}).items():
            prior = before.get("screens", {}).get(screen, {}).get(key)
            if not prior or not current:
                continue
            old_cards = {(section["id"], card["index"]): card["box"]
                         for section in prior.get("sections") or []
                         for card in section["cards"]}
            new_cards = {(section["id"], card["index"]): card["box"]
                         for section in current.get("sections") or []
                         for card in section["cards"]}
            checks.check(f"전후 {screen}/{key} 카드 목록 동일", set(old_cards) == set(new_cards),
                         {"before": sorted(map(str, old_cards)),
                          "after": sorted(map(str, new_cards))})
            deltas = []
            for ident, box in new_cards.items():
                old = old_cards.get(ident)
                if old is None:
                    continue
                delta = {axis: round(box[axis] - old[axis], 2)
                         for axis in ("left", "top", "width", "height")}
                checks.check(
                    f"전후 {screen}/{key}/{ident[0]}/카드{ident[1]} "
                    f"좌표 {ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX for value in delta.values()), delta)
                deltas.append({"section": ident[0], "index": ident[1], "delta": delta})
            summary[f"{screen}/{key}"] = deltas

    primary: dict = {}
    secondary: dict = {}
    footer: dict = {}
    color_fields = ("backgroundColor", "contentColor", "opacity")
    for screen in ("connection", "reviewPolicy"):
        for key, current in after.get("screens", {}).get(screen, {}).items():
            prior = before.get("screens", {}).get(screen, {}).get(key)
            if not prior or not current:
                continue
            old_disabled, old_enabled, _ = primary_states(prior, screen)
            new_disabled, new_enabled, new_peer = primary_states(current, screen)
            if not (old_disabled and new_disabled):
                continue
            theme = key.rsplit("/", 1)[-1]
            text_primary = TEXT_PRIMARY_RGB.get(theme)
            link = LINK_RGB.get(theme)
            colors = {field: {"before": old_disabled.get(field),
                              "after": new_disabled.get(field)} for field in color_fields}
            checks.check(
                f"전후 {screen}/{key} 비활성 primary 색·불투명도 동일(카드 #1119 유지)",
                all(old_disabled.get(field) == new_disabled.get(field) for field in color_fields),
                colors)

            old_surface = old_disabled.get("surface") or {}
            new_surface = new_disabled.get("surface") or {}
            peer_surface = (new_peer or {}).get("surface") or {}
            surface_fields = ("backgroundColor", "backdropFilter", "borderRadius")
            checks.check(
                f"전후 {screen}/{key} 비활성 primary 판 불변",
                all(old_surface.get(field) == new_surface.get(field)
                    for field in surface_fields),
                {"before": old_surface, "after": new_surface})
            checks.check(
                f"전후 {screen}/{key} 비활성 primary 판이 같은 화면 보조 단추 판과 같음",
                new_surface.get("backgroundColor") == peer_surface.get("backgroundColor")
                and new_surface.get("backdropFilter") == peer_surface.get("backdropFilter"),
                {"after": new_surface, "peer": peer_surface})

            if in_footer(prior, old_disabled) and in_footer(current, new_disabled):
                # 하단 단추는 폭을 맞추는 것이 이 카드의 변경이다. 세로 위치와
                # 바깥선은 아래 하단 단추 비교에서 따로 본다.
                vertical_delta = {axis: round(new_disabled["box"][axis]
                                              - old_disabled["box"][axis], 2)
                                  for axis in ("top", "height")}
                checks.check(
                    f"전후 {screen}/{key} 비활성 primary 세로 좌표 "
                    f"{ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX
                        for value in vertical_delta.values()), vertical_delta)
            else:
                box_delta = {axis: round(new_disabled["box"][axis]
                                         - old_disabled["box"][axis], 2)
                             for axis in ("left", "top", "width", "height")}
                checks.check(
                    f"전후 {screen}/{key} 비활성 primary 상자 좌표 "
                    f"{ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX
                        for value in box_delta.values()), box_delta)

            if old_enabled and new_enabled:
                same = all(old_enabled.get(field) == new_enabled.get(field)
                           for field in color_fields)
                checks.check(f"전후 {screen}/{key} 활성 primary 색·불투명도 동일", same,
                             {"before": {field: old_enabled.get(field) for field in color_fields},
                              "after": {field: new_enabled.get(field) for field in color_fields}})
                if in_footer(prior, old_enabled) and in_footer(current, new_enabled):
                    enabled_delta = {
                        axis: round(new_enabled["box"][axis] - old_enabled["box"][axis], 2)
                        for axis in ("top", "height")}
                    checks.check(
                        f"전후 {screen}/{key} 활성 primary 세로 좌표 "
                        f"{ALIGN_TOLERANCE_PX}px 이내",
                        all(abs(value) <= ALIGN_TOLERANCE_PX
                            for value in enabled_delta.values()), enabled_delta)
                else:
                    enabled_delta = {
                        axis: round(new_enabled["box"][axis] - old_enabled["box"][axis], 2)
                        for axis in ("left", "top", "width", "height")}
                    checks.check(
                        f"전후 {screen}/{key} 활성 primary 상자 좌표 "
                        f"{ALIGN_TOLERANCE_PX}px 이내",
                        all(abs(value) <= ALIGN_TOLERANCE_PX
                            for value in enabled_delta.values()), enabled_delta)

            old_pixel = (old_disabled.get("pixelContrast") or {}).get("contrast")
            new_pixel = (new_disabled.get("pixelContrast") or {}).get("contrast")
            checks.check(
                f"전후 {screen}/{key} 비활성 primary 픽셀 대비 {CONTRAST_MIN}:1 이상 유지",
                old_pixel is not None and new_pixel is not None
                and old_pixel >= CONTRAST_MIN and new_pixel >= CONTRAST_MIN
                and abs(old_pixel - new_pixel) <= 0.2,
                {"before": old_disabled.get("pixelContrast"),
                 "after": new_disabled.get("pixelContrast")})
            primary[f"{screen}/{key}"] = {
                "before": old_disabled.get("pixelContrast"),
                "after": new_disabled.get("pixelContrast"),
                "colors": colors,
            }

            old_secondary, old_secondary_enabled = secondary_states(prior, screen)
            new_secondary, new_secondary_enabled = secondary_states(current, screen)
            if old_secondary and new_secondary:
                checks.check(
                    f"전후 {screen}/{key} 비활성 보조 글자색이 link에서 textPrimary로 바뀜",
                    old_secondary.get("contentColor") == link
                    and new_secondary.get("contentColor") == text_primary,
                    {"before": old_secondary.get("contentColor"),
                     "after": new_secondary.get("contentColor")})
                old_family = text_family_gap(old_secondary.get("pixelContrast"),
                                             old_disabled.get("pixelContrast"))
                new_family = text_family_gap(new_secondary.get("pixelContrast"),
                                             new_disabled.get("pixelContrast"))
                checks.check(
                    f"전후 {screen}/{key} 비활성 보조 글자 픽셀 계열: 다름 → 저장 버튼과 같음",
                    old_family["gap"] is not None and new_family["gap"] is not None
                    and old_family["gap"] > TEXT_FAMILY_CHROMA_TOLERANCE
                    and new_family["gap"] <= TEXT_FAMILY_CHROMA_TOLERANCE,
                    {"before": old_family, "after": new_family})
                secondary_delta = {
                    axis: round(new_secondary["box"][axis] - old_secondary["box"][axis], 2)
                    for axis in ("left", "top", "width", "height")}
                checks.check(
                    f"전후 {screen}/{key} 비활성 보조 상자 좌표 {ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX for value in secondary_delta.values()),
                    secondary_delta)
            if old_secondary_enabled and new_secondary_enabled:
                checks.check(
                    f"전후 {screen}/{key} 활성 보조 글자색 link 유지",
                    old_secondary_enabled.get("contentColor") == link
                    and new_secondary_enabled.get("contentColor") == link,
                    {"before": old_secondary_enabled.get("contentColor"),
                     "after": new_secondary_enabled.get("contentColor")})
                enabled_secondary_delta = {
                    axis: round(new_secondary_enabled["box"][axis]
                                - old_secondary_enabled["box"][axis], 2)
                    for axis in ("left", "top", "width", "height")}
                checks.check(
                    f"전후 {screen}/{key} 활성 보조 상자 좌표 {ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX
                        for value in enabled_secondary_delta.values()),
                    enabled_secondary_delta)
            secondary[f"{screen}/{key}"] = {
                "before": {"color": (old_secondary or {}).get("contentColor"),
                           "pixel": (old_secondary or {}).get("pixelContrast")},
                "after": {"color": (new_secondary or {}).get("contentColor"),
                          "pixel": (new_secondary or {}).get("pixelContrast")},
            }

    for screen in ("connection", "reviewPolicy"):
        for key, current in after.get("screens", {}).get(screen, {}).items():
            prior = before.get("screens", {}).get(screen, {}).get(key)
            if not prior or not current:
                continue
            old_gap = prior.get("footerWidthGap")
            new_gap = current.get("footerWidthGap")
            checks.check(
                f"전후 {screen}/{key} 하단 단추 폭 차이가 큼 → "
                f"{FOOTER_WIDTH_TOLERANCE_PX}px 이내",
                old_gap is not None and new_gap is not None
                and old_gap > FOOTER_WIDTH_TOLERANCE_PX >= new_gap,
                {"before": old_gap, "after": new_gap})
            old_buttons = (prior.get("footer") or {}).get("buttons") or []
            new_buttons = (current.get("footer") or {}).get("buttons") or []
            if len(old_buttons) == 2 and len(new_buttons) == 2:
                checks.check(
                    f"전후 {screen}/{key} 하단 단추 순서 동일",
                    [button.get("text") for button in old_buttons]
                    == [button.get("text") for button in new_buttons],
                    {"before": [button.get("text") for button in old_buttons],
                     "after": [button.get("text") for button in new_buttons]})
                edges = {
                    "firstLeft": round(new_buttons[0]["box"]["left"]
                                       - old_buttons[0]["box"]["left"], 2),
                    "lastRight": round(new_buttons[1]["box"]["right"]
                                       - old_buttons[1]["box"]["right"], 2),
                    "top": round(new_buttons[0]["box"]["top"]
                                 - old_buttons[0]["box"]["top"], 2),
                    "firstHeight": round(new_buttons[0]["box"]["height"]
                                         - old_buttons[0]["box"]["height"], 2),
                    "lastHeight": round(new_buttons[1]["box"]["height"]
                                        - old_buttons[1]["box"]["height"], 2),
                }
                checks.check(
                    f"전후 {screen}/{key} 하단 단추 바깥선·높이 "
                    f"{ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX
                        for value in edges.values()), edges)
            footer[f"{screen}/{key}"] = {"before": old_gap, "after": new_gap}
    return {"cards": summary, "primary": primary, "secondary": secondary, "footer": footer}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    parser.add_argument("--phase", required=True, choices=("before", "after"),
                        help="프로덕션 변경 전/후 번들")
    parser.add_argument("--compare", help="비교할 반대 단계의 settings-text-contrast.json")
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"phase": args.phase, "passed": False, "errors": [], "warnings": [],
                    "screens": {"connection": {}, "display": {}, "reviewPolicy": {}}}
    checks = Checks()
    try:
        with BundleServer(bundle_root) as server:
            base = server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for frame_id, width, height in FRAMES:
                        for theme in THEMES:
                            key = f"{frame_id}/{theme}"
                            result["screens"]["connection"][key] = capture_connection(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                            result["screens"]["display"][key] = capture_display(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                            result["screens"]["reviewPolicy"][key] = capture_review_policy(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                    result["samples"] = {"autoRefresh": capture_auto_refresh(
                        browser, base, out, args.phase, checks)}
                finally:
                    browser.close()
        if args.compare:
            prior = json.loads(Path(args.compare).read_text(encoding="utf-8"))
            result["comparison"] = compare_phases(prior, result, checks)
        skipped = result["samples"]["autoRefresh"].get("skipped")
        if skipped:
            result["warnings"].append(skipped)
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "settings-text-contrast.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "phase": result["phase"],
        "passed": result["passed"],
        "errors": result["errors"],
        "warnings": result["warnings"],
        "checks": len(result["checks"]),
        "failed": [entry["name"] for entry in result["checks"] if not entry["passed"]],
    }, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""듀오 레일 캡슐의 밝은 리퀴드 글래스(라이트/다크) 시각 검수.

무엇을 검수하나
---------------
- 다크·라이트 테마 모두에서 레일 캡슐(`RailCapsule`)이 밝고 반투명한 리퀴드 유리로
  렌더되고, 불투명 틴트나 인위적 외곽선 없이 backdrop blur와 정확한 24pt 곡률을 쓴다.
  회귀 기준은 이전의 탁한 회색(`#4c4a4f`)이 아니라 밝은 유리다.
- 캡슐 안 아이콘은 캡슐의 밝은 표면을 기준으로 고른 색을 쓴다. 다크 테마 비선택
  `rgb(17, 17, 17)`, 라이트 테마 비선택 `rgb(83, 87, 93)`, 선택 `rgb(0, 43, 102)`.
  선택·비선택 아이콘 모두 어두운 캔버스(`#0f0f0f`)와 밝은 포스트잇(`#eee8f6`)
  양쪽에서 WCAG AA 4.5:1 이상이어야 한다.
- 배지·점 색상은 배경 `#d8ebff`, 글자·점 `rgb(0, 43, 102)`를 쓰며 배지 글자 대비도
  AA 4.5:1 이상이다.
- 캡슐 크기 계약(폭 48)과 24pt 곡률, 외곽선 0을 유지한다.
- 떠 있는 새 대화 합성기는 바깥 유리 한 겹만 쓰고, 내부 입력 박스는 backdrop filter와
  경계선을 중복해 만들지 않는다.
- 불변: 캡슐이 아닌 chrome(하단 탭바 유리)은 다크 테마에서 계속 어두운 유리를 쓰고
  외곽선을 두지 않는다.
- 리뷰 화면 `?theme=dark`는 루트 프레임과 NavigationContainer 배경을 `#0f0f0f`로 칠한다.

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

UNSELECTED_ICON_RGB = {"dark": (17, 17, 17), "light": (83, 87, 93)}
SELECTED_ICON_RGB = (0, 43, 102)
DARK_CANVAS_RGB = (15, 15, 15)
BRIGHT_POSTIT_RGB = (238, 232, 246)
LIGHT_BACKDROP_RGB = (255, 255, 255)
DARK_BACKDROP_RGB = (15, 15, 15)
AA_CONTRAST = 4.5

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


def composite(foreground: tuple[float, float, float], alpha: float,
              background: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(alpha * fg + (1 - alpha) * bg for fg, bg in zip(foreground, background))


def relative_luminance(rgb: tuple[float, float, float]) -> float:
    def linear(channel: float) -> float:
        value = channel / 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4

    red, green, blue = (linear(channel) for channel in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(first: tuple[float, float, float],
                   second: tuple[float, float, float]) -> float:
    light, dark = sorted((relative_luminance(first), relative_luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def page_url(base: str, frame_id: str, theme: str, extra: str = "") -> str:
    query = f"section=iphoneDuo&sample=main-layout&frame={frame_id}&board=ops&theme={theme}"
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
    checks.check(f"{prefix} 캡슐이 밝은 유리",
                 min(fill_rgb) >= 230 and 0.5 <= fill_alpha <= 0.75,
                 {"backgroundColor": capsule["backgroundColor"]})
    checks.check(f"{prefix} 캡슐이 반투명", fill_alpha < 1, capsule["backgroundColor"])
    checks.check(f"{prefix} backdrop blur", "blur(" in (capsule["backdropFilter"] or ""),
                 capsule["backdropFilter"])
    checks.check(f"{prefix} 외곽선 0", capsule["borderWidth"] == "0px", capsule["borderWidth"])

    expected_unselected = f"rgb({UNSELECTED_ICON_RGB[theme][0]}, {UNSELECTED_ICON_RGB[theme][1]}, {UNSELECTED_ICON_RGB[theme][2]})"
    expected_selected = f"rgb({SELECTED_ICON_RGB[0]}, {SELECTED_ICON_RGB[1]}, {SELECTED_ICON_RGB[2]})"
    unselected = [color for color in metrics["icons"] if color == expected_unselected]
    unknown = [color for color in metrics["icons"] if color not in (expected_unselected, expected_selected)]
    checks.check(f"{prefix} 비선택 아이콘 색", bool(unselected), metrics["icons"])
    checks.check(f"{prefix} 예상 밖 아이콘 색 없음", not unknown, unknown)

    backdrops = [DARK_BACKDROP_RGB, BRIGHT_POSTIT_RGB] if theme == "dark" else [LIGHT_BACKDROP_RGB]
    unselected_rgb, _ = parse_rgb(expected_unselected)
    ratios = {}
    for backdrop in backdrops:
        surface = composite(fill_rgb, fill_alpha, backdrop)
        ratios[f"#{backdrop[0]:02x}{backdrop[1]:02x}{backdrop[2]:02x}"] = round(
            contrast_ratio(unselected_rgb, surface), 2)
    checks.check(f"{prefix} 비선택 아이콘 AA 4.5:1", all(value >= AA_CONTRAST for value in ratios.values()), ratios)

    canvas = metrics["fullFrameBackgrounds"]
    if theme == "dark":
        expected_canvas = f"rgb({DARK_CANVAS_RGB[0]}, {DARK_CANVAS_RGB[1]}, {DARK_CANVAS_RGB[2]})"
        checks.check(f"{prefix} 다크 캔버스(루트+내비게이션) 2겹", canvas.count(expected_canvas) >= 2, canvas)

    selected_ratios = {
        key: round(contrast_ratio(parse_rgb(expected_selected)[0],
                                  composite(fill_rgb, fill_alpha, backdrop)), 2)
        for key, backdrop in zip(ratios, backdrops)
    }
    checks.check(f"{prefix} 선택 아이콘 AA 4.5:1",
                 all(value >= AA_CONTRAST for value in selected_ratios.values()), selected_ratios)
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    return {"url": url, "screenshot": screenshot, "metrics": metrics,
            "contrast": {"unselected": ratios, "selected": selected_ratios}}


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
            if view == "rail-badge":
                badge = metrics["badges"][0] if metrics["badges"] else None
                checks.check(f"{prefix} 배지 존재", badge is not None, metrics)
                checks.check(f"{prefix} 배경 #d8ebff", badge and badge["backgroundColor"] == "rgb(216, 235, 255)",
                             badge)
                checks.check(f"{prefix} 글자 #002b66", badge and badge["color"] == "rgb(0, 43, 102)", badge)
                badge_ratio = round(contrast_ratio((0, 43, 102), (216, 235, 255)), 2)
                checks.check(f"{prefix} 배지 글자 AA 4.5:1", badge_ratio >= AA_CONTRAST, badge_ratio)
            else:
                dot = metrics["dots"][0] if metrics["dots"] else None
                checks.check(f"{prefix} 점 존재", dot is not None, metrics)
                checks.check(f"{prefix} 점 #002b66", dot and dot["backgroundColor"] == "rgb(0, 43, 102)", dot)
            checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
            states[f"{view}-{theme}"] = {"url": url, "screenshot": screenshot, "metrics": metrics}
    return states


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

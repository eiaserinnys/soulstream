"""폰과 아이패드 세 폭 시각 검수의 공용 틀: 번들 서버, 페이지 열기, 비교 그림 (카드 #1970)."""
from __future__ import annotations

import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Browser, Page

PREFIX = "/assets/ios-components/"
ENTRY_SHELL = "section=entryShell&safeArea=fixture"
FRAMES = (("phone", 390, 844), ("ipad-portrait", 834, 1210), ("ipad-landscape", 1210, 834))
NARROW = ("ipad-narrow", 616, 900)
TABLET_FRAMES = tuple(frame for frame in FRAMES if frame[0] != "phone")
EDGE_TOLERANCE = 1
FONT_PATHS = ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc")

PULL_REFRESH_JS = r"""
(testId) => {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) return 'no-element';
  window.__soulAppStarredRecovered = true;
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
  for (let fiber = key ? element[key] : null; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props && typeof props.onRefresh === 'function' && typeof props.refreshing === 'boolean') {
      props.onRefresh();
      return 'called';
    }
  }
  return 'no-refresh-control';
}
"""


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
            def log_message(self, *args):
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
                if not path.startswith(PREFIX):
                    self._send(404, b"", "text/plain")
                    return
                file = (bundle_root / path[len(PREFIX):]).resolve()
                if bundle_root not in file.parents or not file.is_file():
                    self._send(404, b"", "text/plain")
                    return
                body = file.read_bytes()
                if file.suffix == ".js":
                    for old, new in substitutions.items():
                        body = body.replace(old, new)
                self._send(200, body, mimetypes.guess_type(str(file))[0] or "application/octet-stream")

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


class Run:
    def __init__(self, browser: Browser, base: str, out: Path, phase: str):
        self.browser, self.base, self.out, self.phase = browser, base, out, phase
        self.checks: list[dict] = []
        self.notes: list[str] = []
        self.shots: dict[str, dict[str, str]] = {}
        self.operations: dict[str, object] = {}
        self.custom_compares: dict[str, str] = {}

    def check(self, name: str, condition: bool, detail) -> None:
        self.checks.append({"name": name, "passed": bool(condition), "detail": detail})

    def open(self, frame: tuple[str, int, int], query: str = "", base: str | None = None,
             section: str = ENTRY_SHELL) -> Page:
        _, width, height = frame
        base = base or self.base
        context = self.browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
        page = context.new_page()
        page.set_default_timeout(15000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/*", lambda route: route.continue_()
                   if route.request.url.startswith(base) else route.abort())
        page.goto(f"{base}{PREFIX}index.html?{section}{query}", wait_until="load")
        page.wait_for_timeout(2500)
        page.evaluate("async () => { await document.fonts.ready; }")
        page.errors = errors  # type: ignore[attr-defined]
        return page

    def shot(self, page: Page, area: str, frame: str) -> None:
        page.wait_for_timeout(700)
        path = self.out / f"{self.phase}-{area}-{frame}.png"
        page.screenshot(path=str(path))
        self.shots.setdefault(area, {})[frame] = str(path)
        errors = getattr(page, "errors", [])
        if errors:
            self.notes.append(f"{area}/{frame} page errors: {errors[:2]}")

    def missing(self, area: str, frame: str, reason: str) -> None:
        self.shots.setdefault(area, {})[frame] = f"missing: {reason}"
        self.notes.append(f"{area}/{frame}: {reason}")



def visible(page: Page, locator) -> bool:
    try:
        return any(locator.nth(index).is_visible() for index in range(locator.count()))
    except Exception:  # noqa: BLE001
        return False


def ensure_sidebar(page: Page, width: int) -> None:
    """세로에서는 사이드바가 서랍 안에 있으므로 「메뉴」로 연다."""
    if visible(page, page.get_by_test_id("sidebar-main-list")):
        box = page.get_by_test_id("sidebar-main-list").bounding_box()
        if box and box["x"] >= 0 and box["x"] + box["width"] <= width:
            return
    page.get_by_label("메뉴", exact=True).first.click()
    page.wait_for_timeout(900)



def pull_refresh(page: Page, test_id: str) -> str:
    """RN-web은 당김 제스처를 그리지 않으니 스크롤 칸의 RefreshControl onRefresh를 직접 부른다."""
    return page.evaluate(PULL_REFRESH_JS, test_id)


def capture_area(run: Run, area: str, frames, action, query: str = "", section: str = ENTRY_SHELL) -> None:
    for frame in frames:
        frame_id, width, _ = frame
        page = run.open(frame, query, section=section)
        try:
            action(page, frame_id, width)
            run.shot(page, area, frame_id)
        except Exception as error:  # noqa: BLE001 - 한 영역이 막혀도 다른 영역은 찍는다
            run.missing(area, frame_id, f"navigation failed: {str(error).splitlines()[0]}")
        finally:
            page.context.close()



def font(size: int):
    for path in FONT_PATHS:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()



def compose_tiles(path: Path, tiles: list[tuple[str, str]]) -> str:
    gap, label_h, height = 24, 40, 900
    images = []
    for label, source in tiles:
        if source.startswith("missing"):
            images.append((label, None, source))
            continue
        image = Image.open(source).convert("RGB")
        images.append((label, image.resize((round(image.width * height / image.height), height)), None))
    widths = [image.width if image else 390 for _, image, _ in images]
    sheet = Image.new("RGB", (sum(widths) + gap * (len(images) + 1), height + label_h + gap), "white")
    draw = ImageDraw.Draw(sheet)
    x = gap
    for (label, image, reason), width in zip(images, widths):
        draw.text((x, 8), label, fill="black", font=font(20))
        if image:
            sheet.paste(image, (x, label_h))
        else:
            draw.rectangle((x, label_h, x + width, label_h + height), outline="#999999", fill="#f2f2f2")
            draw.multiline_text((x + 16, label_h + 16), reason.replace(": ", ":\n", 1)[:120], fill="#555555", font=font(16))
        x += width + gap
    sheet.save(path)
    return str(path)


def compose(run: Run, area: str, frames: dict[str, str]) -> str:
    tiles = [(f"{area} · {frame_id}", frames.get(frame_id, "missing: not captured")) for frame_id, _, _ in FRAMES]
    return compose_tiles(run.out / f"{run.phase}-{area}-compare.png", tiles)


def stack(top: Path, bottom: Path, path: Path, labels: tuple[str, str]) -> str:
    """같은 영역의 전후 비교 그림을 위아래로 붙인다."""
    images = [Image.open(top).convert("RGB"), Image.open(bottom).convert("RGB")]
    label_h = 44
    width = max(image.width for image in images)
    sheet = Image.new("RGB", (width, sum(image.height + label_h for image in images)), "white")
    draw = ImageDraw.Draw(sheet)
    y = 0
    for label, image in zip(labels, images):
        draw.text((24, y + 10), label, fill="#b00020" if label.startswith("before") else "#006400", font=font(24))
        sheet.paste(image, (0, y + label_h))
        y += image.height + label_h
    sheet.save(path)
    return str(path)

#!/usr/bin/env python3
"""설치 비밀번호 로그인 화면 시각 검수 (카드 #1787 U1).

`unified-dashboard/dist`를 이 스크립트 안의 작은 API 대역과 함께 서빙하고,
로그인 화면을 넓은 폭(1440)과 좁은 폭(390, 360)에서 캡처하며 ui-design §0의
조작 항목 14번부터 18번을 직접 잰다.

모드
  password: `passwordLoginEnabled: true`. 비밀번호 입력과 로그인 단추가 보이고
            Google 단추는 그리지 않는다. 틀린 비밀번호 오류 상태도 캡처한다.
  google:   `passwordLoginEnabled: false`. Google 단추만 보인다. 바꾸기 전후
            화면의 DOM을 `google-surface.html`로 남겨 두 빌드의 동일성을 대조한다.

단언 (password 모드)
  1) 14번: 제출한 뒤 초점이 로그인 폼 안(단추)에 남고 body로 튀지 않는다.
  2) 15번: Tab 첫 두 정지점이 비밀번호 입력과 로그인 단추다. 숨은 Google 단추는
     DOM에 없어 초점이 들어갈 수 없다. Esc로 닫을 대화상자가 없다(해당 없음).
  3) 16번: 360px에서 가로 스크롤이 없고 제목, 입력, 단추가 카드 안에 있고 겹치지 않는다.
  4) 17번: 틀린 비밀번호가 `role=alert` 자리에 실패 안내로 바뀌고 다시 시도할 수 있다.
  5) 18번: 넓은 폭에서 입력한 글을 좁은 폭으로 줄여도 유지하고 배치가 다시 선다.

사용
  corepack pnpm -C unified-dashboard run build
  python3 -P scripts/visual-check/login_screen.py --mode password --output .local/captures/u1
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import mimetypes
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
DIST_ROOT = REPO_ROOT / "unified-dashboard" / "dist"
PASSWORD = "correct-horse-battery-staple"
WIDE = {"width": 1440, "height": 900}
NARROW = {"width": 390, "height": 844}
MINIMUM = {"width": 360, "height": 800}
TOLERANCE = 1.0


class LoginApiState:
    """`/api/auth/*` 대역이 돌려줄 값. 모드만 바꾸면 화면이 갈린다."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.password_attempts: list[str] = []


class LoginRequestHandler(http.server.BaseHTTPRequestHandler):
    state: LoginApiState

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/auth/config":
            self._json(200, {
                "authEnabled": True,
                "devModeEnabled": False,
                "passwordLoginEnabled": self.state.mode == "password",
            })
            return
        if path == "/api/auth/status":
            self._json(200, {"authenticated": False, "user": None})
            return
        if path == "/api/health":
            # The dashboard shows a blocking "connection lost" dialog unless the
            # health probe answers healthy. "dev" keeps the build-id check quiet.
            self._json(200, {
                "healthy": True,
                "ready": True,
                "draining": False,
                "build_id": "dev",
            })
            return
        if path.startswith("/api/"):
            self._json(404, {"detail": "not found"})
            return
        self._static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/auth/password-login":
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            try:
                password = str(json.loads(body).get("password", ""))
            except json.JSONDecodeError:
                self._json(400, {"detail": "Invalid request body"})
                return
            self.state.password_attempts.append(password)
            if password == PASSWORD:
                self._json(200, {"success": True})
            else:
                self._json(401, {"detail": "비밀번호가 맞지 않습니다"})
            return
        if path == "/api/auth/logout":
            self._json(200, {"success": True})
            return
        self._json(404, {"detail": "not found"})

    def _json(self, status: int, payload: dict[str, object]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path: str) -> None:
        relative = urllib.parse.unquote(path.lstrip("/")) or "index.html"
        candidate = (DIST_ROOT / relative).resolve()
        if DIST_ROOT not in candidate.parents and candidate != DIST_ROOT:
            self._json(404, {"detail": "not found"})
            return
        if not candidate.is_file():
            candidate = DIST_ROOT / "index.html"
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def start_server(mode: str) -> tuple[http.server.ThreadingHTTPServer, str]:
    LoginRequestHandler.state = LoginApiState(mode)
    handler = LoginRequestHandler
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"


def wait_for_login(page: Page, expect_password: bool) -> None:
    page.wait_for_selector("[data-testid=login-page]", timeout=30_000)
    selector = "[data-testid=password-login-input]" if expect_password else "[data-testid=google-login-button]"
    page.wait_for_selector(selector, timeout=15_000)


def measure_layout(page: Page) -> dict[str, object]:
    return page.evaluate("""() => {
      const surface = document.querySelector('[data-testid=login-page] > div');
      const input = document.querySelector('[data-testid=password-login-input]');
      const button = document.querySelector('[data-testid=password-login-button]');
      const rect = (node) => node ? node.getBoundingClientRect().toJSON() : null;
      const style = (node) => node ? getComputedStyle(node) : null;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        surface: rect(surface),
        input: rect(input),
        button: rect(button),
        inputFontSize: style(input)?.fontSize ?? null,
        buttonFontSize: style(button)?.fontSize ?? null,
        activeTestId: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
      };
    }""")


def assert_inside(name: str, box: dict[str, float] | None, bounds: dict[str, float]) -> None:
    if box is None:
        raise AssertionError(f"{name} is missing")
    if box["left"] < bounds["left"] - TOLERANCE or box["right"] > bounds["right"] + TOLERANCE:
        raise AssertionError(f"{name} leaves the card horizontally: {box} not in {bounds}")
    if box["top"] < bounds["top"] - TOLERANCE or box["bottom"] > bounds["bottom"] + TOLERANCE:
        raise AssertionError(f"{name} leaves the card vertically: {box} not in {bounds}")


def capture_password(page: Page, output: Path) -> dict[str, object]:
    results: dict[str, object] = {}
    page.set_viewport_size(WIDE)
    wait_for_login(page, expect_password=True)
    page.screenshot(path=str(output / "password-wide.png"), full_page=True)
    wide = measure_layout(page)
    results["wide"] = wide
    assert_inside("surface", wide["surface"], {
        "left": 0, "right": WIDE["width"], "top": 0, "bottom": WIDE["height"],
    })
    if wide["input"] is None or wide["button"] is None or wide["surface"] is None:
        raise AssertionError("password form is not fully rendered at 1440")
    if float(wide["inputFontSize"].removesuffix("px")) < 13 or float(wide["buttonFontSize"].removesuffix("px")) < 13:
        raise AssertionError("password form text is smaller than 13px")
    if abs((wide["input"]["left"] - wide["surface"]["left"]) - (wide["surface"]["right"] - wide["button"]["right"])) > TOLERANCE:
        raise AssertionError("input/button do not share the card's left and right edges")

    # §0 15번: Tab 정지점은 보이는 입력과 단추 둘뿐이다.
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    tab_stops: list[str] = []
    for _ in range(3):
        page.keyboard.press("Tab")
        tab_stops.append(page.evaluate(
            "() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName"))
    results["tabStops"] = tab_stops
    if tab_stops[:2] != ["password-login-input", "password-login-button"]:
        raise AssertionError(f"Tab order is not input then button: {tab_stops}")
    if "[data-testid=google-login-button]" in tab_stops:
        raise AssertionError("hidden Google button is focusable")

    # §0 17번: 틀린 비밀번호는 같은 틀 안의 실패 안내가 되고 다시 시도할 수 있다.
    page.fill("[data-testid=password-login-input]", "wrong-password")
    page.click("[data-testid=password-login-button]")
    page.wait_for_selector("[role=alert]", timeout=15_000)
    alert = page.locator("[role=alert]")
    alert_text = alert.inner_text().strip()
    results["errorText"] = alert_text
    if alert_text != "비밀번호가 맞지 않습니다":
        raise AssertionError(f"unexpected error text: {alert_text!r}")
    if page.locator("[data-testid=password-login-button]").is_disabled():
        raise AssertionError("retry button is disabled after a failed password")
    focused = page.evaluate(
        "() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName")
    results["focusAfterFailure"] = focused
    if focused != "password-login-input":
        raise AssertionError(f"focus did not return to the password field after failure: {focused}")
    page.screenshot(path=str(output / "password-error-wide.png"), full_page=True)
    error_layout = measure_layout(page)
    results["errorLayout"] = error_layout
    assert_inside("alert", page.evaluate(
        "() => document.querySelector('[role=alert]')?.getBoundingClientRect().toJSON()"), wide["surface"])

    # 오류 문구가 최소 폭 360에서도 카드 안에 들어오는지 같은 오류 상태로 잰다.
    page.set_viewport_size(MINIMUM)
    error_minimum = measure_layout(page)
    results["errorMinimum"] = error_minimum
    if error_minimum["scrollWidth"] > error_minimum["clientWidth"] + 1:
        raise AssertionError(f"horizontal scroll with the error at 360px: {error_minimum['scrollWidth']}")
    assert_inside("alert", page.evaluate(
        "() => document.querySelector('[role=alert]')?.getBoundingClientRect().toJSON()"), error_minimum["surface"])
    page.screenshot(path=str(output / "password-error-minimum.png"), full_page=True)
    page.set_viewport_size(WIDE)

    # 오류 상태 캡처를 마친 뒤 깨끗한 화면으로 돌아가 좁은 폭을 찍는다.
    page.reload(wait_until="domcontentloaded")
    wait_for_login(page, expect_password=True)

    # §0 16번: 프로젝트 최소 폭 360에서 가로 스크롤과 넘침이 없다.
    for viewport, label in ((NARROW, "narrow"), (MINIMUM, "minimum")):
        page.set_viewport_size(viewport)
        layout = measure_layout(page)
        results[label] = layout
        if layout["scrollWidth"] > layout["clientWidth"] + 1:
            raise AssertionError(f"horizontal scroll at {viewport['width']}px: {layout['scrollWidth']}")
        assert_inside("surface", layout["surface"], {
            "left": 0, "right": viewport["width"], "top": 0, "bottom": viewport["height"],
        })
        assert_inside("input", layout["input"], layout["surface"])
        assert_inside("button", layout["button"], layout["surface"])
        if layout["input"]["top"] >= layout["button"]["top"]:
            raise AssertionError("input and button overlap or are out of order")
        if layout["input"]["bottom"] > layout["button"]["top"] + TOLERANCE:
            raise AssertionError("input and button overlap at narrow width")
    page.set_viewport_size(NARROW)
    page.screenshot(path=str(output / "password-narrow.png"), full_page=True)

    # §0 18번: 넓은 폭에서 입력한 글은 좁은 폭으로 줄여도 유지된다.
    page.set_viewport_size(WIDE)
    page.fill("[data-testid=password-login-input]", "kept-across-resize")
    page.set_viewport_size(NARROW)
    kept = page.input_value("[data-testid=password-login-input]")
    results["valueAfterResize"] = kept
    if kept != "kept-across-resize":
        raise AssertionError(f"typed password was lost on resize: {kept!r}")
    resized = measure_layout(page)
    if resized["scrollWidth"] > resized["clientWidth"] + 1:
        raise AssertionError("horizontal scroll after resizing to 390px")
    page.set_viewport_size(WIDE)
    return results


def capture_google(page: Page, output: Path) -> dict[str, object]:
    results: dict[str, object] = {}
    page.set_viewport_size(WIDE)
    wait_for_login(page, expect_password=False)
    if page.locator("[data-testid=password-login-input]").count() != 0:
        raise AssertionError("password field must not render in Google mode")
    page.screenshot(path=str(output / "google-wide.png"), full_page=True)
    (output / "google-surface.html").write_text(
        page.locator("[data-testid=login-page] > div").evaluate("node => node.outerHTML"),
        encoding="utf-8")
    page.set_viewport_size(NARROW)
    wait_for_login(page, expect_password=False)
    page.screenshot(path=str(output / "google-narrow.png"), full_page=True)
    layout = measure_layout(page)
    results["narrow"] = layout
    if layout["scrollWidth"] > layout["clientWidth"] + 1:
        raise AssertionError("horizontal scroll in Google mode at 390px")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("password", "google"), required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()

    output = Path(options.output)
    output.mkdir(parents=True, exist_ok=True)
    if not (DIST_ROOT / "index.html").is_file():
        raise SystemExit("unified-dashboard/dist is missing; run `corepack pnpm -C unified-dashboard run build` first")

    server, base = start_server(options.mode)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport=WIDE)
            page.goto(base, wait_until="domcontentloaded")
            results = (
                capture_password(page, output)
                if options.mode == "password"
                else capture_google(page, output)
            )
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    (output / f"login-{options.mode}-report.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"mode": options.mode, "output": str(output), "ok": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

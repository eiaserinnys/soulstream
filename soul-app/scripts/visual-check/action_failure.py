#!/usr/bin/env python3
"""Action failure visual check (RN web component review bundle) — card #1316.

Launch method
-------------
1. Export the review bundle once from the soul-app directory:
       npm run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Run this script with only the output directory:
       python3 soul-app/scripts/visual-check/action_failure.py --out .local/artifacts/card1316/app

The script serves unified-dashboard/dist itself on an ephemeral local port and
never contacts a node. It opens the chat composer review page at iPad 820 and
iPhone 360 widths and captures, per scene:

  interrupt  before pressing 멈춤, and after the fake api rejects the interrupt
             with HTTP 409 (SESSION_NOT_RUNNING)
  approval   before pressing 승인 on the tool approval widget, and after the
             approval request is answered with HTTP 503

PASS judgments:
  - the failure text is visible after the action and matches the card #1316
    wording exactly
  - the 멈춤 button is enabled again right after the failure (aria-disabled is
    not true), so the reader can press it again
  - the approval buttons stay pressable after the failure
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import threading
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[3]
DIST_ROOT = REPO_ROOT / "unified-dashboard" / "dist"
VIEWPORTS = [(820, 1180), (360, 780)]

INTERRUPT_MESSAGE = "멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다."
APPROVAL_MESSAGE = "연결하지 못해 보내지 못했습니다. 다시 눌러 주세요."

INTERRUPT_BUTTON = '[data-testid="chat-composer-interrupt-button"]'
INTERRUPT_ERROR = '[data-testid="chat-composer-interrupt-error"]'
APPROVAL_ERROR = '[data-testid="tool-approval-error"]'
DRAFT_INPUT = '[data-testid="chat-composer-text-input"]'
ROOT = '[data-testid="review-chat-ui-composer"]'
RAW_ERROR_TOKENS = ("HTTP", "Error", "ApiHttpError", "409", "503", "SESSION_NOT_RUNNING", "NODE_UNAVAILABLE")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(DIST_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}/assets/ios-components/index.html"


def build_url(base: str, failure: str) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["chatUiComposer"]
    query["failure"] = [failure]
    query["theme"] = ["light"]
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query, doseq=True), parts.fragment,
    ))


def run_routes(page: Page, base_netloc: str) -> None:
    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
        elif "/tool-approvals/" in request_url.path:
            route.fulfill(
                status=503,
                content_type="application/json",
                body=json.dumps({"error": {"code": "NODE_UNAVAILABLE"}}),
            )
        elif request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
        else:
            route.abort()

    page.context.route("**/*", route_request)


def settle(page: Page) -> None:
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(250)


def record(result: dict, check: str, label: str, passed: bool, detail: dict) -> None:
    result["checks"].append({"check": check, "label": label, "passed": passed, "detail": detail})
    if not passed:
        result["failures"].append({"check": check, "label": label, "detail": detail})


def text_of(page: Page, selector: str) -> str:
    locator = page.locator(selector)
    if locator.count() == 0:
        return ""
    return (locator.first.inner_text() or "").strip()



def active_element(page: Page) -> dict | None:
    return page.evaluate(
        "() => { const el = document.activeElement; if (!el) return null;"
        " return { tag: el.tagName, testId: el.getAttribute('data-testid'),"
        " role: el.getAttribute('role'), text: (el.textContent || '').trim().slice(0, 40) }; }"
    )


def element_metrics(page: Page, selector: str) -> dict | None:
    locator = page.locator(selector)
    if locator.count() == 0:
        return None
    element = locator.first
    metrics = element.evaluate(
        "el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,"
        " tabIndex: el.tabIndex, role: el.getAttribute('role'),"
        " text: (el.textContent || '').trim() })"
    )
    metrics["box"] = element.bounding_box()
    return metrics


def horizontal_overflow(page: Page) -> dict:
    return page.evaluate(
        "() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })"
    )


def inside(inner: dict | None, outer: dict | None) -> bool:
    if not inner or not outer:
        return False
    return (
        inner["x"] >= outer["x"] - 1
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + 1
    )


def measure_failure_state(page: Page, label: str, error_selector: str, pressed: dict | None,
                          result: dict, captures: list[str]) -> None:
    """§0-14~17: 포커스, 탭 정지, 넘침, 오류 자리와 원문 노출을 잰다."""
    focus = active_element(page)
    record(result, "포커스를 누른 조작에 남김", label,
           bool(focus) and focus.get("testId") == (pressed or {}).get("testId")
           and focus.get("text") == (pressed or {}).get("text"),
           {"active": focus, "pressed": pressed})

    error = element_metrics(page, error_selector)
    root_box = page.locator(ROOT).first.bounding_box()
    record(result, "오류 문구가 실패한 조작 자리에 남음", label, inside((error or {}).get("box"), root_box),
           {"errorBox": (error or {}).get("box"), "rootBox": root_box})
    record(result, "오류 문구는 탭 정지가 아님", label, bool(error) and error["tabIndex"] < 0,
           {"tabIndex": (error or {}).get("tabIndex"), "role": (error or {}).get("role")})
    record(result, "오류 문구가 잘리지 않고 줄바꿈됨", label,
           bool(error) and error["scrollWidth"] <= error["clientWidth"] + 1,
           {"scrollWidth": (error or {}).get("scrollWidth"), "clientWidth": (error or {}).get("clientWidth")})

    overflow = horizontal_overflow(page)
    record(result, "가로 넘침 없음", label, overflow["scrollWidth"] <= overflow["innerWidth"], overflow)

    text = ((error or {}).get("text") or "").strip()
    record(result, "원문 오류 문자열 없음", label, not any(token in text for token in RAW_ERROR_TOKENS),
           {"text": text})

    before_tab = active_element(page)
    page.keyboard.press("Tab")
    after_tab = active_element(page)
    record(result, "Tab이 다음 조작으로 이동", label, after_tab != before_tab,
           {"before": before_tab, "after": after_tab})
    result["states"][-1]["focusAfterFailure"] = focus
    result["states"][-1]["tabAfterFailure"] = after_tab
    result["states"][-1]["overflow"] = overflow


def resize_scene(page: Page, base: str, output: Path, result: dict) -> None:
    """§0-18: 넓게에서 실패를 띄운 뒤 좁게로 바꿔도 문구와 초안이 남는지 잰다."""
    label = "resize-820-360"
    page.set_viewport_size({"width": 820, "height": 1180})
    page.goto(build_url(base, "interrupt"), wait_until="networkidle")
    page.locator(ROOT).wait_for(state="visible")
    page.locator(INTERRUPT_BUTTON).wait_for(state="visible")
    draft = "초안 확인"
    page.locator(DRAFT_INPUT).first.fill(draft)
    page.locator(INTERRUPT_BUTTON).first.click()
    page.locator(INTERRUPT_ERROR).wait_for(state="visible")
    settle(page)

    narrow = {}
    for name, width, height in (("wide", 820, 1180), ("narrow", 360, 780), ("wide-again", 820, 1180)):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(250)
        message = text_of(page, INTERRUPT_ERROR)
        draft_value = page.locator(DRAFT_INPUT).first.input_value()
        overflow = horizontal_overflow(page)
        capture = f"app-resize-{name}.png"
        page.locator(ROOT).first.screenshot(path=str(output / capture))
        passed = message == INTERRUPT_MESSAGE and draft_value == draft and overflow["scrollWidth"] <= overflow["innerWidth"]
        record(result, "크기 변경 뒤 문구와 초안 유지", f"{label}-{name}", passed,
               {"message": message, "draft": draft_value, "overflow": overflow})
        narrow[name] = {"width": width, "message": message, "draft": draft_value, "capture": capture}
    result["states"].append({"scene": "resize", "captures": [row["capture"] for row in narrow.values()],
                             "steps": narrow})
    result["notApplicable"].append({"item": "§0-18 팝오버 위치", "scene": "resize",
                                    "reason": "이 동작은 팝오버를 열지 않는다"})

def interrupt_scene(page: Page, base: str, width: int, output: Path, result: dict) -> None:
    label = f"interrupt-{width}"
    page.goto(build_url(base, "interrupt"), wait_until="networkidle")
    page.locator('[data-testid="review-chat-ui-composer"]').wait_for(state="visible")
    page.locator(INTERRUPT_BUTTON).wait_for(state="visible")
    settle(page)
    root = page.locator('[data-testid="review-chat-ui-composer"]').first
    before = f"app-interrupt-before-{width}.png"
    root.screenshot(path=str(output / before))
    before_text = text_of(page, INTERRUPT_ERROR)

    page.locator(INTERRUPT_BUTTON).first.click()
    page.locator(INTERRUPT_ERROR).wait_for(state="visible")
    settle(page)
    after = f"app-interrupt-after-{width}.png"
    root.screenshot(path=str(output / after))
    message = text_of(page, INTERRUPT_ERROR)
    disabled = page.locator(INTERRUPT_BUTTON).first.get_attribute("aria-disabled")

    record(result, "멈춤 실패 문구 표시", label, message == INTERRUPT_MESSAGE,
           {"message": message, "expected": INTERRUPT_MESSAGE})
    record(result, "누르기 전에는 문구 없음", label, before_text == "", {"before": before_text})
    record(result, "실패 뒤 멈춤 버튼 다시 누를 수 있음", label, disabled != "true",
           {"ariaDisabled": disabled})
    result["states"].append({"scene": "interrupt", "width": width, "captures": [before, after],
                             "message": message, "ariaDisabled": disabled})
    pressed = page.locator(INTERRUPT_BUTTON).first.evaluate(
        "el => ({ testId: el.getAttribute('data-testid'), text: (el.textContent || '').trim().slice(0, 40) })"
    )
    measure_failure_state(page, label, INTERRUPT_ERROR, pressed, result, [before, after])


def approval_scene(page: Page, base: str, width: int, output: Path, result: dict) -> None:
    label = f"approval-{width}"
    page.goto(build_url(base, "approval"), wait_until="networkidle")
    widget = page.locator('[data-testid="review-chat-ui-tool-approval"]')
    widget.wait_for(state="visible")
    settle(page)
    root = page.locator('[data-testid="review-chat-ui-composer"]').first
    before = f"app-approval-before-{width}.png"
    root.screenshot(path=str(output / before))

    approve = widget.get_by_text("승인", exact=True).first
    approve.click()
    page.locator(APPROVAL_ERROR).wait_for(state="visible")
    settle(page)
    after = f"app-approval-after-{width}.png"
    root.screenshot(path=str(output / after))
    message = text_of(page, APPROVAL_ERROR)

    record(result, "도구 승인 실패 문구 표시", label, message == APPROVAL_MESSAGE,
           {"message": message, "expected": APPROVAL_MESSAGE})
    approve_buttons = widget.get_by_text("승인", exact=True).count()
    record(result, "실패 뒤 승인 버튼 남음", label, approve_buttons > 0,
           {"approveButtons": approve_buttons})
    result["states"].append({"scene": "approval", "width": width, "captures": [before, after],
                             "message": message})
    pressed = approve.evaluate("el => ({ tag: el.tagName, text: (el.textContent || '').trim() })")
    pressed_focus = {"testId": None, "text": pressed["text"]}
    measure_failure_state(page, label, APPROVAL_ERROR, pressed_focus, result, [before, after])


def main() -> int:
    parser = argparse.ArgumentParser(description="Action failure visual check")
    parser.add_argument("--out", required=True, help="directory for captures and metrics JSON")
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False,
        "states": [],
        "checks": [],
        "failures": [],
        "pageErrors": [],
        "consoleErrors": [],
        "notApplicable": [{"item": "§0-15 Esc", "scene": "interrupt",
                           "reason": "실패 표시는 대화상자를 열지 않는다"},
                          {"item": "§0-18 팝오버 위치", "scene": "approval",
                           "reason": "승인 카드는 팝오버가 아니다"}],
    }

    server, base = start_server()
    base_netloc = urllib.parse.urlsplit(base).netloc
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        color_scheme="light",
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.set_default_timeout(15000)
                    page.on("pageerror", lambda error, w=width: result["pageErrors"].append(f"{w}: {error}"))
                    page.on("console", lambda message, w=width: (
                        result["consoleErrors"].append(f"{w} console: {message.text}")
                        if message.type == "error" else None
                    ))
                    run_routes(page, base_netloc)
                    try:
                        interrupt_scene(page, base, width, output, result)
                        approval_scene(page, base, width, output, result)
                    finally:
                        context.close()
                resize_page = browser.new_context(
                    viewport={"width": 820, "height": 1180}, color_scheme="light", device_scale_factor=1,
                ).new_page()
                resize_page.set_default_timeout(15000)
                resize_page.on("pageerror", lambda error: result["pageErrors"].append(f"resize: {error}"))
                run_routes(resize_page, base_netloc)
                try:
                    resize_scene(resize_page, base, output, result)
                finally:
                    resize_page.context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()

    result["passed"] = not result["failures"] and not result["pageErrors"]
    metrics_path = output / "action-failure-metrics.json"
    metrics_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"action failure visual check: {'PASS' if result['passed'] else 'FAIL'}")
    print(f"metrics: {metrics_path}")
    print(f"checks: {len(result['checks'])}")
    if result["failures"]:
        print(f"failures: {json.dumps(result['failures'], ensure_ascii=False, indent=2)}")
    if result["pageErrors"]:
        print(f"page errors: {json.dumps(result['pageErrors'], ensure_ascii=False, indent=2)}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

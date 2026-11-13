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

  interrupt              before pressing 멈춤, and after the fake api rejects the
                         interrupt with HTTP 409 (SESSION_NOT_RUNNING)
  interrupt-unreachable  before pressing 멈춤, and after the fake api rejects the
                         interrupt with HTTP 503 (NODE_UNAVAILABLE). This scene
                         carries the longest stop message and checks by number
                         that the message box stays inside the composer box.
  approval-409           before pressing 승인, and after the real approve request
                         is answered with HTTP 409 (APPROVAL_ALREADY_RESOLVED)
  approval-503           before pressing 승인, and after the real approve request
                         is answered with HTTP 503 (NODE_UNAVAILABLE)
  input-request          before pressing the answer option, and after the real
                         respond request is answered with HTTP 422
                         (INPUT_REQUEST_ALREADY_RESPONDED)

The approve and respond requests leave the page through the settings store's
serverUrl, which ReviewChatUiComposer pins to the review origin after the
persisted settings finish rehydrating. Playwright routes answer them, so these
scenes exercise the real HTTP response path instead of a pre-request exception.

PASS judgments:
  - the failure text is visible after the action and matches the card #1316
    wording exactly
  - the 멈춤 button is enabled again right after the failure (aria-disabled is
    not true), so the reader can press it again
  - the approval and input request actions stay pressable after the failure
  - the longest stop message box stays inside the composer box left and right
    (numbers in the metrics), and its two lines keep a sane line height
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
INTERRUPT_UNREACHABLE_MESSAGE = "노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요."
APPROVAL_UNREACHABLE_MESSAGE = "연결하지 못해 보내지 못했습니다. 다시 눌러 주세요."
APPROVAL_ALREADY_HANDLED_MESSAGE = "이미 끝난 요청이라 보내지 못했습니다."
INPUT_REQUEST_ALREADY_HANDLED_MESSAGE = "이미 끝난 요청이라 보내지 못했습니다."

INTERRUPT_BUTTON = '[data-testid="chat-composer-interrupt-button"]'
INTERRUPT_ERROR = '[data-testid="chat-composer-interrupt-error"]'
APPROVAL_ERROR = '[data-testid="tool-approval-error"]'
INPUT_REQUEST_CARD = '[data-testid="input-request-card"]'
INPUT_REQUEST_OPTION = '[data-testid="input-request-option-0-0"]'
INPUT_REQUEST_ERROR = '[data-testid="input-request-error"]'
COMPOSER_BOX = '[data-testid="chat-composer-box"]'
DRAFT_INPUT = '[data-testid="chat-composer-text-input"]'
ROOT = '[data-testid="review-chat-ui-composer"]'
RAW_ERROR_TOKENS = ("HTTP", "Error", "ApiHttpError", "409", "422", "503", "SESSION_NOT_RUNNING", "NODE_UNAVAILABLE")


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


def run_routes(page: Page, base_netloc: str, state: dict) -> None:
    """표본별 응답 상태를 state에서 읽어 실제 HTTP 응답 경로를 만든다."""
    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
        elif "/tool-approvals/" in request_url.path:
            status = state.get("approval_status", 503)
            code = "APPROVAL_ALREADY_RESOLVED" if status == 409 else "NODE_UNAVAILABLE"
            route.fulfill(
                status=status,
                content_type="application/json",
                body=json.dumps({"error": {"code": code}}),
            )
        elif request_url.path.endswith("/respond"):
            status = state.get("input_status", 422)
            code = "INPUT_REQUEST_ALREADY_RESPONDED" if status == 422 else "NODE_UNAVAILABLE"
            route.fulfill(
                status=status,
                content_type="application/json",
                body=json.dumps({"error": {"code": code}}),
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


def text_extents(page: Page, selector: str) -> dict | None:
    """글자 줄 상자의 좌우 끝을 잰다(요소 상자는 폭을 다 차지하므로 글자 줄로 잰다)."""
    return page.evaluate(
        "sel => { const el = document.querySelector(sel); if (!el) return null;"
        " const range = document.createRange(); range.selectNodeContents(el);"
        " const rects = Array.from(range.getClientRects())"
        "   .filter(r => r.width > 0 && r.height > 0);"
        " if (!rects.length) return null;"
        " return { left: Math.min(...rects.map(r => r.left)),"
        "   right: Math.max(...rects.map(r => r.right)) }; }",
        selector,
    )


def check_error_edges(page: Page, label: str, error_selector: str, result: dict) -> None:
    """문구 상자의 좌우가 입력창(composer box) 좌우 안에 있는지 숫자로 검사한다."""
    extents = text_extents(page, error_selector)
    input_box = page.locator(COMPOSER_BOX).first.bounding_box()
    element_box = page.locator(error_selector).first.bounding_box()
    passed = bool(extents and input_box) and (
        extents["left"] >= input_box["x"] - 0.5
        and extents["right"] <= input_box["x"] + input_box["width"] + 0.5
    )
    record(result, "문구 상자가 입력창 좌우 안에 있음", label, passed,
           {"textExtents": extents, "errorBox": element_box, "inputBox": input_box})


def line_metrics(page: Page, selector: str) -> dict | None:
    return page.evaluate(
        "sel => { const el = document.querySelector(sel); if (!el) return null;"
        " const range = document.createRange(); range.selectNodeContents(el);"
        " const rects = Array.from(range.getClientRects())"
        "   .filter(r => r.width > 0 && r.height > 0);"
        " const style = getComputedStyle(el);"
        " return { lines: rects.length,"
        "   rects: rects.map(r => ({ top: Math.round(r.top * 100) / 100,"
        "     bottom: Math.round(r.bottom * 100) / 100 })),"
        "   fontSize: parseFloat(style.fontSize), lineHeight: style.lineHeight }; }",
        selector,
    )


def check_two_line_height(page: Page, label: str, error_selector: str, result: dict) -> None:
    """가장 긴 문구의 줄 높이를 검사한다.

    두 줄이면 줄마다 글자 높이 이상이고 겹치지 않는지, 한 줄이면 계산된 줄 간격이
    글자 높이 이상인지 본다. 폭에 따라 한 줄로 들어가면 두 줄 검사는 해당하지 않는다.
    """
    metrics = line_metrics(page, error_selector)
    rects = (metrics or {}).get("rects") or []
    rect_heights = [round(rect["bottom"] - rect["top"], 2) for rect in rects]
    fontSize = (metrics or {}).get("fontSize") or 0
    raw_line_height = (metrics or {}).get("lineHeight") or ""
    line_height = float(raw_line_height[:-2]) if raw_line_height.endswith("px") else 0.0
    ordered = all(
        rects[index]["top"] >= rects[index - 1]["top"]
        for index in range(1, len(rects))
    )
    if len(rects) >= 2:
        passed = ordered and all(height >= fontSize for height in rect_heights)
    else:
        passed = bool(metrics) and len(rects) == 1 and line_height >= fontSize
    record(result, "가장 긴 문구의 줄 높이", label, passed, {
        "lines": (metrics or {}).get("lines"),
        "lineHeights": rect_heights,
        "fontSize": fontSize,
        "lineHeight": raw_line_height,
        "twoLine": len(rects) >= 2,
    })


def measure_failure_state(page: Page, label: str, error_selector: str, pressed: dict | None,
                          result: dict, captures: list[str], check_focus: bool = True) -> None:
    """§0-14~17: 포커스, 탭 정지, 넘침, 오류 자리와 원문 노출을 잰다."""
    focus = active_element(page)
    if check_focus:
        record(result, "포커스를 누른 조작에 남김", label,
               bool(focus) and focus.get("testId") == (pressed or {}).get("testId")
               and focus.get("text") == (pressed or {}).get("text"),
               {"active": focus, "pressed": pressed})
    else:
        result["notApplicable"].append({
            "item": "§0-14 포커스 유지", "scene": label,
            "reason": "승인 카드는 보내는 동안 버튼을 처리 중 표시로 바꿨다가 실패하면 다시 그리므로"
                      " 누른 노드가 남지 않는다(기존 동작, 이번 범위 밖)",
        })

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


def interrupt_scene(page: Page, base: str, width: int, output: Path, result: dict, sample: str) -> None:
    expected = INTERRUPT_MESSAGE if sample == "interrupt" else INTERRUPT_UNREACHABLE_MESSAGE
    label = f"{sample}-{width}"
    page.goto(build_url(base, sample), wait_until="networkidle")
    page.locator(ROOT).wait_for(state="visible")
    page.locator(INTERRUPT_BUTTON).wait_for(state="visible")
    settle(page)
    root = page.locator(ROOT).first
    before = f"app-{sample}-before-{width}.png"
    root.screenshot(path=str(output / before))
    before_text = text_of(page, INTERRUPT_ERROR)

    page.locator(INTERRUPT_BUTTON).first.click()
    page.locator(INTERRUPT_ERROR).wait_for(state="visible")
    settle(page)
    after = f"app-{sample}-after-{width}.png"
    root.screenshot(path=str(output / after))
    message = text_of(page, INTERRUPT_ERROR)
    disabled = page.locator(INTERRUPT_BUTTON).first.get_attribute("aria-disabled")

    record(result, "멈춤 실패 문구 표시", label, message == expected,
           {"message": message, "expected": expected})
    record(result, "누르기 전에는 문구 없음", label, before_text == "", {"before": before_text})
    record(result, "실패 뒤 멈춤 버튼 다시 누를 수 있음", label, disabled != "true",
           {"ariaDisabled": disabled})
    result["states"].append({"scene": sample, "width": width, "captures": [before, after],
                             "message": message, "ariaDisabled": disabled})
    pressed = page.locator(INTERRUPT_BUTTON).first.evaluate(
        "el => ({ testId: el.getAttribute('data-testid'), text: (el.textContent || '').trim().slice(0, 40) })"
    )
    measure_failure_state(page, label, INTERRUPT_ERROR, pressed, result, [before, after])
    check_error_edges(page, label, INTERRUPT_ERROR, result)
    if sample == "interrupt-unreachable" and width == 360:
        # 가장 긴 문구가 좁은 폭에서 두 줄이 되므로 줄 높이까지 확인한다.
        check_two_line_height(page, label, INTERRUPT_ERROR, result)


def approval_scene(page: Page, base: str, width: int, output: Path, result: dict,
                   status: int, routes_state: dict) -> None:
    expected = (
        APPROVAL_ALREADY_HANDLED_MESSAGE if status == 409 else APPROVAL_UNREACHABLE_MESSAGE
    )
    label = f"approval-{status}-{width}"
    routes_state["approval_status"] = status
    page.goto(build_url(base, "approval"), wait_until="networkidle")
    widget = page.locator('[data-testid="review-chat-ui-tool-approval"]')
    widget.wait_for(state="visible")
    settle(page)
    root = page.locator(ROOT).first
    before = f"app-approval-{status}-before-{width}.png"
    root.screenshot(path=str(output / before))

    approve = widget.get_by_text("승인", exact=True).first
    approve.click()
    page.locator(APPROVAL_ERROR).wait_for(state="visible")
    settle(page)
    after = f"app-approval-{status}-after-{width}.png"
    root.screenshot(path=str(output / after))
    message = text_of(page, APPROVAL_ERROR)

    record(result, "도구 승인 실패 문구 표시", label, message == expected,
           {"message": message, "expected": expected, "status": status})
    approve_buttons = widget.get_by_text("승인", exact=True).count()
    record(result, "실패 뒤 승인 버튼 남음", label, approve_buttons > 0,
           {"approveButtons": approve_buttons})
    result["states"].append({"scene": f"approval-{status}", "width": width,
                             "captures": [before, after], "message": message})
    pressed = approve.evaluate("el => ({ tag: el.tagName, text: (el.textContent || '').trim() })")
    pressed_focus = {"testId": None, "text": pressed["text"]}
    measure_failure_state(page, label, APPROVAL_ERROR, pressed_focus, result, [before, after],
                          check_focus=False)


def input_request_scene(page: Page, base: str, width: int, output: Path, result: dict,
                        routes_state: dict) -> None:
    label = f"input-request-{width}"
    routes_state["input_status"] = 422
    page.goto(build_url(base, "input-request"), wait_until="networkidle")
    page.locator(INPUT_REQUEST_CARD).wait_for(state="visible")
    settle(page)
    root = page.locator(ROOT).first
    before = f"app-input-request-before-{width}.png"
    root.screenshot(path=str(output / before))
    before_text = text_of(page, INPUT_REQUEST_ERROR)

    page.locator(INPUT_REQUEST_OPTION).first.click()
    page.locator(INPUT_REQUEST_ERROR).wait_for(state="visible")
    settle(page)
    after = f"app-input-request-after-{width}.png"
    root.screenshot(path=str(output / after))
    message = text_of(page, INPUT_REQUEST_ERROR)
    disabled = page.locator(INPUT_REQUEST_OPTION).first.get_attribute("aria-disabled")

    record(result, "이미 끝난 입력 요청 문구 표시", label,
           message == INPUT_REQUEST_ALREADY_HANDLED_MESSAGE,
           {"message": message, "expected": INPUT_REQUEST_ALREADY_HANDLED_MESSAGE})
    record(result, "보내기 전에는 문구 없음", label, before_text == "", {"before": before_text})
    record(result, "실패 뒤 응답 선택지를 다시 누를 수 있음", label, disabled != "true",
           {"ariaDisabled": disabled})
    result["states"].append({"scene": "input-request", "width": width,
                             "captures": [before, after], "message": message,
                             "ariaDisabled": disabled})


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
                    routes_state: dict = {}
                    run_routes(page, base_netloc, routes_state)
                    try:
                        interrupt_scene(page, base, width, output, result, "interrupt")
                        interrupt_scene(page, base, width, output, result, "interrupt-unreachable")
                        approval_scene(page, base, width, output, result, 409, routes_state)
                        approval_scene(page, base, width, output, result, 503, routes_state)
                        input_request_scene(page, base, width, output, result, routes_state)
                    finally:
                        context.close()
                resize_page = browser.new_context(
                    viewport={"width": 820, "height": 1180}, color_scheme="light", device_scale_factor=1,
                ).new_page()
                resize_page.set_default_timeout(15000)
                resize_page.on("pageerror", lambda error: result["pageErrors"].append(f"resize: {error}"))
                run_routes(resize_page, base_netloc, {})
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

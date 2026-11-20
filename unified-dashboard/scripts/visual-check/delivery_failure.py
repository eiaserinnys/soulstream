#!/usr/bin/env python3
"""Capture the delivery-failure bubble samples in the web review page — card #1524.

Prepare a dashboard Vite server from the repo root:

    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

Run:

    python3 -P unified-dashboard/scripts/visual-check/delivery_failure.py \
        http://127.0.0.1:5173 .local/captures/web

The script opens /components?sample=delivery-failure at a wide (1440) and a
narrow (360) width and, per width:

  - requires the two failed bubbles to show 「전달을 확인하지 못했습니다」 with both buttons
  - requires the delivered bubble to stay free of the failure line and buttons
  - requires no horizontal overflow on the page or in the sample
  - writes out/web-chat-delivery-failure-{width}.png

Any failed check exits with a non-zero code and writes report.json next to the
captures.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

VIEWPORTS = [(1440, 1000), (360, 800)]

SAMPLE = '[data-testid="review-delivery-failure-samples"]'
FAILED_LONG = '[data-testid="review-sample-delivery-failure-long"]'
FAILED_QUESTION = '[data-testid="review-sample-delivery-failure-question"]'
DELIVERED = '[data-testid="review-sample-delivery-delivered"]'
FAILURE_TEXT = "전달을 확인하지 못했습니다"
RETRY_LABEL = "다시 보내기"
RESTORE_LABEL = "입력창으로"


NODES = [{
    "nodeId": "eiaserinnys",
    "host": "localhost",
    "port": 3105,
    "status": "connected",
    "capabilities": {},
    "connectedAt": 0,
    "sessionCount": 1,
}]
NODES_STREAM = "event: snapshot\ndata: " + json.dumps(NODES) + "\n\n"


def install_routes(page: Page) -> None:
    # 나머지 API를 먼저 빈 응답으로 끝내고, 구체 경로를 나중에 등록해 우선시킨다.
    # (Playwright는 나중에 등록한 route가 먼저 잡는다.)
    page.route('**/api/**', lambda route: route.fulfill(status=200, content_type='application/json', body='{}'))
    page.route('**/api/auth/config', lambda route: route.fulfill(
        json={'authEnabled': True, 'devModeEnabled': False}))
    page.route('**/api/health', lambda route: route.fulfill(
        json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'}))
    page.route('**/api/auth/status', lambda route: route.fulfill(
        json={'authenticated': True, 'user': {'email': 'review@example.invalid', 'name': '검수'}}))
    page.route('**/api/nodes', lambda route: route.fulfill(json={'nodes': NODES}))
    page.route('**/api/nodes/stream', lambda route: route.fulfill(
        status=200, content_type='text/event-stream', body=NODES_STREAM))
    page.route('**/api/nodes/*/agents', lambda route: route.fulfill(json={'agents': []}))
    page.route('**/api/folders', lambda route: route.fulfill(json={'folders': [], 'sessions': {}}))


def record(result: dict, check: str, width: int, passed: bool, detail: object) -> None:
    result["checks"].append({"check": check, "width": width, "passed": passed, "detail": detail})
    if not passed:
        result["failures"].append({"check": check, "width": width, "detail": detail})


def bubble_actions(page: Page, selector: str) -> dict:
    box = page.locator(selector).first
    return box.evaluate(
        "el => ({"
        " failureLines: el.querySelectorAll('[role=\"status\"]').length,"
        " text: el.innerText || '',"
        " buttons: Array.from(el.querySelectorAll('button')).map(button => button.innerText.trim())"
        "})"
    )


def run_width(page: Page, base: str, width: int, height: int, out_dir: Path, result: dict) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f'{base}/components?sample=delivery-failure', wait_until='load', timeout=30_000)
    sample = page.locator(SAMPLE).first
    sample.wait_for(state="visible", timeout=30_000)
    page.evaluate('document.fonts.ready')
    page.wait_for_timeout(250)

    boundary = page.locator('[role="dialog"]').filter(has_text='연결이 끊겼습니다').count()
    record(result, "연결 경계 덮개가 없음", width, boundary == 0, {"connectionDialog": boundary})

    long_bubble = bubble_actions(page, FAILED_LONG)
    question_bubble = bubble_actions(page, FAILED_QUESTION)
    delivered_bubble = bubble_actions(page, DELIVERED)

    record(result, "긴 문장 말풍선에 실패 줄이 있음", width, long_bubble["failureLines"] == 1, long_bubble)
    record(result, "??? 말풍선에 실패 줄이 있음", width, question_bubble["failureLines"] == 1, question_bubble)
    record(result, "실패 문구가 전달을 확인하지 못했습니다", width,
           FAILURE_TEXT in long_bubble["text"] and FAILURE_TEXT in question_bubble["text"],
           {"long": long_bubble["text"], "question": question_bubble["text"]})
    record(result, "두 실패 말풍선에 두 단추가 있음", width,
           RETRY_LABEL in long_bubble["buttons"] and RESTORE_LABEL in long_bubble["buttons"]
           and RETRY_LABEL in question_bubble["buttons"] and RESTORE_LABEL in question_bubble["buttons"],
           {"long": long_bubble["buttons"], "question": question_bubble["buttons"]})
    record(result, "전달된 말풍선에는 실패 표시가 없음", width,
           delivered_bubble["failureLines"] == 0 and delivered_bubble["buttons"] == []
           and FAILURE_TEXT not in delivered_bubble["text"],
           delivered_bubble)

    overflow = sample.evaluate(
        "el => ({width: el.clientWidth, scroll: el.scrollWidth,"
        " pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth})"
    )
    record(result, "표본에 가로 넘침이 없음", width,
           overflow["scroll"] <= overflow["width"] + 1 and overflow["pageScroll"] <= 1, overflow)

    box = sample.bounding_box()
    scroll = page.evaluate('() => ({x: window.scrollX, y: window.scrollY})')
    left = max(scroll['x'], box['x'] - 16)
    top = max(scroll['y'], box['y'] - 16)
    right = min(scroll['x'] + width, box['x'] + box['width'] + 16)
    bottom = min(scroll['y'] + height, box['y'] + box['height'] + 16)
    out_dir.mkdir(parents=True, exist_ok=True)
    capture = out_dir / f"web-chat-delivery-failure-{width}.png"
    page.screenshot(path=str(capture), animations="disabled",
                    clip={'x': left, 'y': top, 'width': right - left, 'height': bottom - top})
    result["captures"].append(str(capture))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('web', help='dashboard Vite base URL, e.g. http://127.0.0.1:5173')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    out_dir = args.output
    if not out_dir.is_absolute():
        out_dir = (Path.cwd() / out_dir).resolve()

    result: dict = {"checks": [], "failures": [], "captures": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page(device_scale_factor=1)
            install_routes(page)
            for width, height in VIEWPORTS:
                run_width(page, args.web, width, height, out_dir, result)
        finally:
            browser.close()

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    for failure in result["failures"]:
        print(f"FAIL {failure['width']}px · {failure['check']}: {json.dumps(failure['detail'], ensure_ascii=False)[:400]}")
    print(f"checks: {len(result['checks']) - len(result['failures'])}/{len(result['checks'])} passed")
    print("captures:", ", ".join(result["captures"]))
    return 0 if not result["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

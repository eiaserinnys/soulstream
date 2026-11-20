#!/usr/bin/env python3
"""Review chat delivery failure bubbles visual check (RN web component review bundle) — card #1524.

Launch method
-------------
1. Export the review bundle once from the repo root:
       npm --prefix soul-app run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Run this script with only the output directory:
       python3 soul-app/scripts/visual-check/review_chat_delivery_failure.py --out .local/captures/app

The script serves unified-dashboard/dist itself on an ephemeral local port and
never contacts a node. It opens the delivery-failure sample (?section=chat&sample=delivery-failure)
at a wide and a narrow (360) width and, per width:

  - requires the two failed bubbles to show 「전달을 확인하지 못했습니다」 with both buttons
  - requires the delivered bubble to stay free of the failure line and buttons
  - requires no horizontal overflow in the sample
  - writes out/app-chat-delivery-failure-{width}.png

Any failed check exits with a non-zero code and writes checks.json next to the
captures.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[3]
DIST_ROOT = REPO_ROOT / "unified-dashboard" / "dist"
VIEWPORTS = [(1440, 1000), (360, 800)]

SAMPLE = '[data-testid="review-delivery-failure-samples"]'
FAILED_LONG = '[data-testid="review-delivery-failure-long"]'
FAILED_QUESTION = '[data-testid="review-delivery-failure-question"]'
DELIVERED = '[data-testid="review-delivery-delivered"]'
FAILURE_LINE = '[data-testid="pending-message-failure"]'
FAILURE_TEXT = "전달을 확인하지 못했습니다"
RETRY_LABEL = "다시 보내기"
RESTORE_LABEL = "입력창으로"


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


def build_url(base: str) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["chat"]
    query["sample"] = ["delivery-failure"]
    query["theme"] = ["light"]
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query, doseq=True), parts.fragment,
    ))


def install_routes(page: Page, base_netloc: str) -> None:
    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
            return
        if request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
            return
        route.abort()

    page.context.route("**/*", route_request)


def record(result: dict, check: str, width: int, passed: bool, detail: object) -> None:
    result["checks"].append({"check": check, "width": width, "passed": passed, "detail": detail})
    if not passed:
        result["failures"].append({"check": check, "width": width, "detail": detail})


def bubble_actions(page: Page, selector: str) -> dict:
    box = page.locator(selector).first
    return box.evaluate(
        "el => ({"
        " failureLines: el.querySelectorAll('[data-testid=\"pending-message-failure\"]').length,"
        " text: el.innerText || '',"
        " retry: el.querySelectorAll('[data-testid=\"pending-message-retry\"]').length,"
        " restore: el.querySelectorAll('[data-testid=\"pending-message-restore\"]').length"
        "})"
    )


def run_width(page: Page, base_url: str, width: int, height: int, out_dir: Path, result: dict) -> None:
    install_routes(page, urllib.parse.urlsplit(base_url).netloc)
    page.set_viewport_size({"width": width, "height": height})
    page.goto(build_url(base_url))
    sample = page.locator(SAMPLE).first
    sample.wait_for(state="visible", timeout=30_000)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(250)

    long_bubble = bubble_actions(page, FAILED_LONG)
    question_bubble = bubble_actions(page, FAILED_QUESTION)
    delivered_bubble = bubble_actions(page, DELIVERED)

    record(result, "긴 문장 말풍선에 실패 줄이 있음", width, long_bubble["failureLines"] == 1, long_bubble)
    record(result, "??? 말풍선에 실패 줄이 있음", width, question_bubble["failureLines"] == 1, question_bubble)
    record(result, "실패 문구가 전달을 확인하지 못했습니다", width,
           FAILURE_TEXT in long_bubble["text"] and FAILURE_TEXT in question_bubble["text"],
           {"long": long_bubble["text"], "question": question_bubble["text"]})
    record(result, "두 실패 말풍선에 두 단추가 있음", width,
           long_bubble["retry"] == 1 and long_bubble["restore"] == 1
           and question_bubble["retry"] == 1 and question_bubble["restore"] == 1,
           {"long": long_bubble, "question": question_bubble})
    record(result, "전달된 말풍선에는 실패 표시가 없음", width,
           delivered_bubble["failureLines"] == 0 and delivered_bubble["retry"] == 0
           and delivered_bubble["restore"] == 0 and FAILURE_TEXT not in delivered_bubble["text"],
           delivered_bubble)
    record(result, "단추 글자가 다시 보내기·입력창으로", width,
           RETRY_LABEL in long_bubble["text"] and RESTORE_LABEL in long_bubble["text"],
           long_bubble["text"])

    overflow = sample.evaluate(
        "el => ({width: el.clientWidth, scroll: el.scrollWidth,"
        " pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth})"
    )
    record(result, "표본에 가로 넘침이 없음", width,
           overflow["scroll"] <= overflow["width"] + 1 and overflow["pageScroll"] <= 1, overflow)

    out_dir.mkdir(parents=True, exist_ok=True)
    capture = out_dir / f"app-chat-delivery-failure-{width}.png"
    sample.screenshot(path=str(capture), animations="disabled")
    result["captures"].append(str(capture))

    page.unroute_all(behavior="ignoreErrors")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="capture output directory")
    args = parser.parse_args()
    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = (Path.cwd() / out_dir).resolve()

    result: dict = {"checks": [], "failures": [], "captures": []}
    server, url = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                page = browser.new_page()
                for width, height in VIEWPORTS:
                    run_width(page, url, width, height, out_dir, result)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    for failure in result["failures"]:
        print(f"FAIL {failure['width']}px · {failure['check']}: {json.dumps(failure['detail'], ensure_ascii=False)[:400]}")
    print(f"checks: {len(result['checks']) - len(result['failures'])}/{len(result['checks'])} passed")
    print("captures:", ", ".join(result["captures"]))
    return 0 if not result["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

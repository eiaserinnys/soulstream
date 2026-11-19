#!/usr/bin/env python3
"""Review chat attachment preview visual check (RN web component review bundle) — card #1714.

Launch method
-------------
1. Export the review bundle once from the repo root:
       npm --prefix soul-app run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Run this script with only the output directory:
       python3 soul-app/scripts/visual-check/review_chat_attachments.py --out .local/card1714/app

The script serves unified-dashboard/dist itself on an ephemeral local port and
never contacts a node. It opens the chat review page (?section=chat) at a wide
and a narrow width and, per width:

  - scrolls the default conversation sample to the attachment message and waits
    for the projected attachment preview (message-attachments-images)
  - requires the preview picture to be a bundled raster asset that actually
    loads (Image().naturalWidth > 0), not an /api/attachments URL
  - requires no 「불러오지 못함」/「찾을 수 없음」 text anywhere on the page
  - requires zero requests to /api/sessions/*/events/*/attachments and
    /api/attachments/*, and zero requests to another origin
  - writes out/app-chat-attachments-{width}.png

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
VIEWPORTS = [(1440, 1000), (390, 844)]

COLUMN = '[data-testid="review-persistent-column-default"]'
ATTACHMENT_IMAGE = '[data-testid="message-attachments-images"]'
ATTACHMENT_MESSAGE_TEXT = "세로와 가로 원본 세 장입니다."
FAILURE_TEXTS = ("불러오지 못함", "찾을 수 없음")


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
    query["theme"] = ["light"]
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query, doseq=True), parts.fragment,
    ))


def install_routes(page: Page, base_netloc: str, state: dict) -> None:
    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        path = request_url.path
        if path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
            return
        if path.startswith("/api/sessions/") and path.endswith("/attachments"):
            state["attachmentRequests"].append(route.request.url)
        elif path.startswith("/api/attachments"):
            state["attachmentRequests"].append(route.request.url)
        if request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
            return
        state["otherOriginRequests"].append(route.request.url)
        route.abort()

    page.context.route("**/*", route_request)


def record(result: dict, check: str, width: int, passed: bool, detail: object) -> None:
    result["checks"].append({"check": check, "width": width, "passed": passed, "detail": detail})
    if not passed:
        result["failures"].append({"check": check, "width": width, "detail": detail})


def scroll_to_attachment_message(page: Page) -> bool:
    column = page.locator(COLUMN).first
    column.wait_for(state="visible", timeout=30_000)
    message = column.get_by_text(ATTACHMENT_MESSAGE_TEXT, exact=False).first
    if message.count() == 0:
        return False
    message.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    return True


def attachment_preview_sources(page: Page) -> dict:
    """첨부 미리보기 상자 안에서 그려진 그림 URL과 렌더 크기를 모은다."""
    return page.evaluate(
        "sel => { const root = document.querySelector(sel);"
        " if (!root) return { found: false, sources: [] };"
        " const sources = [];"
        " for (const el of [root, ...root.querySelectorAll('*')]) {"
        "   const style = getComputedStyle(el);"
        "   const bg = style.backgroundImage || '';"
        "   const match = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);"
        "   const url = match ? match[1] : (el.tagName === 'IMG' ? (el.currentSrc || el.src) : null);"
        "   if (!url) continue;"
        "   const rect = el.getBoundingClientRect();"
        "   sources.push({ url, width: Math.round(rect.width), height: Math.round(rect.height),"
        "     tag: el.tagName, apiUrl: url.includes('/api/attachments') });"
        " }"
        " return { found: true, sources }; }",
        ATTACHMENT_IMAGE,
    )


def decode_sources(page: Page, sources: list[dict]) -> list[dict]:
    """같은 URL을 실제로 받아 디코드되는지 확인한다(naturalWidth > 0)."""
    return page.evaluate(
        "urls => Promise.all(urls.map(url => new Promise(resolve => {"
        "  const image = new Image();"
        "  image.onload = () => resolve({ url, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });"
        "  image.onerror = () => resolve({ url, naturalWidth: 0, naturalHeight: 0 });"
        "  image.src = url;"
        " })))",
        [source["url"] for source in sources],
    )


def run_width(page: Page, base_url: str, width: int, height: int, out_dir: Path, result: dict) -> None:
    state = {"attachmentRequests": [], "otherOriginRequests": []}
    install_routes(page, urllib.parse.urlsplit(base_url).netloc, state)
    page.set_viewport_size({"width": width, "height": height})
    page.goto(build_url(base_url))
    page.wait_for_timeout(500)
    page.evaluate("document.fonts.ready")

    reached = scroll_to_attachment_message(page)
    record(result, "대화 표본에서 첨부 메시지를 찾음", width, reached, {"text": ATTACHMENT_MESSAGE_TEXT})
    page.wait_for_timeout(500)

    preview = attachment_preview_sources(page)
    sources = preview["sources"]
    record(result, "첨부 미리보기 상자가 있음", width, preview["found"], {"found": preview["found"]})
    asset_sources = [source for source in sources if not source["apiUrl"]]
    record(result, "첨부 미리보기가 번들 그림을 가리킴", width, len(asset_sources) > 0,
           {"sources": sources, "assetSources": asset_sources})
    record(result, "첨부 미리보기가 첨부 API URL을 가리키지 않음", width,
           all(not source["apiUrl"] for source in sources), {"sources": sources})

    decoded = decode_sources(page, asset_sources) if asset_sources else []
    loaded = [entry for entry in decoded if entry["naturalWidth"] > 0 and entry["naturalHeight"] > 0]
    record(result, "첨부 미리보기 그림이 실제로 로드됨", width, len(loaded) > 0,
           {"decoded": decoded, "loaded": loaded})

    body_text = page.evaluate("() => document.body.innerText || ''")
    found_failure = [text for text in FAILURE_TEXTS if text in body_text]
    record(result, "첨부 실패 문구가 없음", width, not found_failure, {"found": found_failure})

    record(result, "첨부 API 요청 0건", width, len(state["attachmentRequests"]) == 0,
           {"requests": state["attachmentRequests"]})
    record(result, "다른 출처 요청 0건", width, len(state["otherOriginRequests"]) == 0,
           {"requests": state["otherOriginRequests"]})

    out_dir.mkdir(parents=True, exist_ok=True)
    capture = out_dir / f"app-chat-attachments-{width}.png"
    column = page.locator(COLUMN).first
    # 그림이 늦게 붙으면 목록이 아래로 따라가므로, 캡처 직전에 첨부 메시지로 다시 맞춘다.
    scroll_to_attachment_message(page)
    page.wait_for_timeout(300)
    if column.count() > 0:
        column.screenshot(path=str(capture), animations="disabled")
    else:
        page.screenshot(path=str(capture), animations="disabled", full_page=True)
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

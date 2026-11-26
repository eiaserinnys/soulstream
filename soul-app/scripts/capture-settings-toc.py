#!/usr/bin/env python3
"""앱 설정 화면의 목차(묶음과 칸 순서)를 넓은 화면과 좁은 화면에서 찍고 단언한다(카드 #1883).

검수 번들(`node soul-app/scripts/export-components.mjs`가 만드는 ios-components)을 이전 코드와 이번 코드로 각각
내보낸 두 폴더를 받는다. 번들은 운영과 같은 SettingsModal을 열고 통신만 공개 fixture로 바꾼 것이다.
실행: python3 soul-app/scripts/capture-settings-toc.py --before <이전 번들> --after <이번 번들> --output <캡처 폴더>
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

PREFIX = "/assets/ios-components/"
WIDE = {"width": 1024, "height": 1180}
NARROW = {"width": 390, "height": 1000}
EXPECTED_GROUPS = ["개인 환경", "세션과 작업", "에이전트와 노드", "기록과 관리"]
EXPECTED_CATEGORIES = [
    ["display", "owned-agents", "connection"],
    ["persistent", "recurring-jobs"],
    ["backends"],
    ["usage-stats", "review-policy", "diagnostics"],
]
READ_TOC = """() => {
  const sidebar = document.querySelector('[data-testid="settings-category-sidebar"]');
  const rows = [...sidebar.querySelectorAll('[data-testid^="settings-category-"]')].map(el => el.getAttribute('data-testid').replace('settings-category-', ''));
  return { text: sidebar.innerText, rows, sw: sidebar.scrollWidth, cw: sidebar.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth };
}"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/auth/status":
            body = json.dumps({"authenticated": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        if not path.startswith(PREFIX):
            self.send_response(404)
            self.end_headers()
            return
        self.path = "/" + path[len(PREFIX):]
        return super().do_GET()

    def log_message(self, format, *args):
        pass


def serve(directory: Path):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def capture(browser, base: str, out: Path, prefix: str, results: dict, assert_new: bool):
    for label, viewport in (("wide", WIDE), ("narrow", NARROW)):
        context = browser.new_context(viewport=viewport, locale="ko-KR", reduced_motion="reduce")
        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
        page = context.new_page()
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
        page.goto(f"{base}{PREFIX}index.html?section=nativeSettings&entry=modal")
        expect(page.get_by_test_id("settings-modal-header")).to_be_visible(timeout=20000)
        expect(page.get_by_test_id("settings-category-sidebar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(1500)
        toc = page.evaluate(READ_TOC)
        results[f"{prefix}{label}"] = toc
        if assert_new:
            groups = [line for line in toc["text"].split("\n") if line in EXPECTED_GROUPS + ["관리와 문제 해결", "작업과 실행"]]
            assert groups == EXPECTED_GROUPS, (label, groups)
            visible = [row for rows in EXPECTED_CATEGORIES for row in rows if row in toc["rows"]]
            assert toc["rows"] == visible, (label, toc["rows"])
            assert toc["sw"] <= toc["cw"] and toc["doc"] <= toc["inner"], (label, toc)
        page.screenshot(path=str(out / f"{prefix}app-settings-{label}.png"))
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    before_server, before_base = serve(Path(args.before))
    after_server, after_base = serve(Path(args.after))
    results: dict = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            capture(browser, before_base, out, "baseline-", results, assert_new=False)
            capture(browser, after_base, out, "", results, assert_new=True)
            browser.close()
    finally:
        before_server.shutdown()
        after_server.shutdown()
    (out / "app-settings-toc.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("app settings toc ok")


if __name__ == "__main__":
    main()

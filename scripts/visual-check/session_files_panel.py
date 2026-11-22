#!/usr/bin/env python3
"""Capture the real card workspace with intercepted workspace responses."""
from __future__ import annotations
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "unified-dashboard" / "dist"
FILE = dict(orig_path=None, added=None, deleted=None, size=24, wrote=False, read=False, committed=False, last_activity_at=None)
DATA = {
    "session_id": "components-session", "root": "/workspace/card1789", "node": {"id": "eiaserinnys", "status": "ok"},
    "snapshot": {"state": "ready", "observed_at": "2026-11-22T15:12:00Z", "refreshing": False, "branch": "card1789-files-dashboard", "head": "abc", "upstream": "origin/main", "ahead": 1, "behind": 0, "truncated": False},
    "attribution": "partial", "files": [
        {**FILE, "path": "soul-server-ts/src/config.ts", "git_status": "modified", "added": 3, "deleted": 1},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox_types.ts", "git_status": None, "committed": True, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox.ts", "git_status": "modified", "added": 42, "deleted": 18, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/outbox_retry.ts", "git_status": "untracked", "added": 33, "deleted": 0, "wrote": True},
    ], "read_only": [{"path": "soul-server-ts/src/upstream/dispatcher.ts", "size": None, "last_read_at": None}],
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path == "/components": self.path = "/index.html"
        return super().do_GET()
    def log_message(self, format, *args): pass

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--output", required=True); args = parser.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(DIST)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    measurements = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for width, scene in [(1440, "ready"), (390, "ready"), (1440, "loading"), (1440, "offline"), (1440, "error"), (360, "long"), (390, "light")]:
                theme = "light" if scene == "light" else "dark"
                context = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=theme, reduced_motion="reduce")
                page = context.new_page()
                requests = {"workspace": 0}
                page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
                def route_handler(route):
                    path = urlsplit(route.request.url).path
                    if path == "/api/health": return route.fulfill(json={"healthy": True, "ready": True, "draining": False, "build_id": "dev"})
                    if path == "/api/auth/status": return route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True}})
                    if path == "/api/auth/config": return route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
                    if path.endswith("/workspace/file"):
                        raw = b"// session file preview\n"
                        return route.fulfill(status=206, body=raw, headers={"Content-Type": "text/plain", "Content-Range": f"bytes 0-{len(raw)-1}/{len(raw)}", "Content-Length": str(len(raw))})
                    if path.endswith("/workspace"):
                        requests["workspace"] += 1
                        if scene == "error" and requests["workspace"] == 1: return route.fulfill(status=503, json={"error": "unavailable"})
                        data = json.loads(json.dumps(DATA, ensure_ascii=False))
                        if scene == "loading": data["snapshot"]["state"] = "pending"
                        if scene == "offline": data["node"]["status"] = "offline"
                        if scene == "long": data["files"][0]["path"] = "매우-긴-폴더-이름/아주-긴-파일-이름을-좁은-화면에서-읽기-위한-이름-123456789.ts"
                        return route.fulfill(json=data)
                    return route.continue_()
                page.route("**/api/**", route_handler)
                page.goto(base + "/components", wait_until="domcontentloaded")
                sample = page.get_by_test_id("card-board-sample")
                sample.locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click()
                workspace = page.get_by_test_id("v3-card-workspace")
                expect(workspace.get_by_test_id("card-detail")).to_be_visible()
                if width < 760: page.get_by_test_id("v3-mobile-tab-chat").click()
                trigger = workspace.get_by_role("button", name="파일", exact=True)
                expect(trigger).to_be_visible(timeout=15000)
                chat = workspace.get_by_test_id("v3-card-session-chat")
                before = chat.bounding_box()
                if width == 1440 and scene == "ready": chat.locator('.v3-chat-content').screenshot(path=str(out / "unchanged-before.png"), animations="disabled")
                trigger.click()
                pane = workspace.get_by_role("region", name="세션 파일")
                expect(pane).to_be_visible()
                if scene == "loading": expect(pane.get_by_text("파일 상태를 읽는 중")).to_be_visible()
                elif scene == "offline": expect(pane.get_by_text("노드 끊김", exact=False)).to_be_visible()
                elif scene == "error": expect(pane.get_by_role("button", name="다시 시도")).to_be_visible()
                else:
                    expect(pane.get_by_text("outbox_retry.ts")).to_be_visible()
                    expect(pane.locator('[data-activity="commit"]')).to_have_count(1)
                page.evaluate("document.fonts.ready")
                name = {"loading":"loading.png", "offline":"offline.png", "error":"error.png", "long":"long-names.png", "light":"light-panel.png"}.get(scene, "wide-panel.png" if width == 1440 else "narrow-panel.png")
                page.screenshot(path=str(out / name), animations="disabled")
                box = pane.bounding_box(); after = chat.bounding_box()
                info = page.evaluate("""() => { const pane = document.querySelector('[data-testid="v3-card-workspace"] .v3-session-files-pane'); const h = pane.querySelector('.v3-chat-header'); const b = pane.getBoundingClientRect(), r = h.getBoundingClientRect(); const names = [...pane.querySelectorAll('.v3-session-files-name')].map(e => {const x=e.getBoundingClientRect();return {left:x.left,right:x.right,width:x.width,scroll:e.scrollWidth,client:e.clientWidth,ellipsis:getComputedStyle(e).textOverflow}}); return {pane: {left:b.left,right:b.right,top:b.top,bottom:b.bottom}, header:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}, names, scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth, active:document.activeElement?.getAttribute('aria-label')}; }""")
                assert info["scrollWidth"] <= info["clientWidth"], info
                assert abs(info["pane"]["left"] - info["header"]["left"]) <= 1 and abs(info["pane"]["top"] - info["header"]["top"]) <= 1, info
                for name_box in info["names"]:
                    assert name_box["width"] >= 32 and name_box["left"] >= info["pane"]["left"] and name_box["right"] <= info["pane"]["right"]
                    assert name_box["scroll"] <= name_box["client"] or name_box["ellipsis"] == "ellipsis"
                if width == 1440 and scene == "ready":
                    assert abs(before["width"] - after["width"]) <= 1
                    chat.locator('.v3-chat-content').screenshot(path=str(out / "unchanged-after.png"), animations="disabled")
                    info["unchanged_equal"] = (out / "unchanged-before.png").read_bytes() == (out / "unchanged-after.png").read_bytes()
                    assert info["unchanged_equal"]
                    assert info["active"] == "다시 읽기"
                    page.keyboard.press("Tab")
                    assert page.evaluate("document.activeElement?.getAttribute('aria-label')") == "파일 닫기"
                    info["tab"] = "다시 읽기 → 파일 닫기"
                    pane.get_by_text("outbox_retry.ts").click()
                    expect(page.get_by_role("dialog")).to_be_visible()
                    page.screenshot(path=str(out / "wide-preview.png"), animations="disabled")
                    page.keyboard.press("Escape"); expect(page.get_by_role("dialog")).to_have_count(0)
                    info["preview_focus"] = page.evaluate("document.activeElement?.textContent")
                    page.keyboard.press("Escape"); expect(pane).to_have_count(0)
                    expect(trigger).to_be_focused()
                    info["close_focus"] = page.evaluate("document.activeElement?.textContent")
                    assert info["close_focus"] == "파일"
                if scene == "error":
                    pane.get_by_role("button", name="다시 시도").click()
                    expect(pane.get_by_text("outbox_retry.ts")).to_be_visible()
                    info["retry"] = "recovered"
                if width == 390 and scene == "ready":
                    page.set_viewport_size({"width": 1440, "height": 900})
                    expect(pane).to_be_visible()
                    page.set_viewport_size({"width": 390, "height": 900})
                    expect(pane).to_be_visible()
                    info["resize"] = "panel retained"
                measurements[f"{scene}-{width}"] = info
                context.close()
            browser.close()
    finally:
        server.shutdown(); server.server_close()
        (out / "measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__": main()

#!/usr/bin/env python3
"""Exercise localized session surfaces against browser-intercepted API fixtures."""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import re
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_files_panel import install_routes
from settings_i18n import ROOT
from settings_toolbar_fakes import Fake, NODE, SUMMARY

LOCALES = ROOT / "packages/i18n/src/locales"
SESSION = "components-session"


PARENT = {"id": "parent-folder", "name": "Release operations", "sortOrder": 0,
          "parentFolderId": None, "projectPageId": "parent-page", "status": "open",
          "archived": False, "version": 1, "settings": {}}
FOLDER = {**PARENT, "id": "demo-folder", "name": "Release preparation",
          "parentFolderId": PARENT["id"], "projectPageId": "demo-page"}
PROJECT = {"id": "demo-page", "title": FOLDER["name"], "version": 1, "metadata": {}}
PARENT_PROJECT = {**PROJECT, "id": "parent-page", "title": PARENT["name"]}
GUIDANCE = {"demo-page": "Check the release checklist.", "parent-page": "Record packaging results."}
RUN = {**SUMMARY, "displayName": "Check release notes and session history",
       "agentName": "Release assistant", "folderId": FOLDER["id"]}
REVIEW = {**SUMMARY, "agentSessionId": "review-session", "displayName": "Review packaging results",
          "agentName": "Release assistant", "status": "completed",
          "reviewRequired": True, "reviewState": "needs_review"}
STREAMS = {
    "/api/sessions/stream": ("session_list", {"type": "session_list", "sessions": [RUN, REVIEW], "total": 2}),
    "/api/nodes/stream": ("snapshot", [NODE]),
    "/api/sessions/review-session/events": ("history_sync", {
        "type": "history_sync", "last_event_id": 0, "is_live": True, "status": "completed",
    }),
}


class DashboardServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in STREAMS:
            name, payload = STREAMS[path]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                self.wfile.write(f"event: {name}\ndata: {json.dumps(payload)}\n\n".encode())
                while not self.server.stopped.wait(1):
                    self.wfile.write(b": keepalive\n\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path.startswith(("/persistent", "/oauth/consent")):
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, *_args):
        pass


def capture(page, out, name):
    page.screenshot(path=out / name, timeout=60000)


class DashboardFixture(Fake):
    reject_context = False

    def handle(self, route):
        url = urlsplit(route.request.url)
        path = url.path
        if path in STREAMS:
            return route.continue_()
        if path == "/api/folders":
            return route.fulfill(json={"folders": [PARENT, FOLDER], "sessions": {
                RUN["agentSessionId"]: {"folderId": FOLDER["id"], "displayName": RUN["displayName"]},
            }})
        if path == "/api/folders/demo-folder":
            return route.fulfill(json={"folder": FOLDER, "cards": []})
        if path == "/api/planner/today":
            return route.fulfill(json={"attention": [], "running": [], "queued": [],
                                       "reviewSessionIds": [REVIEW["agentSessionId"]]})
        if path == "/api/planner/starred-folders":
            return route.fulfill(json={"items": [], "nextCursor": None})
        if path == "/api/planner/folders/demo-folder":
            return route.fulfill(json={"folder": FOLDER, "page": PROJECT, "blocks": [], "sections": [], "cards": [],
                                       "subfolders": {"items": [], "nextCursor": None},
                                       "sessions": {"items": [RUN], "nextCursor": None}})
        if path in ("/api/pages/demo-page", "/api/pages/parent-page"):
            if self.reject_context:
                return route.fulfill(status=503, json={"error": "Context unavailable"})
            project = PROJECT if path.endswith("/demo-page") else PARENT_PROJECT
            page_id = project["id"]
            block = {"id": f"{page_id}-guidance", "page_id": page_id, "parent_id": None,
                     "position_key": "a", "block_type": "guidance", "text": GUIDANCE[page_id],
                     "properties": {"enabled": True}, "collapsed": False}
            return route.fulfill(json={"page": project, "blocks": [block], "sections": []})
        if path == "/api/pages/demo-page/session-defaults":
            return route.fulfill(body="null", content_type="application/json")
        if path == "/api/cards":
            return route.fulfill(json={"cards": []})
        if path == "/api/board-items":
            return route.fulfill(json={"boardItems": []})
        if path == "/api/sessions":
            if route.request.method == "POST":
                return route.fulfill(status=422, json={"error": {"message": "The fixture rejected this session."}})
            rows = [REVIEW] if "review" in url.query else [RUN, REVIEW]
            return route.fulfill(json={"sessions": rows, "total": len(rows)})
        if path.endswith("/resume-after-limit"):
            return route.fulfill(json={"eligible": False, "reason": "No usage limit is active.", "schedule": None})
        if path == "/api/sessions/review-session/review/acknowledge":
            return route.fulfill(status=409, json={"error": {
                "code": "REVIEW_STATE_CHANGED", "message": "Review state changed",
            }})
        return super().handle(route)


def copy_for(language, area):
    return json.loads((LOCALES / language / f"{area}.json").read_text())


def new_page(browser, language, width, scene="ready"):
    context = browser.new_context(
        locale=language, viewport={"width": width, "height": 900},
        color_scheme="dark" if language == "ko" else "light",
        reduced_motion="reduce", service_workers="block",
    )
    page = context.new_page()
    page.set_default_timeout(30000)
    page.add_init_script("localStorage.setItem('ls.webglGlass', '0');")
    page.add_init_script(f"localStorage.setItem('soul-language', '{language}');")
    page.add_init_script("""localStorage.setItem('soulstream-pas-device:qa@example.test',
        JSON.stringify({openOnStart: false, showWeeklyUsage: false}));""")
    calls = {"workspace": 0}
    install_routes(page, "ready" if scene == "error" else scene, calls)
    page.route("**/api/user/preferences", lambda route: route.fulfill(json={
        "email": "qa@example.test", "preferences": {"language": language},
        "hasBackground": False, "backgroundUrl": None, "updatedAt": None,
    }))
    return context, page, calls


def focus(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      return {tag: el.tagName, role: el.getAttribute('role'),
        name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80),
        hidden: !el.getClientRects().length || Boolean(el.closest('[aria-hidden=true]'))};
    }""")


def geometry(locator):
    return locator.evaluate("""panel => {
      const bounds = panel.getBoundingClientRect();
      const actions = [...panel.querySelectorAll('button,[role=menuitem]')].filter(el => el.getClientRects().length)
        .map(el => ({label: el.getAttribute('aria-label') || el.textContent.trim(), box: el.getBoundingClientRect()}))
        .filter(({box}) => box.top >= bounds.top && box.bottom <= bounds.bottom);
      return {
        width: innerWidth, document: document.documentElement.scrollWidth,
        viewportOverflow: bounds.left < -1 || bounds.right > innerWidth + 1,
        outside: actions.filter(({box}) => box.left < bounds.left - 1 || box.right > bounds.right + 1)
          .map(({label}) => label),
        collapsed: actions.filter(({box}) => box.width < 16).map(({label}) => label),
      };
    }""")


def dashboard(browser, base, out, language, width):
    context, page, _ = new_page(browser, language, width)
    fixture = DashboardFixture()
    page.route("**/api/**", fixture.handle)
    # The account preference should still take precedence over the browser locale.
    page.route("**/api/user/preferences", lambda route: route.fulfill(json={
        "email": "qa@example.test", "preferences": {"language": language},
        "hasBackground": False, "backgroundUrl": None, "updatedAt": None,
    }))
    copy = copy_for(language, "sessions")
    ui = copy_for(language, "ui")
    try:
        page.goto(base, wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=60000)
        if width == 360:
            page.get_by_test_id("v3-mobile-tab-projects").click()
            page.get_by_role("button", name=FOLDER["name"], exact=False).first.click()
            row = page.locator(f'.v3-runs [data-session-id="{SESSION}"]')
        else:
            panel = page.get_by_test_id("v3-session-panel")
            expect(page.get_by_role("navigation", name=copy["plannerNavigation"])).to_be_visible()
            expect(page.get_by_role("button", name=copy["openSessionSearch"])).to_be_visible()
            row = panel.locator(f'[data-session-id="{SESSION}"]')
        status = copy["sessionStatus"].replace("{{status}}", ui["session"]["status"]["running"])
        expect(row.get_by_text(status, exact=True)).to_be_visible(timeout=30000)
        if width == 360:
            row.evaluate("row => row.scrollIntoView({block: 'center'})")
            expect(row).to_be_in_viewport(ratio=0.95)
        capture(page, out, f"{language}-dashboard-sessions-{width}.png")
        if language != "en" or width != 1440:
            return {"geometry": geometry(row)}

        trigger = row.get_by_role("button").first
        trigger.focus()
        trigger.click(button="right")
        menu = page.get_by_role("menu")
        continuation = menu.get_by_role("menuitem", name=ui["session"]["continue"], exact=True)
        expect(continuation).to_be_visible()
        expect(menu.get_by_text("No usage limit is active.", exact=True)).to_be_visible()
        observations = {"menu_open": focus(page), "menu_geometry": geometry(menu)}
        capture(page, out, "en-dashboard-session-menu-1440.png")
        page.set_viewport_size({"width": 1200, "height": 900})
        expect(continuation).to_be_visible()
        observations["menu_resized"] = geometry(menu)
        page.set_viewport_size({"width": 1440, "height": 900})
        page.keyboard.press("ArrowDown")
        observations["menu_arrow"] = focus(page)
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(trigger).to_be_focused()
        observations["menu_escape"] = focus(page)

        trigger.focus()
        trigger.click(button="right")
        continuation.press("Enter")
        dialog = page.get_by_role("dialog", name=copy["newSession"], exact=True)
        instruction = dialog.get_by_role("textbox", name=copy["initialInstruction"], exact=True)
        expect(instruction).to_be_visible()
        observations["succession_open"] = focus(page)
        observations["succession_geometry"] = geometry(dialog)
        materials = dialog.locator("summary").filter(has_text=copy["sharedMaterials"])
        materials.click()
        for label in (
            f'{GUIDANCE["demo-page"]} · This folder',
            f'{GUIDANCE["parent-page"]} · Inherited from {PARENT["name"]}',
        ):
            expect(dialog.get_by_text(label, exact=True)).to_be_visible()
        capture(page, out, "en-dashboard-succession-1440.png")
        instruction.focus()
        page.keyboard.press("Tab")
        observations["succession_tab"] = focus(page)
        instruction.fill("Verify the release checklist.")
        page.set_viewport_size({"width": 360, "height": 900})
        expect(instruction).to_have_value("Verify the release checklist.")
        observations["succession_narrow"] = geometry(dialog)
        page.set_viewport_size({"width": 1440, "height": 900})
        dialog.get_by_role("button", name=copy["startSession"], exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text(copy["startFailed"])
        expect(instruction).to_have_value("Verify the release checklist.")
        capture(page, out, "en-dashboard-succession-error-1440.png")
        instruction.clear()
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(trigger).to_be_focused()
        observations["succession_escape"] = focus(page)

        fixture.reject_context = True
        trigger.click(button="right")
        continuation.click()
        continuation_error = page.get_by_role("dialog", name=ui["session"]["continueErrorTitle"])
        expect(continuation_error.get_by_text(ui["session"]["continueErrorHelp"])).to_be_visible()
        page.keyboard.press("Escape")
        expect(continuation_error).to_have_count(0)
        fixture.reject_context = False

        review_row = panel.locator(f'[data-session-id="{REVIEW["agentSessionId"]}"]')
        review_row.get_by_role("button", name=copy["acknowledgeSession"].replace(
            "{{title}}", REVIEW["displayName"]), exact=True).click()
        expect(panel.get_by_role("alert")).to_have_text(copy["reviewChangedRefresh"])
        capture(page, out, "en-dashboard-review-error-1440.png")

        review_row.locator(".v3-run-open").click()
        banner = page.locator(".v3-review-banner")
        expect(banner.get_by_text(copy["reviewPrompt"])).to_be_visible()
        capture(page, out, "en-dashboard-review-banner-1440.png")
        return observations
    finally:
        context.close()


def files(browser, base, out, language, width, scene):
    context, page, calls = new_page(browser, language, width, scene)
    copy = copy_for(language, "sessions")
    try:
        reject_workspace = scene == "error"
        if reject_workspace:
            page.route(f"**/api/sessions/{SESSION}/workspace", lambda route:
                route.fulfill(status=503, json={"error": "unavailable"})
                if reject_workspace else route.fallback())
        page.goto(f"{base}/persistent/{SESSION}", wait_until="domcontentloaded")
        trigger = page.get_by_role("button", name=re.compile(
            rf"^(?:{re.escape(copy['sessionFiles'])}|세션 파일)$",
        ))
        expect(trigger).to_be_visible(timeout=30000)
        trigger.click()
        pane = page.get_by_role("region", name=copy["sessionFiles"], exact=True)
        expect(pane).to_be_visible()
        observations = {"pane_open": focus(page)}
        if scene == "error":
            alert = pane.get_by_role("alert").filter(has_text=copy["filesLoadFailed"])
            expect(alert).to_be_visible()
            capture(page, out, f"{language}-files-error-{width}.png")
            reject_workspace = False
            alert.get_by_role("button", name=copy["retry"]).click()
        row = pane.get_by_role("button", name="event_outbox.ts")
        expect(row).to_be_visible()
        row.click()
        region = pane.get_by_role("region", name=copy["diffTitle"].replace("{{name}}", "event_outbox.ts"), exact=True)
        if scene == "diff-loading":
            expect(region.get_by_label(copy["diffLoading"])).to_be_visible()
            capture(page, out, f"{language}-diff-loading-{width}.png")
            calls["pending_diff"].fulfill(json={
                "path": "soul-server-ts/src/upstream/event_outbox.ts", "status": "modified",
                "text": "@@ -1,1 +1,1 @@\n-before\n+after", "truncated": False, "binary": False,
            })
        expect(region.get_by_role("button", name=copy["viewFull"])).to_be_visible()
        expect(region.locator('[data-kind="add"]').first).to_be_visible()
        assert "sessions." not in pane.inner_text()
        capture(page, out, f"{language}-file-diff-{scene}-{width}.png")
        observations["geometry"] = geometry(pane)
        row.focus()
        page.keyboard.press("Tab")
        observations["after_tab"] = focus(page)
        page.set_viewport_size({"width": 1440 if width == 360 else 360, "height": 900})
        expect(region).to_be_visible()
        observations["resized_geometry"] = geometry(pane)
        pane.get_by_role("button", name=copy["closeFiles"]).focus()
        page.keyboard.press("Escape")
        expect(pane).to_have_count(0)
        observations["after_escape"] = focus(page)
        return observations
    finally:
        context.close()


def oauth(browser, base, out, language):
    context, page, _ = new_page(browser, language, 1440)
    copy = copy_for(language, "sessions")
    try:
        page.route("**/api/oauth/interaction/demo", lambda route: route.fulfill(json={
            "email": "qa@example.test", "clientName": "Project review client",
            "permissions": "Read session summaries", "csrf": "fixture-csrf",
        }))
        page.goto(f"{base}/oauth/consent?interaction=demo", wait_until="domcontentloaded")
        expect(page.get_by_role("button", name=copy["allow"], exact=True)).to_be_visible(timeout=30000)
        capture(page, out, f"{language}-oauth-consent-1440.png")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dashboard-only", action="store_true")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    dist = ROOT / "unified-dashboard/dist"
    if not (dist / "index.html").is_file():
        parser.error("Build unified-dashboard before capturing the session screens.")
    server = DashboardServer(("127.0.0.1", 0), functools.partial(DashboardHandler, directory=str(dist)))
    server.stopped = threading.Event()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for language, width in [("en", 1440), ("en", 360), ("ko", 1440)]:
                results = dashboard(browser, base, out, language, width)
                (out / f"dashboard-{language}-{width}.json").write_text(
                    json.dumps(results, ensure_ascii=False, indent=2) + "\n")
            if not args.dashboard_only:
                for language in ("ko", "en"):
                    oauth(browser, base, out, language)
                results = {}
                for language, width, scene in [
                    ("ko", 1440, "ready"), ("en", 1440, "ready"), ("en", 360, "ready"),
                    ("en", 1440, "diff-loading"), ("en", 1440, "error"),
                ]:
                    results[f"{language}-{width}-{scene}"] = files(browser, base, out, language, width, scene)
                (out / "operations.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    finally:
        server.stopped.set()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()

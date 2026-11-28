#!/usr/bin/env python3
"""Exercise localized session surfaces against browser-intercepted API fixtures."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_files_panel import install_routes
from settings_i18n import ROOT, capture, start_vite
from settings_toolbar_fakes import SUMMARY

LOCALES = ROOT / "packages/i18n/src/locales"
SESSION = "components-session"
FONT = "fonts/pretendard/1.3.9/PretendardVariable.woff2"
SESSION_ROUTES = re.compile(
    r"/api/(?:health|auth/(?:status|config)|nodes(?:/stream)?|persistent-sessions(?:/[^/]+)?"
    r"|sessions(?:/stream|/[^/]+/(?:timeline|events|story|workspace(?:/[^/]+)?))?)$",
)


def copy_for(language, area):
    return json.loads((LOCALES / language / f"{area}.json").read_text())


def new_page(browser, language, width, scene="ready"):
    context = browser.new_context(
        locale=language, viewport={"width": width, "height": 900},
        color_scheme="dark" if language == "ko" else "light",
        reduced_motion="reduce", service_workers="block",
    )
    page = context.new_page()
    page.set_default_timeout(12000)
    page.add_init_script(f"localStorage.setItem('soul-language', '{language}');")
    page.add_init_script("""localStorage.setItem('soulstream-pas-device:qa@example.test',
        JSON.stringify({openOnStart: false, showWeeklyUsage: false}));""")
    page.add_init_script("""{
        const request = window.fetch.bind(window);
        window.fetch = (input, options) => {
            const url = new URL(input instanceof Request ? input.url : input, location.href);
            if (url.origin === location.origin && url.pathname === '/api/health') {
                return Promise.resolve(Response.json({healthy: true, ready: true, draining: false, build_id: 'dev'}));
            }
            return request(input, options);
        };
    }""")
    calls = {"workspace": 0}
    install_routes(page, "ready" if scene == "error" else scene, calls)
    page.route("**/api/**", lambda route:
        route.fallback() if SESSION_ROUTES.fullmatch(urlsplit(route.request.url).path)
        else route.fulfill(status=404, json={"error": "fixture route not provided"}))
    page.route(f"**/{FONT}", lambda route: route.fulfill(
        path=ROOT / "unified-dashboard/public" / FONT, content_type="font/woff2",
    ))
    page.route(re.compile(r"/api/cards(?:\?.*)?$"), lambda route: route.fulfill(json={"cards": []}))
    page.route("**/api/folders", lambda route: route.fulfill(json={"folders": [], "sessions": {}}))
    page.route("**/api/planner/today", lambda route: route.fulfill(json={
        "attention": [], "running": [], "queued": [], "reviewSessionIds": [SESSION],
    }))
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={
        "items": [], "nextCursor": None,
    }))
    page.route("**/api/user/preferences", lambda route: route.fulfill(json={
        "email": "qa@example.test", "preferences": {"language": language},
        "hasBackground": False, "backgroundUrl": None, "updatedAt": None,
    }))
    return context, page, calls


def focus(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      return {tag: el.tagName, name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80),
        hidden: !el.getClientRects().length || Boolean(el.closest('[aria-hidden=true]'))};
    }""")


def geometry(locator):
    return locator.evaluate("""panel => {
      const bounds = panel.getBoundingClientRect();
      const actions = [...panel.querySelectorAll('button')].filter(el => el.getClientRects().length)
        .map(el => ({label: el.getAttribute('aria-label') || el.textContent.trim(), box: el.getBoundingClientRect()}))
        .filter(({box}) => box.top >= bounds.top && box.bottom <= bounds.bottom);
      return {
        width: innerWidth, document: document.documentElement.scrollWidth,
        outside: actions.filter(({box}) => box.left < bounds.left - 1 || box.right > bounds.right + 1)
          .map(({label}) => label),
        collapsed: actions.filter(({box}) => box.width < 16).map(({label}) => label),
      };
    }""")


def dashboard(browser, base, out, language):
    context, page, _ = new_page(browser, language, 1440)
    copy = copy_for(language, "sessions")
    try:
        review = {**SUMMARY, "status": "completed", "reviewRequired": True, "reviewState": "needs_review"}
        page.route(re.compile(r"/api/sessions(?:\?.*)?$"), lambda route: route.fulfill(json={
            "sessions": [review], "total": 1,
        }))
        page.route("**/api/sessions/stream**", lambda route: route.fulfill(
            content_type="text/event-stream",
            body=f"event: session_list\ndata: {json.dumps({'type': 'session_list', 'sessions': [review], 'total': 1})}\n\n",
        ))
        page.goto(base, wait_until="domcontentloaded")
        toolbar = page.get_by_test_id("v3-global-toolbar")
        expect(toolbar.get_by_role("button", name=copy["openSessionSearch"])).to_be_visible(timeout=30000)
        panel = page.get_by_role("complementary", name=copy["session"])
        expect(panel.get_by_role("heading", name=copy["running"], exact=True)).to_be_visible()
        capture(page, out, f"{language}-session-list-1440.png")
        page.goto(f"{base}/?session={SESSION}", wait_until="domcontentloaded")
        header = page.get_by_test_id("v3-standalone-session-chat").locator(".v3-chat-header")
        expect(header.get_by_role("button", name=copy["closeChat"])).to_be_visible(timeout=20000)
        status = copy_for(language, "ui")["session"]["status"]["turnEnded"]
        expect(header.locator(".v3-chat-status")).to_have_text(status)
        expect(page.get_by_role("button", name=copy["acknowledgeReview"], exact=True)).to_be_visible()
        capture(page, out, f"{language}-session-chat-1440.png")
        header.click(button="right", force=True)
        continue_label = copy_for(language, "ui")["session"]["continue"]
        continue_action = page.get_by_text(continue_label, exact=True)
        expect(continue_action).to_be_visible()
        capture(page, out, f"{language}-session-menu-1440.png")
        continue_action.click()
        dialog = page.get_by_role("dialog", name=copy["newSession"])
        expect(dialog.get_by_role("textbox", name=copy["initialInstruction"])).to_be_visible()
        capture(page, out, f"{language}-succession-1440.png")
        opened = focus(page)
        page.keyboard.press("Tab")
        tabbed = focus(page)
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        closed = focus(page)
        return {"succession_open": opened, "succession_tab": tabbed, "succession_close": closed}
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
    out = parser.parse_args().out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    server, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            results = {}
            failures = []
            for language in ("ko", "en"):
                try:
                    results[language] = dashboard(browser, base, out, language)
                except Exception as error:
                    error.add_note(f"dashboard, {language}")
                    failures.append(error)
                try:
                    oauth(browser, base, out, language)
                except Exception as error:
                    error.add_note(f"OAuth consent, {language}")
                    failures.append(error)
            for language, width, scene in [
                ("ko", 1440, "ready"), ("en", 1440, "ready"), ("en", 360, "ready"),
                ("en", 1440, "diff-loading"), ("en", 1440, "error"),
            ]:
                name = f"{language}-{width}-{scene}"
                try:
                    results[name] = files(browser, base, out, language, width, scene)
                except Exception as error:
                    error.add_note(name)
                    failures.append(error)
            (out / "operations.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
            if failures:
                raise ExceptionGroup("Session visual checks failed", failures)
    finally:
        server.terminate()
        server.wait(timeout=20)


if __name__ == "__main__":
    main()

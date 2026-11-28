#!/usr/bin/env python3
"""Exercise localized session surfaces against browser-intercepted API fixtures."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_files_panel import install_routes
from settings_i18n import ROOT, capture, start_vite

LOCALES = ROOT / "packages/i18n/src/locales"
SESSION = "components-session"


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
            for language in ("ko", "en"):
                oauth(browser, base, out, language)
            for language, width, scene in [
                ("ko", 1440, "ready"), ("en", 1440, "ready"), ("en", 360, "ready"),
                ("en", 1440, "diff-loading"), ("en", 1440, "error"),
            ]:
                results[f"{language}-{width}-{scene}"] = files(browser, base, out, language, width, scene)
            (out / "operations.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    finally:
        server.terminate()
        server.wait(timeout=20)


if __name__ == "__main__":
    main()

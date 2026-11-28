#!/usr/bin/env python3
"""Capture and exercise the web admin translations against fixture API responses."""
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import DIALOG, ROOT, LocaleFake, capture, page_for, start_vite
from settings_toolbar_fakes import open_settings

DATE = "2026-10-18T12:00:00+09:00"
TABS = ("usage_stats", "usage_log", "users", "file_storage")
USER_EMAIL = "long-dashboard-account-name-for-visual-verification@example.test"
FOLDER = {"id": "folder-a", "name": "Quarterly release planning and infrastructure maintenance"}
SEARCH_TITLE = "Quarterly release readiness"
DETAIL = ".config-detail"


def usage_fixtures():
    script = """
      import * as imported from '../packages/soul-ui/src/lib/usage-stats-fixtures.ts';
      const {buildUsageStatsOverview, buildUsageStatsDayDetail, USAGE_STATS_FIXTURE_ANCHOR} = imported.default ?? imported;
      const anchor = USAGE_STATS_FIXTURE_ANCHOR;
      const overviews = Object.fromEntries(['week', 'month', 'all'].map(period =>
        [period, buildUsageStatsOverview({period, anchor, timezone: 'Asia/Seoul'})]));
      const days = Object.fromEntries([...new Set(overviews.week.series.map(point => point.bucket_start))].map(
        date => [date, buildUsageStatsDayDetail(date, {})]));
      process.stdout.write(JSON.stringify({overviews, days}));
    """
    return json.loads(subprocess.check_output(
        ["node", "--import", "tsx", "--input-type=module", "-e", script],
        cwd=ROOT / "unified-dashboard", timeout=20,
    ))


class AdminFake(LocaleFake):
    def __init__(self, language, fixtures):
        super().__init__()
        self.preferences["language"] = language
        self.fixtures = fixtures
        self.stats = "ready"
        self.health = True
        self.held = []

    def handle(self, route):
        url = urlsplit(route.request.url)
        path = url.path
        if path == "/api/health" and not self.health:
            return route.fulfill(status=503, json={})
        if path == "/api/planner/today":
            return route.fulfill(json={"attention": [], "running": [], "queued": [], "reviewSessionIds": []})
        if path == "/api/folders":
            return route.fulfill(json={"folders": []})
        if path == "/api/session-statistics":
            if self.stats == "loading":
                self.held.append(route)
                return
            if self.stats == "error":
                return route.fulfill(status=503, json={})
            period = dict(item.split("=", 1) for item in url.query.split("&"))["period"]
            return route.fulfill(json=self.fixtures["overviews"][period])
        if path.startswith("/api/session-statistics/days/"):
            return route.fulfill(json=self.fixtures["days"][path.rsplit("/", 1)[-1]])
        if path == "/api/ui-events":
            return route.fulfill(json={"events": [{
                "eventId": "event-1", "occurredAt": DATE, "type": "view_open",
                "clientKind": "browser", "target": None, "entry": "toolbar", "attrs": {},
            }]})
        if path == "/api/ui-events/installs":
            return route.fulfill(json={"installs": [{"installId": "browser-001", "clientKind": "browser", "eventCount": 42}]})
        if path == "/api/admin/users":
            return route.fulfill(json={"users": [
                {"email": USER_EMAIL, "displayName": "Dashboard Administrator", "isAdmin": True, "allowedFolderIds": []},
                {"email": "operator@example.test", "displayName": "Release Operator", "isAdmin": False, "allowedFolderIds": [FOLDER["id"]]},
            ], "folders": [FOLDER]})
        if path.endswith("-r2"):
            return route.fulfill(json={"endpoint": "https://example.test/r2", "bucket": "private-files",
                                       "accessKeyId": "fixture-access-id", "secretAccessKeyConfigured": True, "version": 1})
        if path == "/cogito/search":
            return route.fulfill(json={"session_results": [{
                "session_id": "release-planning", "title": SEARCH_TITLE, "excerpt": "Review rollout, access and incident response.",
                "updated_at": DATE, "task_title": FOLDER["name"], "best_match": {"event_id": None, "match_source": "session_id"},
                "evidence": [], "session_url": "/sessions/release-planning",
            }]})
        return super().handle(route)


def choose(page, settings, tab):
    popup = page.locator(DIALOG)
    back = popup.get_by_role("button", name=settings["allSettings"], exact=True)
    if back.is_visible():
        back.click()
    label = settings["tabs"][tab]["label"]
    popup.get_by_role("navigation").get_by_role("button", name=label, exact=True).click()
    expect(page.locator(f"{DETAIL} h2")).to_have_text(label)


def active(page):
    return page.evaluate("""() => {
      const node = document.activeElement;
      return node?.getAttribute('aria-label') || node?.getAttribute('placeholder') ||
        node?.getAttribute('data-testid') || node?.title || node?.labels?.[0]?.innerText ||
        (node?.matches('[data-slot="dialog-popup"]') ? 'DIALOG' : null) || (node === document.body ? 'BODY' : node?.textContent?.trim().slice(0, 90))
        || node?.tagName;
    }""")


def geometry(surface):
    return surface.evaluate("""panel => {
      const bounds = panel.getBoundingClientRect();
      const visible = node => !node.closest('[aria-hidden="true"]') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const name = node => node.getAttribute('aria-label') || node.title || node.innerText?.trim().slice(0, 65) || node.tagName;
      const outside = [...panel.querySelectorAll('button,input,select')].filter(visible).filter(node => {
        const box = node.getBoundingClientRect();
        const scroller = node.closest('[data-testid="user-management-table-scroll"]');
        return !scroller && (box.width < 8 || box.left < bounds.left - 1 || box.right > bounds.right + 1);
      }).map(name);
      const clipped = [...panel.querySelectorAll('h2,h3,p,span,button,label')].filter(visible).filter(node =>
        !node.children.length && node.textContent.trim() && node.clientWidth &&
        node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).textOverflow !== 'ellipsis').map(name);
      const dateLines = [...panel.querySelectorAll('time,.usage-stats-period-label,.usage-stats-summary-metric strong')].filter(visible).map(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return {text: name(node), lines: range.getClientRects().length};
      });
      const picker = panel.querySelector('.usage-stats-chart-heading [role="combobox"]')?.getBoundingClientRect();
      const buttons = [...panel.querySelectorAll('.usage-stats-chart-heading-controls button')].map(node => node.getBoundingClientRect());
      const overlap = picker ? buttons.some(box => box.left < picker.right && box.right > picker.left &&
        box.top < picker.bottom && box.bottom > picker.top) : false;
      return {viewport: innerWidth, document: document.documentElement.scrollWidth, overlap,
        panel: panel.clientWidth, scroll: panel.scrollWidth, outside, clipped, dateLines};
    }""")


def capture_surface(page, surface, out, name, observations):
    expect(surface).to_be_visible()
    assert "admin." not in surface.inner_text(), name
    page.evaluate("() => document.fonts.ready")
    capture(page, out, name + ".png")
    observations[name] = geometry(surface)


def run_view(browser, base, out, language, width, fixtures, observations):
    dictionaries = ROOT / "packages/i18n/src/locales" / language
    copy = json.loads((dictionaries / "admin.json").read_text())
    settings = json.loads((dictionaries / "settings.json").read_text())
    fake = AdminFake(language, fixtures)
    context, page, _ = page_for(browser, base, width, language, fake)
    page.clock.set_fixed_time(datetime.fromisoformat(DATE))
    prefix = f"{language}-{width}"
    popup = page.locator(DIALOG)
    detail = page.locator(DETAIL)
    ops = {}
    try:
        open_settings(page)
        ops["settings_open"] = active(page)
        ops["settings_close_button"] = popup.locator('[data-slot="dialog-close"], button').filter(
            has=page.locator("svg.lucide-x")).first.get_attribute("aria-label")
        popup.get_by_role("navigation").get_by_role("button", name=settings["tabs"]["file_storage"]["label"], exact=True).scroll_into_view_if_needed()
        capture_surface(page, popup, out, f"{prefix}-settings", observations)
        for tab in TABS:
            choose(page, settings, tab)
            if tab == "usage_stats":
                expect(detail.locator(".usage-stats-stack-segment").first).to_be_visible()
                expect(detail.locator(".usage-stats-share-row").first).to_be_visible()
                expect(detail.get_by_text(copy["stats"]["allModels"], exact=True)).to_be_visible()
                assert ("Oct" if language == "en" else "10월") in detail.locator(".usage-stats-period-label").inner_text()
                capture_surface(page, detail, out, f"{prefix}-stats-overview", observations)
                detail.locator(".usage-stats-chart-heading").evaluate("(heading) => heading.scrollIntoView({block: 'start'})")
                expect(detail.locator(".usage-stats-stack-segment").first).to_be_in_viewport()
                expect(detail.locator(".usage-stats-share-row").first).to_be_in_viewport()
            elif tab == "usage_log":
                expect(detail.get_by_text(copy["log"]["view_open"], exact=True)).to_be_visible()
            elif tab == "users":
                expect(detail.get_by_text(USER_EMAIL, exact=True)).to_be_visible()
            else:
                expect(detail.get_by_role("textbox", name="Endpoint").first).to_have_value("https://example.test/r2")
                expect(detail.get_by_role("button", name=copy["storage"]["check"], exact=True).first).to_be_visible()
            capture_surface(page, detail, out, f"{prefix}-{tab.replace('_', '-')}", observations)

        secret = detail.get_by_role("button", name=copy["config"]["show"], exact=True).first
        secret.click()
        expect(detail.get_by_role("button", name=copy["config"]["hide"], exact=True).first).to_be_visible()
        ops["secret_focus"] = active(page)

        choose(page, settings, "users")
        add = detail.get_by_role("button", name=copy["users"]["add"], exact=True)
        add.focus()
        page.keyboard.press("Enter")
        editor = page.get_by_role("dialog", name=copy["users"]["create"], exact=True)
        expect(editor).to_be_visible()
        ops["editor_open"] = active(page)
        page.keyboard.press("Tab")
        ops["editor_tab"] = active(page)
        page.keyboard.press("Escape")
        expect(editor).to_have_count(0)
        ops["editor_return"] = active(page)

        fake.stats = "loading"
        choose(page, settings, "usage_stats")
        expect(detail.get_by_role("status", name=copy["stats"]["loading"])).to_be_visible()
        capture_surface(page, detail, out, f"{prefix}-loading", observations)
        fake.stats = "error"
        for route in fake.held:
            route.fulfill(status=503, json={})
        fake.held.clear()
        expect(detail.get_by_text(copy["stats"]["loadError"])).to_be_visible()
        capture_surface(page, detail, out, f"{prefix}-error", observations)
        fake.stats = "ready"
        detail.get_by_role("button", name=copy["stats"]["retry"], exact=True).click()
        expect(detail.locator(".usage-stats-stack-segment").first).to_be_visible()
        ops["retry_focus"] = active(page)

        page.keyboard.press("Escape")
        expect(popup).to_have_count(0)
        ops["settings_return"] = active(page)
        search_trigger = page.locator(".dashboard-toolbar-search")
        if width <= 760:
            page.keyboard.press("Control+k")
        else:
            search_trigger.click()
        search = page.get_by_role("dialog", name=copy["search"]["title"])
        query = search.get_by_placeholder(copy["search"]["placeholder"])
        expect(query).to_be_focused()
        ops["search_open"] = active(page)
        page.keyboard.press("Tab")
        ops["search_tab"] = active(page)
        query.fill(SEARCH_TITLE)
        expect(search.get_by_text(SEARCH_TITLE, exact=True)).to_be_visible()
        capture_surface(page, search, out, f"{prefix}-search", observations)
        if language == "en" and width == 1440:
            page.set_viewport_size({"width": 360, "height": 800})
            expect(query).to_have_value(SEARCH_TITLE)
            expect(search.get_by_text(SEARCH_TITLE, exact=True)).to_be_visible()
            ops["resize"] = geometry(search)
            page.set_viewport_size({"width": width, "height": 900})
        page.keyboard.press("Escape")
        expect(search).to_have_count(0)
        ops["search_return"] = active(page)

        page.evaluate("""async () => {
          const { createDashboardReloadCoordinator } = await import('/client/pwa/dashboard-reload.ts');
          const coordinator = createDashboardReloadCoordinator({document, reload() {}, hasPendingEdits: () => true,
            flushPendingEdits: async () => document.querySelector("[data-sw-update-action]").dataset.retryReady === "true"});
          await coordinator.request(undefined, false);
        }""")
        banner = page.locator("[data-sw-update-banner]")
        expect(banner.get_by_text(copy["pwa"]["reviewDraft"], exact=True)).to_be_visible()
        capture_surface(page, banner, out, f"{prefix}-pwa", observations)
        banner.get_by_role("button", name=copy["pwa"]["apply"], exact=True).focus()
        page.keyboard.press("Enter")
        expect(banner.get_by_role("button", name=copy["pwa"]["retry"], exact=True)).to_be_visible()
        ops["pwa_retry"] = active(page)
        banner.locator("[data-sw-update-action]").evaluate("(button) => { button.dataset.retryReady = 'true'; }")
        banner.get_by_role("button", name=copy["pwa"]["retry"], exact=True).click()
        expect(banner).to_have_count(0)

        fake.health = False
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        connection = page.get_by_role("dialog", name=copy["connection"]["disconnectedTitle"].replace("\n", " "))
        expect(connection).to_be_visible()
        ops["connection_open"] = active(page)
        page.keyboard.press("Tab")
        ops["connection_tab"] = active(page)
        page.keyboard.press("Escape")
        expect(connection).to_be_visible()
        capture_surface(page, connection, out, f"{prefix}-connection", observations)
        fake.health = True
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        try:
            expect(popup).to_have_count(0, timeout=8000)
        except AssertionError:
            ops["connection_recovery"] = popup.inner_text()
        ops["connection_return"] = active(page)

    finally:
        observations[prefix + "-operations"] = ops
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    fixtures = usage_fixtures()
    observations = {}
    server, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for language, width in (("ko", 1440), ("en", 1440), ("en", 360)):
                print(f"Capture {language} {width}", flush=True)
                run_view(browser, base, args.output, language, width, fixtures, observations)
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=20)
        (args.output / "observations.json").write_text(json.dumps(observations, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

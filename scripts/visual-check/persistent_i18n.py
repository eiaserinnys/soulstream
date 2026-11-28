#!/usr/bin/env python3
"""Capture the persistent session route with localized UI and fixture API responses."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from time import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import ROOT, LocaleFake, capture, page_for, start_vite
from settings_toolbar_fakes import CREATE_DEFAULTS, PAS, SESSION_ID

FIXTURE_MODULE = "/client/v3/pas-report-thread/pas-report-thread-fixtures.ts"
DIALOG = '[data-testid="pas-report-thread-dialog"]'


class PersistentFake(LocaleFake):
    def __init__(self, locale):
        super().__init__()
        self.preferences["language"] = locale
        self.list_state = "ready"
        self.held_listing = []
        self.fixture = {"entries": [], "list": [], "details": {}}

    def handle(self, route):
        path = urlsplit(route.request.url).path
        session = {**PAS, "persistent_report": self.fixture["entries"], "display_name": "Project briefing"}
        if path.startswith("/api/agent-portraits/"):
            return route.fulfill(status=302, headers={"Location": "/icon-192.png"})
        if path == "/api/persistent-sessions":
            if self.list_state == "loading":
                self.held_listing.append(route)
                return
            if self.list_state == "error":
                return route.fulfill(status=503, json={})
            sessions = [] if self.list_state == "empty" else [session]
            return route.fulfill(json={"sessions": sessions, "total": len(sessions), "create_defaults": CREATE_DEFAULTS})
        if path == f"/api/persistent-sessions/{SESSION_ID}":
            return route.fulfill(json={"session": session})
        if path == "/api/cards":
            return route.fulfill(json={"cards": self.fixture["list"]})
        if path.startswith("/api/cards/"):
            card_id = path.split("/")[3]
            detail = self.fixture["details"].get(card_id)
            return route.fulfill(json=detail) if detail else route.fulfill(status=404, json={})
        return super().handle(route)

    def usage_body(self):
        result = super().usage_body()
        for provider in result["nodes"][0]["providers"].values():
            for quota in provider["quotas"] if provider else []:
                quota["resetAt"] = int(time()) + 2 * 86400 + 3 * 3600
                provider["weeklyResetAt"] = quota["resetAt"]
        return result


def focus(page):
    return page.evaluate("""() => {
      const element = document.activeElement;
      return {
        label: element.getAttribute('aria-label') || element.getAttribute('placeholder') ||
          (element.tagName === 'BUTTON' ? element.innerText.trim() : element.tagName),
        inside: !!element.closest('[data-testid="pas-report-thread-dialog"]'),
        visible: !!element.getClientRects().length &&
          !element.closest('[inert], [aria-hidden="true"]') &&
          getComputedStyle(element).visibility === 'visible'
      };
    }""")


def bounds(locator):
    return locator.evaluate("""root => {
      const shown = el => el.getClientRects().length && !el.closest('[inert], [aria-hidden="true"]') &&
        getComputedStyle(el).visibility === 'visible';
      const labels = [...root.querySelectorAll('button, h2, h3, time, strong, [data-slot="status-chip"]')].filter(shown);
      const edge = root.getBoundingClientRect();
      const offscreen = [], clipped = [], wrappedNumbers = [];
      for (const el of labels) {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        const label = (el.innerText || el.getAttribute('aria-label') || el.tagName).trim();
        if (r.width < 1 || r.left < Math.max(0, edge.left) - 1 || r.right > Math.min(innerWidth, edge.right) + 1)
          offscreen.push(label);
        if (el.clientWidth && el.scrollWidth > el.clientWidth + 1 &&
            style.textOverflow !== 'ellipsis' && !el.querySelector('.truncate, [class*="title"]'))
          clipped.push(label);
        if (el.matches('time,strong')) {
          const range = document.createRange();
          range.selectNodeContents(el);
          if (range.getClientRects().length > 1) wrappedNumbers.push(label);
        }
      }
      return {viewport: innerWidth, document: document.documentElement.scrollWidth,
        content: [root.clientWidth, root.scrollWidth], offscreen, clipped, wrappedNumbers};
    }""")


def operate_thread(page, dialog, dictionary, checks):
    decision = dialog.get_by_test_id("pas-rt-decide")
    trigger = decision.get_by_test_id("pas-rt-open-composer")
    trigger.focus()
    page.keyboard.press("Enter")
    editor = decision.get_by_role("textbox", name=dictionary["thread"]["comment"], exact=True)
    expect(editor).to_be_focused()
    checks["composer_first"] = focus(page)
    editor.fill("Keep this draft while resizing the report.")
    scroll = dialog.get_by_test_id("pas-rt-thread-scroll")
    scroll.evaluate("el => el.scrollTop = 0")
    before = scroll.evaluate("el => el.scrollTop")
    page.set_viewport_size({"width": 360, "height": 800})
    expect(editor).to_have_value("Keep this draft while resizing the report.")
    narrow = scroll.evaluate("el => el.scrollTop")
    page.set_viewport_size({"width": 1440, "height": 900})
    expect(editor).to_have_value("Keep this draft while resizing the report.")
    checks["resize"] = {"draft": editor.input_value(), "scroll": [before, narrow, scroll.evaluate("el => el.scrollTop")]}
    page.keyboard.press("Escape")
    expect(trigger).to_be_focused()
    checks["composer_close"] = focus(page)
    tab_sequence = []
    for _ in range(8):
        page.keyboard.press("Tab")
        tab_sequence.append(focus(page))
    checks["tab"] = tab_sequence

    snooze = decision.get_by_test_id("pas-rt-snooze-trigger")
    snooze.focus()
    page.keyboard.press("Enter")
    expect(decision.get_by_role("group", name=dictionary["thread"]["snoozeDuration"])).to_be_visible()
    checks["snooze_first"] = focus(page)
    page.keyboard.press("Tab")
    checks["snooze_next"] = focus(page)
    page.keyboard.press("Escape")
    expect(snooze).to_be_focused()
    checks["snooze_close"] = focus(page)


def exercise(browser, base, out, locale, width):
    fake = PersistentFake(locale)
    dictionary = json.loads((ROOT / f"packages/i18n/src/locales/{locale}/persistent.json").read_text())
    jobs = json.loads((ROOT / f"packages/i18n/src/locales/{locale}/jobs.json").read_text())
    context, page, _ = page_for(browser, base, width, locale, fake)
    page.set_default_timeout(10000)
    fixture = page.evaluate("(url) => import(url).then(module => ({ ...module.buildPasThreadFixture(), ids: module.PAS_THREAD_IDS }))", FIXTURE_MODULE)
    if locale == "en":
        review_id = fixture["ids"]["review"]
        title = "Verify the reporting timeline, decision controls, and linked card panel before rolling out the dashboard update"
        fixture["entries"][0]["title"] = title
        fixture["entries"][0]["context"] = "The dashboard update is ready for review."
        for card in fixture["list"] + [fixture["details"][review_id]["card"]]:
            if card["id"] == review_id:
                card.update(title=title, request="Review the desktop and mobile reporting flows.")
    fake.fixture = fixture
    checks = {"geometry": {}}

    def record(name, locator):
        expect(locator).to_be_visible()
        assert "persistent." not in locator.inner_text(), name
        page.evaluate("() => document.fonts.ready")
        capture(page, out, f"{locale}-{name}-{width}.png")
        checks["geometry"][name] = bounds(locator)
        print(f"{locale} {width} {name}", flush=True)

    path = f"{base}/persistent/{SESSION_ID}"
    page.goto(path, wait_until="domcontentloaded")
    shell = page.locator(".persistent-session-screen")
    deck = page.get_by_test_id("report-deck")
    expect(deck).to_have_attribute("aria-label", dictionary["report"]["current"], timeout=30000)
    current = deck.locator('[data-current="true"]')
    expand = current.get_by_role("button", name=dictionary["report"]["expand"], exact=True)
    open_report = current.get_by_test_id("pas-report-open-window")
    expect(open_report).to_have_accessible_name(dictionary["report"]["openWindow"])
    record("report-deck", deck)

    expand.click()
    expect(current.get_by_role("link", name=dictionary["expansion"]["openCard"], exact=True)).to_be_visible()
    record("card-expansion", deck)
    collapse = current.get_by_role("button", name=dictionary["report"]["collapse"], exact=True)
    collapse.click()

    open_report.click()
    dialog = page.locator(DIALOG)
    expect(dialog.get_by_test_id("pas-rt-timeline")).to_be_visible()
    expect(dialog.get_by_role("button", name=dictionary["thread"]["done"], exact=True)).to_be_visible()
    checks["dialog_open"] = focus(page)
    record("report-thread", dialog)
    if width == 360:
        agenda = dialog.get_by_test_id("pas-rt-rail-toggle")
        agenda.focus()
        page.keyboard.press("Enter")
        expect(agenda).to_have_attribute("aria-expanded", "true")
        expect(dialog.get_by_test_id("pas-rt-rail")).to_be_visible()
        expect(dialog.locator(f'.pas-rt-rail-item[data-card-id="{fixture["ids"]["review"]}"]')).to_be_focused()
        checks["rail_open"] = focus(page)
        record("agenda-drawer", dialog)
        page.keyboard.press("Escape")
        expect(agenda).to_be_focused()
        checks["rail_close"] = focus(page)
    panel_trigger = dialog.get_by_test_id("pas-rt-open-card-panel")
    panel_trigger.click()
    panel = page.get_by_test_id("v3-card-workspace")
    expect(panel.get_by_test_id("card-detail")).to_contain_text(fixture["details"][fixture["ids"]["review"]]["card"]["title"])
    checks["panel_open"] = focus(page)
    record("card-preview", panel)
    page.keyboard.press("Escape")
    expect(panel).to_have_count(0)
    expect(panel_trigger).to_be_focused()
    checks["panel_close"] = focus(page)
    if locale == "en" and width == 1440:
        operate_thread(page, dialog, dictionary, checks)
    page.keyboard.press("Escape")
    expect(open_report).to_be_focused()
    checks["dialog_close"] = focus(page)

    task_button = shell.get_by_role("button", name=dictionary["tasks"]["list"], exact=True)
    task_button.click()
    task_list = page.get_by_test_id("persistent-session-task-list")
    tasks = shell.get_by_role("complementary", name=dictionary["tasks"]["title"])
    running = task_list.locator('[data-task-status-group="running"]')
    expect(running).to_have_accessible_name(dictionary["thread"]["status"]["running"])
    record("task-list", tasks)
    if width == 1440:
        row = task_list.locator(f'.v3-card-summary-row[data-card-id="{fixture["ids"]["question"]}"]')
        row.hover()
        tooltip = page.locator(".v3-persistent-task-tooltip .v3-surface")
        expect(tooltip).to_be_visible()
        record("task-tooltip", tooltip)
        page.keyboard.press("Escape")
        expect(tooltip).to_be_hidden()
        checks["tooltip_close"] = focus(page)
    else:
        row = task_list.locator(f'.v3-card-summary-row[data-card-id="{fixture["ids"]["question"]}"]')
        row.hover()
        expect(page.locator(".v3-persistent-task-tooltip")).to_have_count(0)
        checks["mobile_tooltip_hidden"] = True
    tasks.get_by_role("button", name=dictionary["tasks"]["close"], exact=True).click()

    usage = page.get_by_test_id("persistent-session-weekly-usage")
    if width == 1440:
        page.locator(".persistent-session-weekly-usage-toggle").click()
        expect(usage.get_by_role("progressbar").first).to_be_visible()
        expect(usage).to_have_accessible_name(dictionary["usage"]["title"])
        record("weekly-usage", usage)
    else:
        expect(task_list).to_be_hidden()
        expect(page.locator(".persistent-session-weekly-usage-toggle")).to_have_count(0)
        expect(usage).to_have_count(0)
        checks["mobile_usage_hidden"] = True

    fake.list_state = "empty"
    page.goto(f"{base}/persistent", wait_until="domcontentloaded")
    empty = page.get_by_test_id("persistent-empty-manual")
    expect(empty.get_by_text(dictionary["empty"]["none"], exact=True)).to_be_visible()
    record("empty", empty)

    fake.list_state = "loading"
    page.goto(path, wait_until="domcontentloaded")
    expect(shell.get_by_role("status", name=dictionary["loading"])).to_be_visible()
    record("loading", shell)
    fake.list_state = "error"
    for route in fake.held_listing:
        route.fulfill(status=503, json={})
    fake.held_listing.clear()
    error = jobs["persistent"]["requestError"].replace("{{status}}", "503")
    expect(shell.get_by_role("alert").filter(has_text=error)).to_be_visible()
    record("error", shell)
    fake.list_state = "ready"
    page.get_by_test_id("persistent-retry").click()
    expect(deck).to_have_attribute("aria-label", dictionary["report"]["current"])
    checks["retry"] = {"error": error, "focus": focus(page)}
    context.close()
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    proc, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            observations = {}
            for locale, width in [("en", 1440), ("ko", 1440), ("en", 360)]:
                observations[f"{locale}-{width}"] = exercise(browser, base, args.out, locale, width)
                (args.out / "observations.json").write_text(json.dumps(observations, ensure_ascii=False, indent=2) + "\n")
    finally:
        proc.terminate()
        proc.wait(timeout=20)


if __name__ == "__main__":
    main()

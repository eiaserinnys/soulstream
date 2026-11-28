#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from settings_i18n import capture, start_vite
from settings_toolbar_fakes import Fake, new_page, open_settings

LABELS = {
    "ko": ("에이전트 프로필", "스킬과 카탈로그", "편집", "구성", "이름", "새 프로필", "검증", "목록으로", "소스 목록으로"),
    "en": ("Agent profiles", "Skills and catalogs", "Edit", "Assembly", "Name", "New profile", "Verify", "Back to list", "Back to sources"),
}

FOCUS = """() => {
  const el = document.activeElement;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 70) || el.tagName,
    inDialog: !!el.closest('[role=dialog]'),
    visible: !!(r.width && r.height) && getComputedStyle(el).visibility === 'visible'
      && !!hit && (el.contains(hit) || hit.contains(el))
  };
}"""

FIT = """root => {
  const rootBox = root.getBoundingClientRect();
  const spills = [];
  for (const el of root.querySelectorAll('button, select, input, label, [role=tab], p, h2, h4')) {
    if (!el.checkVisibility() || !el.textContent.trim() && !el.getAttribute('aria-label')) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    let right = rootBox.right;
    let left = rootBox.left;
    for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX === 'visible') continue;
      const bounds = parent.getBoundingClientRect();
      right = Math.min(right, bounds.right);
      left = Math.max(left, bounds.left);
    }
    const label = (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 90);
    if (box.width > 0 && (box.left < left - 2 || box.right > right + 2)) spills.push({label, issue: 'bounds'});
    if (el.tagName !== 'INPUT' && el.clientWidth && el.scrollWidth > el.clientWidth + 2 && style.textOverflow !== 'ellipsis') {
      spills.push({label, issue: 'text', delta: el.scrollWidth - el.clientWidth});
    }
    if (el.getAttribute('role') === 'tab' || el.tagName === 'BUTTON' && !el.hasAttribute('data-settings-list-row')) {
      const ranges = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        .flatMap(node => { const range = new Range(); range.selectNodeContents(node); return [...range.getClientRects()]; });
      if (new Set(ranges.map(rect => Math.round(rect.top))).size > 1) spills.push({label, issue: 'wrap'});
    }
  }
  return {width: root.clientWidth, scrollWidth: root.scrollWidth, spills};
}"""


def open_sample(browser, base, locale, width, theme, query=""):
    fake = Fake(user_prefs={"wallpaper": {"mode": "bokeh"}, "uploaded": False})
    context, page = new_page(browser, base, fake, width, height=900 if width > 360 else 800, theme=theme)
    page.set_default_timeout(12000)
    page.add_init_script(f"localStorage.setItem('soul-language', '{locale}');")
    page.goto(f"{base}/dialogues?sample=settings{query}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("config-category-nav")).to_be_visible(timeout=30000)
    return context, page


def section(page, name):
    nav = page.get_by_test_id("config-category-nav")
    if not nav.is_visible():
        page.locator(".config-back").click()
    nav.get_by_role("button", name=name, exact=True).click()
    result = page.locator(".config-detail")
    expect(result.get_by_role("heading", name=name, exact=True)).to_be_visible()
    return result


def shot(page, root, output, name, evidence):
    page.evaluate("document.fonts.ready")
    expect(root).to_be_visible()
    if root.evaluate(r"""el => {
        const key = /\bagents\.[a-z][\w.]+/;
        return key.test(el.innerText) || [...el.querySelectorAll("[aria-label], [title], [placeholder]")]
          .some(node => ["aria-label", "title", "placeholder"].some(attr => key.test(node.getAttribute(attr) ?? "")));
    }"""):
        raise AssertionError(f"Raw translation key in {name}")
    capture(page, output, f"{name}.png")
    evidence[name] = root.evaluate(FIT)


def localized(browser, base, output, locale, width, theme, evidence):
    agents, skills, edit, assembly, field_name, new_profile, verify, back, back_sources = LABELS[locale]
    tag = f"{locale}-{width}"
    context, page = open_sample(browser, base, locale, width, theme)
    try:
        detail = section(page, agents)
        profile = detail.get_by_test_id("agent-profile-settings")
        expect(profile.get_by_role("button", name=new_profile, exact=True)).to_be_visible()
        shot(page, profile, output, f"{tag}-profile-list", evidence)
        profile.get_by_role("tab", name=edit, exact=True).click()
        name_input = profile.get_by_role("textbox", name=field_name, exact=True)
        expect(name_input).to_be_visible()
        shot(page, profile, output, f"{tag}-profile-edit", evidence)

        if locale == "en" and width == 1440:
            name_input.fill("An unsaved profile name for the resize check")
            panel = profile.locator('[role="tabpanel"] .overflow-y-auto').first
            scroll = panel.evaluate("el => { el.scrollTop = 160; return el.scrollTop; }")
            page.set_viewport_size({"width": 360, "height": 800})
            expect(name_input).to_have_value("An unsaved profile name for the resize check")
            narrow = profile.evaluate(FIT)
            page.set_viewport_size({"width": 1440, "height": 900})
            expect(name_input).to_have_value("An unsaved profile name for the resize check")
            evidence["profileResize"] = {"before": scroll, "after": panel.evaluate("el => el.scrollTop"), "narrow": narrow}

        profile.get_by_role("tab", name=assembly, exact=True).click()
        assembly_view = profile.get_by_test_id("agent-context-assembly")
        all_row = assembly_view.get_by_role("button", name="전체" if locale == "ko" else "All", exact=False).first
        expect(all_row).to_be_visible()
        shot(page, profile, output, f"{tag}-profile-assembly", evidence)
        all_row.click()
        expect(assembly_view.get_by_test_id("agent-context-assembly-detail")).to_be_visible()
        source_opened = page.evaluate(FOCUS)
        assembly_view.get_by_role("button", name=back_sources, exact=True).click()
        expect(all_row).to_be_visible()
        if locale == "en" and width == 1440:
            evidence["sourceFocus"] = {"open": source_opened, "back": page.evaluate(FOCUS)}

        detail = section(page, skills)
        catalog = detail.get_by_test_id("skill-catalog-settings")
        row = catalog.locator("[data-settings-list-row]").filter(has_text="cobalt-reconcile-long-running-migration-checklist")
        expect(row).to_be_visible()
        shot(page, catalog, output, f"{tag}-skill-list", evidence)
        if locale == "en" and width == 360:
            report = catalog.get_by_test_id("skill-catalog-report")
            date = report.locator("p").first.bounding_box()
            recheck = report.get_by_role("button", name="Recheck", exact=True).bounding_box()
            assert date and recheck
            gap = abs((date["y"] + date["height"] / 2) - (recheck["y"] + recheck["height"] / 2))
            evidence["reportRow"] = {"date": date, "recheck": recheck, "centerGap": gap}
            assert gap <= 1.5, f"Report date and Recheck are on different rows: {gap}px"
        row.click()
        verify_tab = catalog.get_by_role("tab", name=verify, exact=False)
        expect(verify_tab).to_be_visible()
        expect(catalog.locator("#guide-detail-panel")).to_contain_text("언제 쓰는가")
        shot(page, catalog, output, f"{tag}-skill-detail", evidence)
        if locale == "en" and width == 360:
            opened = page.evaluate(FOCUS)
            page.set_viewport_size({"width": 1440, "height": 900})
            expect(verify_tab).to_be_visible()
            page.set_viewport_size({"width": 360, "height": 800})
            expect(verify_tab).to_be_visible()
            evidence["skillResize"] = {"detailRetained": True, "layout": catalog.evaluate(FIT)}
            catalog.get_by_role("button", name=back, exact=True).click()
            expect(row).to_be_visible()
            expect(row).to_be_focused()
            evidence["skillFocus"] = {"open": opened, "back": page.evaluate(FOCUS)}
        if locale == "en" and width == 1440:
            verify_tab.focus()
            evidence["tabOrder"] = [page.evaluate(FOCUS)]
            for _ in range(6):
                page.keyboard.press("Tab")
                evidence["tabOrder"].append(page.evaluate(FOCUS))
            page.keyboard.press("Escape")
            expect(page.locator(".config-dialog")).to_be_hidden()
    finally:
        context.close()


def dialog_focus(browser, base, evidence):
    fake = Fake(user_prefs={"wallpaper": {"mode": "bokeh"}, "uploaded": False})
    context, page = new_page(browser, base, fake, 1440, theme="light")
    try:
        page.add_init_script("localStorage.setItem('soul-language', 'en');")
        page.route("**/api/config/settings", lambda route: route.fulfill(json={"categories": []}))
        page.goto(base, wait_until="domcontentloaded")
        trigger = page.get_by_test_id("config-button")
        expect(trigger).to_be_visible(timeout=30000)
        open_settings(page)
        first_focus = page.evaluate(FOCUS)
        page.keyboard.press("Escape")
        expect(page.locator(".config-dialog")).to_be_hidden()
        evidence["dialogFocus"] = {"open": first_focus, "escape": page.evaluate(FOCUS),
                                   "restored": trigger.evaluate("el => el === document.activeElement")}
    finally:
        context.close()


def error_states(browser, base, output, evidence):
    context, page = open_sample(browser, base, "en", 1440, "light", "&guidesState=loading&assemblyState=loading")
    try:
        profile = section(page, LABELS["en"][0])
        expect(profile.get_by_role("status", name="Assembling", exact=True)).to_be_visible()
        capture(page, output, "en-1440-assembly-loading.png")
        catalog = section(page, LABELS["en"][1])
        expect(catalog.get_by_test_id("skill-catalog-skeleton")).to_be_visible()
        capture(page, output, "en-1440-skill-loading.png")
    finally:
        context.close()
    context, page = open_sample(browser, base, "en", 1440, "light", "&guidesState=failure&assemblyState=retry")
    try:
        profile = section(page, LABELS["en"][0])
        assembly = profile.get_by_test_id("agent-context-assembly")
        expect(assembly.get_by_role("alert")).to_be_visible()
        retry = assembly.get_by_role("button", name="Retry", exact=True)
        expect(retry).to_be_visible()
        capture(page, output, "en-1440-assembly-error.png")
        page.evaluate("history.replaceState(null, '', '/dialogues?sample=settings&guidesState=failure')")
        retry.click()
        expect(assembly.get_by_role("button", name="All", exact=False).first).to_be_visible()
        catalog = section(page, LABELS["en"][1])
        expect(catalog.get_by_role("alert")).to_have_text("Couldn't load skills.")
        capture(page, output, "en-1440-skill-error.png")
        page.evaluate("history.replaceState(null, '', '/dialogues?sample=settings')")
        catalog.get_by_role("button", name="Retry", exact=True).click()
        expect(catalog.locator("[data-settings-list-row]").first).to_be_visible()
        evidence["errorRecovery"] = {"assembly": True, "skills": True}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description="Capture and measure the localized agent settings tabs.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    proc, base = start_vite()
    evidence = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for locale, width, theme in (("ko", 1440, "light"), ("en", 1440, "light"), ("en", 360, "dark")):
                localized(browser, base, args.output, locale, width, theme, evidence)
            error_states(browser, base, args.output, evidence)
            dialog_focus(browser, base, evidence)
    finally:
        proc.terminate()
        proc.wait(timeout=20)
        (args.output / "measurements.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

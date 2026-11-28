#!/usr/bin/env python3
"""Exercise localized webhook settings in the dashboard using fixture API responses."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import DIALOG, ROOT, LocaleFake, capture, page_for, start_vite
from settings_toolbar_fakes import PAS, open_settings

SESSION = "12345678-1234-4234-8234-123456789abc"
SESSION_NAME = "Weekly reporting and incident follow-up"
INBOUND_NAME = "Production incident alerts from the on-call notification service"
OUTBOUND_NAME = "Weekly briefing delivery"
ACCESS_NAME = "Read and send requests for the incident response team and weekend operators"
AGENT_NAME = "Incident response assistant"
DATE = "2025-11-18T03:00:00Z"
EXPIRY = "2099-03-10T07:45:00Z"
KEY = "fixture-inbound-key-shown-once"
DETAIL = ".config-detail"


class WebhooksFake(LocaleFake):
    def __init__(self, locale):
        super().__init__()
        self.preferences["language"] = locale
        self.held_link_requests = []
        self.links_state = "loading"
        self.inbound = {
            "id": "inbound-one", "label": INBOUND_NAME, "target_session_id": SESSION,
            "auth_mode": "key", "preamble": None, "url": "https://hooks.example.test/inbound/one",
            "created_at": DATE, "expires_at": EXPIRY, "revoked_at": None, "last_used_at": DATE,
            "state": "active", "recent": {"count_24h": 1024, "failed_24h": 3, "last_received_at": DATE},
        }
        self.outbound = {
            "id": "outbound-one", "label": OUTBOUND_NAME, "target_session_id": SESSION,
            "event_types": ["session.reply", "session.question", "session.failed", "session.ended"],
            "url": "https://reports.example.test/webhooks/project-briefing",
            "active": True, "disabled_reason": None, "consecutive_failures": 0,
            "created_at": DATE, "updated_at": DATE, "recent_failures": 16,
        }
        self.link = {
            "id": "link-one", "label": ACCESS_NAME, "target_session_id": SESSION,
            "permissions": ["send", "read_own", "read_history", "control"],
            "created_at": DATE, "expires_at": EXPIRY, "revoked_at": None, "last_used_at": DATE,
        }
        self.agent_key = {
            "id": "key-one", "createdAt": DATE, "lastUsedAt": DATE, "revokedAt": None,
            "isExistingConnection": True,
        }

    def handle(self, route):
        request = route.request
        url = urlsplit(request.url)
        path = url.path
        if path == "/api/persistent-sessions":
            return route.fulfill(json={"sessions": [{**PAS, "session_id": SESSION, "display_name": SESSION_NAME}], "total": 1})
        if path == "/api/webhooks/inbound":
            if request.method == "POST":
                assert request.post_data_json["target_session_id"] == SESSION
                return route.fulfill(status=201, json={**self.inbound, **request.post_data_json, "secret": KEY})
            return route.fulfill(json=[
                self.inbound,
                *[{**self.inbound, "id": f"inbound-{i}", "label": name}
                  for i, name in enumerate(("Partner notifications", "Inventory updates", "Support intake",
                                             "Build status", "Billing notices", "Weekly status report"), 2)],
            ])
        if path == "/api/webhooks/inbound/inbound-one/requests":
            return route.fulfill(json={"items": [{
                "request_id": "request-one", "status": "accepted", "session": {"state": "idle"}, "received_at": DATE,
            }]})
        if path == "/api/webhooks/outbound":
            return route.fulfill(json={"subscriptions": [self.outbound]})
        if path == "/api/webhooks/outbound/outbound-one/deliveries":
            states = parse_qs(url.query).get("state", ["dead", "pending", "delivered"])
            return route.fulfill(json={"deliveries": [
                {"id": state, "event_id": index, "event_type": self.outbound["event_types"][index],
                 "state": state, "attempt_count": 3 if state == "dead" else 0, "next_attempt_at": EXPIRY,
                 "last_status": 503 if state == "dead" else None, "last_error": None,
                 "created_at": DATE, "delivered_at": DATE if state == "delivered" else None}
                for index, state in enumerate(("dead", "pending", "delivered")) if state in states
            ]})
        if path == "/api/access-links":
            if self.links_state == "loading":
                self.held_link_requests.append(route)
                return None
            if self.links_state == "error":
                return route.fulfill(status=503, json={"detail": "fixture server error"})
            return route.fulfill(json=[self.link, {**self.link, "id": "past-link", "label": "Archived project access", "expires_at": DATE}])
        if path == "/api/owned-agents":
            return route.fulfill(json={"agents": [{
                "id": "assistant", "name": AGENT_NAME, "enabled": True, "ownerEmail": "qa@example.test",
                "createdAt": DATE, "updatedAt": DATE, "keys": [self.agent_key],
            }], "existingConnection": {"configured": True, "registered": True, "canRegister": False}})
        if path == "/api/owned-agents/assistant/keys":
            return route.fulfill(json={"credential": self.agent_key, "token": "fixture-agent-key-shown-once"})
        return super().handle(route)


def button(scope, label):
    return scope.get_by_role("button", name=label, exact=True)


def popup(page):
    return page.locator(DIALOG + "[data-open]").last


def choose_tab(page, settings, key):
    dialog = popup(page)
    back = button(dialog, settings["allSettings"])
    if back.is_visible():
        back.click()
    title = settings["tabs"][key]["label"]
    button(dialog.get_by_role("navigation"), title).click()
    detail = page.locator(DETAIL)
    expect(detail.get_by_role("heading", name=title, exact=True)).to_be_visible()
    return detail


def focus(page):
    return page.evaluate("""() => {
      const e = document.activeElement;
      return {
        name: e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText?.trim().split('\\n')[0] || e.tagName,
        visible: e !== document.body && e.getClientRects().length > 0 && !e.closest('[inert], [aria-hidden="true"]'),
        inside: !!e.closest('[data-slot="dialog-popup"][data-open]'),
      };
    }""")


def layout(panel):
    return panel.evaluate("""panel => {
      const bounds = panel.getBoundingClientRect();
      const visible = e => {
        return e.getClientRects().length > 0 && !e.closest('[aria-hidden="true"], .sr-only')
          && getComputedStyle(e).visibility !== 'hidden';
      };
      const text = [...panel.querySelectorAll('h2,h3,summary,p,span,button,label')].filter(e =>
          visible(e) && e.childElementCount === 0 && e.textContent.trim());
      const clipped = text.flatMap(e => {
        const rect = e.getBoundingClientRect();
        const style = getComputedStyle(e);
        const range = document.createRange();
        range.selectNodeContents(e);
        const lines = [...range.getClientRects()];
        if (style.textOverflow === 'ellipsis' && rect.width > 16) return [];
        if (rect.width <= 1 || lines.some(line => line.left < bounds.left - 1 || line.right > bounds.right + 1) ||
            (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)) return [e.textContent.trim()];
        return [];
      });
      const controlsOutside = [...panel.querySelectorAll('button,input,textarea,[role="combobox"]')]
        .filter(visible).filter(e => {
          const box = e.getBoundingClientRect();
          return box.width <= 1 || box.left < bounds.left - 1 || box.right > bounds.right + 1;
        }).map(e => e.getAttribute('aria-label') || e.textContent.trim() || e.tagName);
      const metadata = [...panel.querySelectorAll('.access-links-meta > span')].filter(e =>
        visible(e) && /[0-9]/.test(e.textContent)).map(e => {
        const range = document.createRange();
        range.selectNodeContents(e);
        return {text: e.textContent, lines: range.getClientRects().length};
      });
      return {width: innerWidth, documentWidth: document.documentElement.scrollWidth,
              left: bounds.left, right: bounds.right, clipped, controlsOutside, metadata};
    }""")


def shot(page, output, prefix, state, panel, key_label, results, *, allow_preamble=False):
    expect(panel.get_by_text(key_label, exact=True).first).to_be_visible()
    expect(panel).to_have_css("opacity", "1")
    assert "webhooks." not in panel.inner_text()
    if prefix.startswith("en") and not allow_preamble:
        assert not any("가" <= char <= "힣" for char in panel.inner_text()), panel.inner_text()
    page.evaluate("() => document.fonts.ready")
    filename = f"{prefix}-{state}.png"
    capture(page, output, filename)
    results[filename] = layout(panel)


def dismiss(page, panel, opener):
    page.keyboard.press("Escape")
    try:
        expect(panel).to_be_hidden(timeout=6000)
        escaped = True
    except AssertionError:
        escaped = not panel.is_visible()
        if not escaped:
            panel.locator('[data-slot="dialog-close"]').click()
            expect(panel).to_be_hidden()
    try:
        expect(opener).to_be_focused(timeout=3000)
        restored = True
    except AssertionError:
        restored = False
    return escaped, restored, focus(page)["name"]


def open_dialog(page, opener, title, enter=False):
    if enter:
        opener.focus()
        page.keyboard.press("Enter")
    else:
        opener.click()
    panel = page.get_by_role("dialog", name=title, exact=True)
    expect(panel).to_be_visible()
    expect(panel).to_have_css("opacity", "1")
    return panel, focus(page)


def operation(page, opener, title, rows):
    dialog, first = open_dialog(page, opener, title, enter=True)
    escaped, restored, after = dismiss(page, dialog, opener)
    rows.append({"surface": title, "openedBy": "Enter", "initial": first, "enter": "열림",
                 "escape": escaped, "restored": restored, "after": after})


def run_screens(browser, base, output, locale, width, results):
    prefix = f"{locale}-{width}"
    dict_dir = ROOT / "packages/i18n/src/locales" / locale
    settings = json.loads((dict_dir / "settings.json").read_text())
    words = json.loads((dict_dir / "webhooks.json").read_text())
    common, inbound, outbound, access, owned = (words[k] for k in ("common", "inbound", "outbound", "access", "owned"))
    fake = WebhooksFake(locale)
    context, page, _ = page_for(browser, base, width, locale, fake)
    page.set_default_timeout(6000)
    open_settings(page)
    detail = choose_tab(page, settings, "webhooks")
    shot(page, output, prefix, "inbound-list", detail, INBOUND_NAME, results)
    create = button(detail, inbound["create"])
    dialog, first = open_dialog(page, create, inbound["createTitle"], enter=True)
    target = dialog.get_by_role("combobox", name=common["targetSession"])
    expect(target).to_be_visible()
    shot(page, output, prefix, "inbound-create", dialog, inbound["createTitle"], results, allow_preamble=True)
    target.focus()
    page.keyboard.press("Tab")
    tab = focus(page)
    target.click()
    choices = page.get_by_role("listbox")
    expect(choices).to_be_visible()
    picker_initial = focus(page)
    page.keyboard.press("Escape")
    expect(choices).to_be_hidden()
    picker_restored = focus(page)
    target.click()
    page.get_by_role("option", name=SESSION_NAME, exact=True).click()
    name = dialog.get_by_role("textbox", name=common["sender"])
    name.fill("Incident intake")
    resize = None
    if locale == "en" and width == 1440:
        dimensions = page.viewport_size
        dialog_body = dialog.locator('[data-slot="dialog-panel"]')
        initial_scroll = dialog_body.evaluate("element => element.scrollTop")
        target.click()
        expect(choices).to_be_visible()
        page.set_viewport_size({"width": 360, "height": 800})
        expect(name).to_have_value("Incident intake")
        expect(button(dialog, inbound["submit"])).to_be_visible()
        narrow = layout(dialog)
        if choices.is_visible():
            try:
                expect(choices).to_be_in_viewport(timeout=1500)
            except AssertionError:
                pass
        picker_box = choices.bounding_box(timeout=1000) if choices.is_visible() else None
        if choices.is_visible():
            page.keyboard.press("Escape")
            expect(choices).to_be_hidden()
        page.set_viewport_size(dimensions)
        expect(target).to_contain_text(SESSION_NAME)
        expect(name).to_have_value("Incident intake")
        resize = {
            "narrow": narrow, "back": layout(dialog), "retained": True, "picker": picker_box,
            "scroll": [initial_scroll, dialog_body.evaluate("element => element.scrollTop")],
        }
    button(dialog, inbound["submit"]).click()
    once = page.get_by_role("dialog", name=inbound["created"], exact=True)
    shot(page, output, prefix, "inbound-key", once, KEY, results)
    once_focus = focus(page)
    escaped, restored, after = dismiss(page, once, create)
    expect(page.get_by_text(KEY, exact=True)).to_have_count(0)
    dialogs = [
        {"surface": inbound["createTitle"], "openedBy": "Enter", "initial": first, "enter": "열림",
         "escape": escaped, "restored": restored, "after": after},
        {"surface": inbound["created"], "openedBy": inbound["submit"], "initial": once_focus,
         "enter": "발급은 만들기 버튼 클릭", "escape": escaped, "restored": restored, "after": after},
        {"surface": common["targetSession"], "openedBy": "클릭", "initial": picker_initial,
         "enter": "선택지는 클릭으로 선택", "escape": True, "restored": picker_restored["name"] == common["targetSession"],
         "after": picker_restored["name"]},
    ]

    inbound_row = detail.locator(".webhooks-row").filter(has_text=INBOUND_NAME)
    outbound_row = detail.locator(".webhooks-row").filter(has_text=OUTBOUND_NAME)
    outbound_row.evaluate("row => row.closest('section').scrollIntoView({block: 'start'})")
    shot(page, output, prefix, "outbound-list", detail, OUTBOUND_NAME, results)
    delivery, initial = open_dialog(page, outbound_row, OUTBOUND_NAME, enter=True)
    expect(delivery.get_by_role("group", name=outbound["filterDeliveries"])).to_be_visible()
    expect(delivery.locator(".webhooks-records")).to_contain_text("November 18, 2025" if locale == "en" else "2025년 11월 18일")
    shot(page, output, prefix, "outbound-deliveries", delivery, outbound["delivered"], results)
    if locale == "en" and width == 1440:
        button(delivery, outbound["failed"]).click()
        expect(delivery.get_by_text(outbound["delivered"], exact=True)).to_have_count(0)
        delete = button(delivery, outbound["delete"])
        delete.focus()
        page.keyboard.press("Enter")
        confirm = page.get_by_role("dialog", name=outbound["deleteTitle"], exact=True)
        expect(confirm).to_be_visible()
        confirm_focus = focus(page)
        button(confirm, common["cancel"]).click()
        expect(confirm).to_be_hidden()
        expect(delete).to_be_focused()
        dialogs.append({"surface": outbound["deleteTitle"], "openedBy": "Enter", "initial": confirm_focus,
                        "enter": "열림", "escape": None, "restored": True, "after": focus(page)["name"]})
    escaped, restored, after = dismiss(page, delivery, outbound_row)
    dialogs.append({"surface": outbound["filterDeliveries"], "openedBy": "Enter", "initial": initial,
                    "enter": "열림", "escape": escaped, "restored": restored, "after": after})
    if locale == "en" and width == 1440:
        operation(page, button(detail, outbound["create"]), outbound["createTitle"], dialogs)
        inbound_detail, initial = open_dialog(page, inbound_row, INBOUND_NAME, enter=True)
        expect(inbound_detail.get_by_text(inbound["recentRequests"], exact=True)).to_be_visible()
        revoke = button(inbound_detail, common["revoke"])
        revoke.focus()
        page.keyboard.press("Enter")
        confirm = page.get_by_role("dialog", name=inbound["revokeTitle"], exact=True)
        expect(confirm).to_be_visible()
        confirm_focus = focus(page)
        button(confirm, common["cancel"]).click()
        expect(confirm).to_be_hidden()
        expect(revoke).to_be_focused()
        dialogs.append({"surface": inbound["revokeTitle"], "openedBy": "Enter", "initial": confirm_focus,
                        "enter": "열림", "escape": None, "restored": True, "after": focus(page)["name"]})
        escaped, restored, after = dismiss(page, inbound_detail, inbound_row)
        dialogs.append({"surface": inbound["recentRequests"], "openedBy": "Enter", "initial": initial,
                        "enter": "열림", "escape": escaped, "restored": restored, "after": after})

    detail = choose_tab(page, settings, "access_links")
    expect(detail.get_by_role("status", name=common["loading"])).to_be_visible()
    expect(popup(page)).to_have_css("opacity", "1")
    capture(page, output, f"{prefix}-loading.png")
    assert fake.held_link_requests
    fake.links_state = "error"
    for request in fake.held_link_requests:
        request.fulfill(status=503, json={"detail": "fixture server error"})
    fake.held_link_requests.clear()
    shot(page, output, prefix, "error", detail, access["loadError"], results)
    assert "fixture server error" not in detail.inner_text()
    fake.links_state = "ready"
    button(detail, common["retry"]).click()
    expect(detail.get_by_text(ACCESS_NAME, exact=True)).to_be_visible()
    detail.locator("summary").click()
    expect(detail).to_contain_text("Mar 10, 2099" if locale == "en" else "2099년 3월 10일")
    shot(page, output, prefix, "access-links", detail, ACCESS_NAME, results)
    if width == 360:
        expiry = [row for row in results[f"{prefix}-access-links.png"]["metadata"] if row["text"].startswith("Until")]
        assert len(expiry) == 1 and expiry[0]["lines"] == 1, expiry
    if locale == "en" and width == 1440:
        operation(page, button(detail, access["create"]), access["createTitle"], dialogs)
        operation(page, button(detail, common["revoke"]), access["revokeTitle"], dialogs)

    detail = choose_tab(page, settings, "owned_agents")
    shot(page, output, prefix, "owned-agents", detail, AGENT_NAME, results)
    if locale == "en" and width == 1440:
        operation(page, button(detail, owned["add"]), owned["add"], dialogs)
        operation(page, button(detail, owned["rename"]), owned["rename"], dialogs)
        operation(page, button(detail, owned["issueKey"]), owned["newKey"], dialogs)
        operation(page, button(detail, owned["revokeKey"]), owned["revokeTitle"], dialogs)
    context.close()
    return {"dialogs": dialogs, "tab": tab, "expectedTab": common["sender"], "resize": resize, "retry": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    metrics = {}
    proc, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for locale, width in (("ko", 1440), ("en", 1440), ("en", 360)):
                print(f"Capture {locale} at {width}px", flush=True)
                metrics[f"{locale}-{width}-operations"] = run_screens(browser, base, output, locale, width, metrics)
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=20)

    for prefix in ("ko-1440", "en-1440", "en-360"):
        images = list(output.glob(prefix + "-*.png"))
        assert len(images) == 9, [image.name for image in images]
        assert len({hashlib.sha256(image.read_bytes()).digest() for image in images}) == len(images), prefix
    (output / "measurements.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Captured 27 distinct state images across 3 viewport and locale pairs in {output}", flush=True)


if __name__ == "__main__":
    main()

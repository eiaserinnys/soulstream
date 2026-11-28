#!/usr/bin/env python3
"""Exercise the dashboard MCP settings with Korean and English account preferences."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcp_agent_panel as agent
import mcp_settings_panel as settings
from playwright.sync_api import expect, sync_playwright
from settings_toolbar_fakes import Fake

LABELS = {
    "ko": ("서버", "프로필", "비밀값", "전송 이름", "값 교체", "새 값", "삭제", "취소"),
    "en": ("Server", "Profile", "Secrets", "Transport name", "Replace value", "New value", "Delete", "Cancel"),
}


def account_language(page, locale, theme):
    page.add_init_script(f"localStorage.setItem('soul-language', '{locale}')")
    page.route("**/api/user/preferences", lambda route: route.fulfill(json={
        "preferences": {"language": locale, "appearance": theme, "wallpaper": {"mode": "plain"}},
        "hasBackground": False, "backgroundUrl": None,
    }))


def focus_label(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      return el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.innerText?.trim() || el.tagName;
    }""").splitlines()[0]


def measure(panel):
    return panel.evaluate("""root => {
      const boundary = root.getBoundingClientRect();
      const issues = [];
      for (const el of root.querySelectorAll('button, input, select, textarea, [role=tab], [role=checkbox]')) {
        if (!el.getClientRects().length || el.closest('[aria-hidden=true], [inert]')) continue;
        const bounds = el.getBoundingClientRect();
        const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 70);
        if (bounds.width < 13 || bounds.left < Math.max(0, boundary.left) - 1 ||
            bounds.right > Math.min(innerWidth, boundary.right) + 1) issues.push(label || el.tagName);
        if (el.tagName !== 'BUTTON') continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent.trim() || text.parentElement.closest('.truncate')) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          const lines = [...range.getClientRects()].filter(line => line.width);
          if (lines.length > 1 || lines.some(line => line.left < bounds.left - 1 || line.right > bounds.right + 1))
            issues.push(text.textContent.trim());
        }
      }
      return {document: document.documentElement.scrollWidth, viewport: innerWidth, issues: [...new Set(issues)]};
    }""")


def capture(page, panel, out, name, metrics):
    expect(panel).to_be_visible()
    expect(panel).not_to_contain_text(re.compile(r"\bmcp\.[a-zA-Z]+\b"))
    page.evaluate("document.fonts.ready")
    metrics[name] = measure(panel)
    settings.capture(page, out, name)


def open_settings(page, base, locale):
    dashboard = Fake(atom=False, sessions="manual")

    def dashboard_api(url):
        path = urlsplit(url).path
        return path.startswith("/api/") and not (
            path.startswith("/api/mcp/") or path.endswith("/agents")
            or path in {"/api/agent-profiles", "/api/context-bundles", "/api/user/preferences"}
        )

    page.route(dashboard_api, dashboard.handle)
    nodes = [{"nodeId": node, "status": "connected", "sessionCount": 0,
              "host": "127.0.0.1", "port": 1, "capabilities": {}, "connectedAt": 0}
             for node in settings.NODES[:2]]
    page.route("**/api/nodes/stream", lambda route: route.fulfill(
        content_type="text/event-stream", body=f"event: snapshot\ndata: {json.dumps(nodes)}\n\n"))
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(
        json={"items": [], "nextCursor": None}))
    page.goto(base, wait_until="domcontentloaded")
    expect(page.locator("html")).to_have_attribute("lang", locale)
    page.get_by_test_id("config-button").click()
    popup = page.locator(".config-dialog")
    expect(popup.locator(".config-layout")).to_be_visible()
    back = popup.locator(".config-back")
    if back.is_visible():
        back.click()
    popup.get_by_role("navigation").get_by_role("button", name="MCP", exact=True).click()


def run_surfaces(browser, origin, out, locale, width, metrics, operations):
    server_tab, profile_tab, secrets_tab, transport_name, replace, new_value, delete, cancel = LABELS[locale]
    theme = "dark" if width == 360 else "light"
    data = settings.fixture()
    data["profiles"][0]["description"] = "Shared project tools"
    data["profiles"][0]["mcp_servers"].append("exa")
    data["bindings"].append({
        "agent_id": "shared-tools-agent", "node_id": settings.NODES[1],
        "mcp_profile_id": data["profiles"][0]["id"], "version": 1,
    })
    data["servers"][1]["name"] = "long-project-context-search-and-documentation-tools-for-team-workspaces"
    context, page = agent.new_page(browser, width, theme, origin, data, {"preview": "mismatch"}, {})
    account_language(page, locale, theme)
    suffix = f"{locale}-{width}"
    detail = page.locator(".config-detail")
    frame = page.get_by_test_id("mcp-settings")
    try:
        open_settings(page, origin, locale)
        expect(page.get_by_role("tab", name=server_tab, exact=True)).to_be_visible()
        expect(frame.locator("aside")).to_contain_text(data["servers"][1]["name"])
        expect(frame).to_contain_text("+ New server" if locale == "en" else "+ 새 서버")
        capture(page, frame, out, f"server-list-{suffix}", metrics)
        if locale == "en" and width == 360:
            pending = page.get_by_text(f"{settings.NODES[1]} 13 pending", exact=True)
            operations["pending_status_lines"] = pending.evaluate("""el => {
              const lines = new Set();
              for (const text of el.childNodes) {
                if (text.nodeType !== Node.TEXT_NODE || !text.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
              }
              return lines.size;
            }""")

        frame.locator("aside button", has_text="exa").first.click()
        field = frame.get_by_label(transport_name, exact=True)
        expect(field).to_have_value("exa")
        field.scroll_into_view_if_needed()
        capture(page, frame, out, f"server-editor-{suffix}", metrics)
        if locale == "en" and width == 1440:
            action_buttons = frame.get_by_role("button", name=re.compile(r"^(Test|Revert|Delete)$"))
            operations["server_action_rows"] = action_buttons.evaluate_all(
                "buttons => new Set(buttons.map(el => Math.round(el.getBoundingClientRect().top))).size")
            field.fill("edited-example")
            before = detail.evaluate("el => el.scrollTop")
            page.set_viewport_size({"width": 360, "height": 800})
            expect(field).to_have_value("edited-example")
            narrow = measure(frame)
            page.set_viewport_size({"width": 1440, "height": 900})
            expect(field).to_have_value("edited-example")
            after = detail.evaluate("el => el.scrollTop")
            operations["resize"] = (before, after, narrow["document"] == narrow["viewport"])
            field.fill("exa")

        delete_trigger = frame.get_by_role("button", name=delete, exact=True)
        delete_trigger.click()
        dialog = page.get_by_role("dialog").filter(has=page.get_by_role("heading", name=delete, exact=True))
        cancel_button = dialog.get_by_role("button", name=cancel, exact=True)
        expect(cancel_button).to_be_visible()
        capture(page, dialog, out, f"delete-confirmation-{suffix}", metrics)
        first_focus = focus_label(page)
        tab_labels = []
        for _ in range(3):
            page.keyboard.press("Tab")
            tab_labels.append(focus_label(page))
        focus_trapped = dialog.evaluate("el => el.contains(document.activeElement)")
        cancel_button.focus()
        page.keyboard.press("Enter")
        expect(dialog).to_have_count(0)
        delete_trigger.click()
        expect(cancel_button).to_be_focused()
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        restored = focus_label(page)
        operations["delete"].append((suffix, first_focus, tab_labels, focus_trapped, restored))

        if locale == "en" and width == 1440:
            delete_trigger.click()
            dialog.get_by_role("button", name="Delete", exact=True).click()
            expect(dialog.get_by_role("alert")).to_contain_text("Profiles in use:")
            summary = dialog.locator("summary", has_text="All profiles in use")
            summary.click()
            expect(summary.locator("xpath=..")).to_have_attribute("open", "")
            settings.capture(page, out, "delete-in-use-en-1440")
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)

            revert = frame.get_by_role("button", name="Revert", exact=True)
            revert.click()
            history = page.get_by_role("dialog").filter(has=page.get_by_role("heading", name="Revert", exact=True))
            close = history.get_by_role("button", name="Close", exact=True)
            expect(close).to_be_focused()
            initial = focus_label(page)
            page.keyboard.press("Enter")
            expect(history).to_have_count(0)
            revert.click()
            expect(close).to_be_focused()
            page.keyboard.press("Escape")
            expect(history).to_have_count(0)
            operations["other"].append(("되돌리기", "Revert", initial, "닫힘", "닫힘", focus_label(page)))

            icon = frame.get_by_role("button", name="Choose icon", exact=True)
            icon.click()
            expect(frame.get_by_role("button", name="Use initial", exact=True)).to_be_focused()
            initial = focus_label(page)
            page.keyboard.press("Enter")
            expect(icon).to_have_attribute("aria-expanded", "true")
            page.keyboard.press("Escape")
            expect(icon).to_have_attribute("aria-expanded", "false")
            operations["other"].append(("아이콘 선택", "Choose icon", initial, "현재 선택 유지", "접힘", focus_label(page)))

            unit = frame.get_by_test_id("mcp-value-unit").first
            unit.get_by_role("button", name="Replace value", exact=True).click()
            replacement = unit.get_by_label("New value", exact=True)
            expect(replacement).to_be_focused()
            initial = focus_label(page)
            page.keyboard.press("Enter")
            expect(replacement).to_be_visible()
            page.keyboard.press("Escape")
            expect(replacement).to_have_count(0)
            operations["other"].append(("서버 값 교체", "Replace value", initial, "입력 유지", "편집 취소", focus_label(page)))

        page.get_by_role("tab", name=profile_tab, exact=True).click()
        expect(frame.get_by_label("Profile ID" if locale == "en" else "프로필 ID")).to_be_visible()
        capture(page, frame, out, f"profile-editor-{suffix}", metrics)
        page.get_by_role("tab", name=secrets_tab, exact=True).click()
        replace_trigger = frame.get_by_role("button", name=replace, exact=True)
        replace_trigger.click()
        value_input = frame.get_by_label(new_value, exact=True)
        expect(value_input).to_be_visible()
        first_focus = focus_label(page)
        value_input.fill("fixture-draft")
        capture(page, frame, out, f"secret-editor-{suffix}", metrics)
        page.keyboard.press("Enter")
        visible_after_enter = value_input.is_visible()
        page.keyboard.press("Escape")
        expect(value_input).to_have_count(0)
        operations["replace"].append((suffix, first_focus, visible_after_enter, focus_label(page)))

        page.get_by_role("tab", name=profile_tab, exact=True).click()
        frame.get_by_role("button", name=f"example-agent ({settings.NODES[0]})", exact=True).click()
        expect(page.get_by_role("tab", name="MCP", exact=True)).to_have_attribute("aria-selected", "true")
        pane = page.locator("#agent-profile-pane-panel")
        expect(pane.get_by_label("MCP profile" if locale == "en" else "MCP 프로필")).to_be_visible()
        expect(pane.get_by_role("tabpanel", name="Run preview" if locale == "en" else "실행 미리보기")).to_be_visible()
        capture(page, pane, out, f"agent-connection-{suffix}", metrics)
        if locale == "en" and width == 1440:
            fork = pane.get_by_role("button", name="Copy for this agent", exact=True)
            fork.click()
            prompt = page.get_by_role("dialog").filter(has=page.get_by_role("heading", name="Copy profile", exact=True))
            expect(prompt.get_by_role("button", name="Cancel", exact=True)).to_be_focused()
            initial = focus_label(page)
            page.keyboard.press("Enter")
            expect(prompt).to_have_count(0)
            fork.click()
            expect(prompt.get_by_role("button", name="Cancel", exact=True)).to_be_focused()
            page.keyboard.press("Escape")
            expect(prompt).to_have_count(0)
            operations["other"].append(("프로필 분리", "Copy for this agent", initial, "취소로 닫힘", "닫힘", focus_label(page)))
    finally:
        context.close()


def load_states(browser, origin, out):
    for state in ("loading", "error"):
        context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce", service_workers="block")
        try:
            page = context.new_page()
            requests = {"index": 0, "external": []}
            settings.install(page, origin, settings.fixture(), requests, state=state)
            account_language(page, "en", "light")
            open_settings(page, origin, "en")
            if state == "loading":
                expect(page.get_by_text("Loading MCP settings…", exact=True)).to_be_visible()
                settings.capture(page, out, "loading-en-1440")
                requests["held"].fulfill(json=settings.fixture())
            else:
                expect(page.get_by_role("alert")).to_contain_text("Couldn’t load settings.")
                settings.capture(page, out, "error-en-1440")
                page.get_by_role("button", name="Retry", exact=True).click()
            expect(page.get_by_test_id("mcp-settings")).to_be_visible()
        finally:
            context.close()


def report(out, metrics, operations):
    fit = operations["server_action_rows"] == 1 and operations["pending_status_lines"] == 1 and all(
        result["document"] <= result["viewport"] and not result["issues"] for result in metrics.values())
    dialogs = operations["delete"]
    replace = operations["replace"]
    focus_ok = all(row[1] == LABELS[row[0].split("-")[0]][7] and row[4] == LABELS[row[0].split("-")[0]][6] for row in dialogs)
    focus_ok &= all(row[1] == LABELS[row[0].split("-")[0]][5] and row[3] == LABELS[row[0].split("-")[0]][4] for row in replace)
    before, after, resize_fit = operations["resize"]
    result = lambda ok: "통과" if ok else "미통과"
    lines = [
        "# 조작 결과", "", "## 14번부터 18번", "",
        "| 항목 | 결과 | 근거 |", "| :--- | :--- | :--- |",
        f"| 14 | {result(focus_ok)} | 삭제 확인과 값 교체의 시작 및 복귀 초점 |",
        f"| 15 | {result(all(row[3] for row in dialogs))} | 삭제 확인에서 Tab 세 번 후 내부 초점 확인, Enter 및 Esc로 닫기 |",
        f"| 16 | {result(fit)} | 창·문서 폭과 버튼의 여러 줄 텍스트 및 클리핑 측정. 아래 실측 참조 |",
        "| 17 | 통과 | MCP 설정 로딩과 503 오류를 캡처하고 Retry 후 목록 복구 확인 |",
        f"| 18 | {result(resize_fit and abs(before - after) <= 1)} | 1440 → 360 → 1440에서 작성 중 이름 유지. 설정 스크롤 {before:g} → {after:g}px |",
        "", "## 대화상자와 줄 안 편집", "",
        "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ]
    for suffix, initial, _, _, restored in dialogs:
        lines.append(f"| 삭제 확인 ({suffix}) | 삭제 단추 | {initial} | 취소 단추로 닫힘 | 닫힘 | {restored} |")
    for suffix, initial, stays, restored in replace:
        lines.append(f"| 비밀값 교체 ({suffix}) | 값 교체 단추 | {initial} | {'입력 유지' if stays else '편집 닫힘'} | 편집 취소 | {restored} |")
    for row in operations["other"]:
        lines.append("| " + " | ".join(row) + " |")
    lines += [
        "", "## 측정과 실행", "",
        "- 기존 설정 창, 목록과 상세, 필드, 단추, 대화상자 및 토큰을 재사용했다. CSS와 px 값 추가 없음.",
        f"- 1440px 영어 서버 편집의 Test, Revert, Delete가 차지한 행 수 {operations['server_action_rows']}",
        f"- 360px 영어 서버 목록의 적용 대기 배지에서 텍스트 줄 수 {operations['pending_status_lines']}",
        f"- 실행 `python3 -P scripts/visual-check/mcp_i18n.py --output {out}`",
        f"- 캡처와 이 보고서 `{out}`",
    ]
    for suffix, _, tabs, _, _ in dialogs:
        lines.append(f"- 삭제 확인 Tab 순서 ({suffix}) {', '.join(tabs)}")
    for name, item in metrics.items():
        lines.append(f"- {name} 문서 {item['document']}/{item['viewport']}px, 경계나 줄이 맞지 않은 조작 요소 {', '.join(item['issues']) or '없음'}")
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    out = parser.parse_args().output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    server, origin = settings.serve()
    metrics, operations = {}, {"delete": [], "replace": [], "other": []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for locale, width in (("ko", 1440), ("en", 1440), ("en", 360)):
                    run_surfaces(browser, origin, out, locale, width, metrics, operations)
                load_states(browser, origin, out)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    report(out, metrics, operations)


if __name__ == "__main__":
    main()

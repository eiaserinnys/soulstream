#!/usr/bin/env python3
"""Open the real settings tabs against local API fixtures and capture their localized states."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import DIALOG, ROOT, LocaleFake, capture, focus, page_for, start_vite
from settings_toolbar_fakes import flow, open_settings, provider, quota, soon

DETAIL = ".config-detail"
DICT = ROOT / "packages/i18n/src/locales"
EMAIL = "engineering-team-account@example.test"
GIT_PATH = "/api/nodes/eiaserinnys/git"
IDENTITY = {"name": "Example Engineering", "email": "engineering@example.test"}
REPO = "internal-dashboard-and-release-automation"
GIT = {
    "identity": IDENTITY,
    "ssh": {
        "state": "ready", "key_path": "/home/example/.ssh/id_ed25519",
        "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyExampleKeyExampleKey example@node",
    },
    "projects": {
        "state": "ready", "root": "/home/example/workspace/.projects",
        "repos": [{"name": REPO, "origin_url": f"git@example.test:team/{REPO}.git",
                   "branch": "work/release-settings", "dirty": True}],
    },
    "clone": None,
}
LOGIN = {
    "login_id": "visual-claude-login", "account_id": None, "state": "url_ready",
    "auth_url": "https://example.test/claude-sign-in", "error": None,
}


def timestamp(**offset):
    return (datetime.now(timezone.utc) + timedelta(**offset)).isoformat()


def account(account_id, email, priority):
    return {
        "id": account_id, "email": email, "priority": priority, "plan": "Max", "enabled": True,
        "auth_state": "ok", "source": "local", "observed_at": timestamp(minutes=-4),
        "blocked": None, "active_sessions": 3 if priority == 1 else 0,
        "usage": {
            "five_hour": {"used_percent": 100 if priority == 1 else 19.4, "resets_at": timestamp(minutes=37)},
            "seven_day": {"used_percent": 56.7, "resets_at": timestamp(days=3)},
            "fable_weekly": None,
        },
    }


def pool(accounts):
    return {
        "mode": "pool", "accounts": accounts, "fable_pool": None,
        "pool": {"available_count": len(accounts), "total_count": len(accounts),
                 "best_weekly_remaining_percent": 43.3, "best_weekly_resets_at": timestamp(days=3),
                 "earliest_available_at": None},
    }


class AccountsFake(LocaleFake):
    def __init__(self, locale):
        super().__init__()
        self.preferences["language"] = locale
        self.local_accounts = pool([account("first", EMAIL, 1), account("second", "backup@example.test", 2)])
        self.central_accounts = pool([account("shared", "shared@example.test", 1)])
        self.git_state = "loading"
        self.held_git = None
        self.flows["codex"] = flow("codex", "url_ready", auth_url="https://example.test/codex",
                                   user_code="WXYZ-1234", expires_at=soon())

    def node_list(self):
        return [{**node, "capabilities": {"node_git_setup_v1": True}} for node in super().node_list()]

    def usage_body(self):
        summary = super().usage_body()
        node = summary["nodes"][0]
        node["fetchedAt"] = timestamp(minutes=-6)
        node["providers"]["claude"]["mode"] = "pool"
        if not self.agy["enabled"]:
            node["providers"]["antigravity"] = None
        node["providers"]["opencode_go"] = provider("auto", [
            quota("opencode:short", "5h", "5h", 26),
            quota("opencode:monthly", "monthly", "monthly", 70),
        ])
        return summary

    def handle(self, route):
        req = route.request
        path = urlsplit(req.url).path
        if path == GIT_PATH:
            if self.git_state == "loading":
                self.held_git = route
                return
            return route.fulfill(json=GIT)
        if path == GIT_PATH + "/ssh-check":
            return route.fulfill(json={"ok": True, "reason": "connected", "output": "Authentication succeeded."})
        if path == "/api/claude-auth/central/accounts":
            return route.fulfill(json=self.central_accounts)
        if path.endswith("/claude-auth/accounts"):
            return route.fulfill(json=self.local_accounts)
        if path.endswith("/claude-auth/logins"):
            return route.fulfill(status=202, json={**LOGIN, "expires_at": soon()})
        if path.endswith("/claude-auth/logins/visual-claude-login"):
            return route.fulfill(json={**LOGIN, "state": "cancelled" if req.method == "DELETE" else "url_ready"})
        if path == "/api/admin/settings/persistent-defaults":
            return route.fulfill(json={"value": {"model_preset": "visual-standard", "fallback_models": []}, "source": "settings", "version": 1})
        if path.endswith("/model-presets"):
            return route.fulfill(json={"model_presets": [
                {"id": "visual-standard", "label": "Standard", "backend": "codex", "available": True,
                 "reason": None, "reason_label": None, "resets_at": None, "usage_warning": False},
                {"id": "visual-extended", "label": "Extended", "backend": "codex", "available": False,
                 "reason": "limit_rejected", "reason_label": "7일 한도 거부 중", "resets_at": timestamp(days=2),
                 "usage_warning": False},
            ]})
        return super().handle(route)


def choose_tab(page, settings, name):
    label = settings["tabs"][name]["label"]
    dialog = page.locator(DIALOG).first
    back = dialog.get_by_role("button", name=settings["allSettings"], exact=True)
    if back.is_visible():
        back.click()
    dialog.get_by_role("navigation").get_by_role("button", name=label, exact=True).click()
    expect(page.locator(f"{DETAIL} .config-detail-heading h2")).to_have_text(label)


def geometry(page):
    return page.evaluate("""() => {
      const panel = document.querySelector(".config-detail");
      const panelBox = panel.getBoundingClientRect();
      const controls = [...panel.querySelectorAll("button, input, [role=switch], [role=combobox]")];
      const visible = (e) => {
        const {visibility, opacity} = getComputedStyle(e);
        return e.getClientRects().length && visibility === "visible" && opacity !== "0"
          && !e.closest('[aria-hidden=true], [inert]');
      };
      const text = [...panel.querySelectorAll(".c724-quota-label-row > span, .c724-account-email, .agy-backend-text p")];
      const clipped = text.filter(visible).flatMap(e => {
        const box = e.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(e);
        const rects = [...range.getClientRects()];
        if (!rects.length || (e.closest('[aria-hidden=true]'))) return [];
        const tooWide = rects.some(r => r.left < panelBox.left - 1 || r.right > panelBox.right + 1
          || r.width > box.width + 1);
        const truncated = tooWide && getComputedStyle(e).textOverflow === "ellipsis";
        return (tooWide && (!truncated || e.classList.contains("c724-quota-reset")) || box.width < 2)
          ? [e.textContent] : [];
      });
      return {
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        detail: panel.clientWidth, content: panel.scrollWidth,
        outside: controls.filter(visible).flatMap(e => {
          const r = e.getBoundingClientRect();
          return r.left < panelBox.left - 1 || r.right > panelBox.right + 1
            ? [e.getAttribute("aria-label") || e.textContent] : [];
        }),
        clipped,
        resetLines: [...panel.querySelectorAll('.c724-quota-reset:not([aria-hidden])')].filter(visible).map(e => {
          const range = document.createRange();
          range.selectNodeContents(e);
          return range.getClientRects().length;
        }),
      };
    }""")


def focus_state(page):
    state = focus(page)
    state["label"] = " ".join((state["label"] or "").split())[:90]
    state["visible"] = page.evaluate("""() => {
      const active = document.activeElement;
      if (!active || active === document.body) return false;
      const r = active.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth
        && r.bottom > 0 && r.top < innerHeight && !active.closest('[aria-hidden=true], [inert]');
    }""")
    return state


def record(page, output, locale, width, scene, results):
    name = f"{locale}-{scene}-{width}.png"
    assert "accounts." not in page.locator(DETAIL).inner_text(), name
    page.evaluate("() => document.fonts.ready")
    capture(page, output, name)
    results[name] = geometry(page)


def account_views(page, fake, settings, text, out, locale, width, results, actions):
    choose_tab(page, settings, "nodes")
    panel = page.get_by_test_id("node-panel-body")
    central = panel.get_by_test_id("claude-central-pool-header")
    expect(central).to_contain_text(text["claude"]["centralPool"])
    node = panel.get_by_test_id("node-card").first
    expand = node.get_by_role("button", name=text["nodes"]["expand"], exact=True)
    expand.press("Enter")
    actions["node_expand"] = focus_state(page)
    providers = node.get_by_test_id("node-providers-panel")
    expect(providers.locator('[data-provider-id="codex"]')).to_contain_text(text["common"]["unconfigured"])
    record(page, out, locale, width, "node-providers", results)

    pool_row = providers.get_by_test_id("claude-pool-row")
    expand_pool = pool_row.get_by_role("button", name=text["claude"]["expandAccounts"])
    expand_pool.click()
    first = pool_row.locator('[data-account-id="first"]')
    expect(first).to_contain_text(EMAIL)
    expect(first.get_by_text(text["quota"]["short"], exact=True)).to_be_visible()
    expect(first.get_by_text("100%", exact=True)).to_be_visible()
    reset_at = fake.local_accounts["accounts"][0]["usage"]["five_hour"]["resets_at"]
    reset = page.evaluate("""([locale, reset]) => new Intl.DateTimeFormat(locale, {
      hour: locale === "ko" ? "2-digit" : "numeric", minute: "2-digit",
      ...(locale === "ko" ? { hour12: false } : {}),
    }).format(new Date(reset))""", [locale, reset_at])
    expect(first.locator(".c724-quota-reset").first).to_have_text(text["quota"]["resetAt"].replace("{{time}}", reset))
    first.scroll_into_view_if_needed()
    record(page, out, locale, width, "claude-accounts", results)

    add = pool_row.get_by_role("button", name=text["claude"]["addAccount"])
    add.press("Enter")
    sheet = page.get_by_test_id("claude-login-sheet")
    field = sheet.get_by_role("textbox", name=text["claude"]["verificationCode"])
    expect(field).to_be_visible()
    sheet.scroll_into_view_if_needed()
    actions["claude_open"] = focus_state(page)
    record(page, out, locale, width, "claude-login", results)
    field.press("Tab")
    actions["claude_tab"] = focus_state(page)
    field.press("Escape")
    expect(sheet).to_have_count(0)
    actions["claude_close"] = focus_state(page)

    if locale == "en" and width == 1440:
        delete = first.get_by_role("button", name=text["claude"]["deleteAccount"])
        delete.press("Enter")
        confirmation = first.get_by_test_id("delete-confirm-first")
        expect(confirmation).to_contain_text(text["claude"]["deleteNodeConfirm"])
        actions["delete_open"] = focus_state(page)
        cancel = confirmation.get_by_role("button", name=text["common"]["cancel"])
        cancel.press("Enter")
        expect(confirmation).to_have_count(0)
        actions["delete_close"] = focus_state(page)


def agent_view(page, settings, text, out, locale, width, results, actions):
    choose_tab(page, settings, "coding_agents")
    pane = page.get_by_test_id("coding-agents-tab")
    codex = pane.locator('[data-provider-id="codex"]')
    expect(codex).to_contain_text(text["common"]["unconfigured"])
    switch = page.get_by_test_id("antigravity-backend-switch")
    expect(switch).to_be_visible()
    record(page, out, locale, width, "coding-agents", results)
    if locale == "en" and width == 1440:
        switch.press("Space")
        consent = page.get_by_role("dialog", name=text["antigravity"]["title"])
        expect(consent).to_be_visible()
        actions["consent_open"] = focus_state(page)
        field = consent.get_by_role("textbox")
        field.press("Enter")
        expect(consent).to_be_visible()
        field.press("Escape")
        expect(consent).to_have_count(0)
        actions["consent_close"] = focus_state(page)

        connect = codex.get_by_role("button", name=text["common"]["connect"])
        connect.press("Enter")
        sheet = page.get_by_test_id("agent-login-sheet")
        expect(sheet.get_by_test_id("agent-login-user-code")).to_have_text("WXYZ-1234")
        actions["codex_open"] = focus_state(page)
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        actions["codex_close"] = focus_state(page)


def model_view(page, settings, text, jobs, out, locale, width, results, actions):
    choose_tab(page, settings, "persistent_defaults")
    field = page.get_by_role("combobox", name=jobs["common"]["defaultModel"], exact=True)
    expect(field).to_be_enabled()
    field.press("Enter")
    menu = page.get_by_role("listbox")
    expect(menu.get_by_role("option", name="Standard", exact=True)).to_be_visible()
    expect(menu.get_by_role("option").filter(has_text="Extended")).to_contain_text(text["quota"]["resets"].split("{{")[0].strip() if locale == "en" else "해제")
    actions["model_open"] = focus_state(page)
    record(page, out, locale, width, "model-picker", results)
    page.keyboard.press("Escape")
    expect(menu).to_have_count(0)
    actions["model_close"] = focus_state(page)


def git_views(page, fake, settings, text, out, locale, width, results, actions):
    choose_tab(page, settings, "git_repos")
    detail = page.locator(DETAIL)
    expect(detail.get_by_role("status", name=text["common"]["loading"])).to_be_visible()
    record(page, out, locale, width, "git-loading", results)
    assert fake.held_git is not None
    fake.held_git.fulfill(status=503, json={"code": "node_command_failed"})
    error = detail.get_by_role("alert").filter(has_text=text["git"]["loadError"])
    expect(error).to_be_visible()
    record(page, out, locale, width, "git-error", results)

    fake.git_state = "ready"
    retry = error.get_by_role("button", name=text["git"]["reload"])
    retry.press("Enter")
    name = detail.get_by_role("textbox", name=text["git"]["name"], exact=True)
    expect(name).to_have_value(IDENTITY["name"])
    actions["git_retry"] = focus_state(page)
    expect(detail).to_contain_text(text["git"]["identity"])
    expect(detail).to_contain_text(text["git"]["sshKey"])
    expect(detail).to_contain_text(text["git"]["projectRepos"])
    repo = detail.get_by_text(REPO, exact=True)
    repo.scroll_into_view_if_needed()
    expect(repo).to_be_in_viewport()
    record(page, out, locale, width, "git-repositories", results)
    if locale == "en" and width == 1440:
        name.fill("Unsubmitted identity")
        name.press("Tab")
        actions["git_tab"] = focus_state(page)
        scroll = "element => element.scrollTop"
        detail.evaluate("element => { element.scrollTop = 150; }")
        before = detail.evaluate(scroll)
        page.set_viewport_size({"width": 360, "height": 800})
        expect(name).to_have_value("Unsubmitted identity")
        narrow = detail.evaluate(scroll)
        page.set_viewport_size({"width": 1440, "height": 900})
        expect(name).to_have_value("Unsubmitted identity")
        actions["resize"] = [before, narrow, detail.evaluate(scroll)]
        detail.get_by_role("button", name=text["git"]["checkConnection"]).press("Enter")
        technical = detail.get_by_text(text["git"]["details"], exact=True)
        technical.press("Enter")
        expect(detail.get_by_text("Authentication succeeded.", exact=True)).to_be_visible()
        actions["ssh_details"] = focus_state(page)


def run_case(browser, base, output, locale, width):
    settings = json.loads((DICT / locale / "settings.json").read_text(encoding="utf8"))
    text = json.loads((DICT / locale / "accounts.json").read_text(encoding="utf8"))
    jobs = json.loads((DICT / locale / "jobs.json").read_text(encoding="utf8"))
    start_locale = "ko" if locale == "en" and width == 1440 else locale
    context, page, fake = page_for(browser, base, width, start_locale, AccountsFake(start_locale))
    actions, results = {}, {}
    try:
        open_settings(page)
        actions["settings_open"] = focus_state(page)
        if start_locale != locale:
            page.get_by_role("combobox", name="언어", exact=True).click()
            page.get_by_role("option", name="English", exact=True).click()
        expect(page.locator("html")).to_have_attribute("lang", locale)
        account_views(page, fake, settings, text, output, locale, width, results, actions)
        agent_view(page, settings, text, output, locale, width, results, actions)
        model_view(page, settings, text, jobs, output, locale, width, results, actions)
        git_views(page, fake, settings, text, output, locale, width, results, actions)
        page.keyboard.press("Escape")
        expect(page.locator(DIALOG)).to_have_count(0)
        actions["settings_close"] = focus_state(page)
        hashes = {hashlib.sha256((output / name).read_bytes()).hexdigest() for name in results}
        assert len(hashes) == len(results), "Different scenes produced identical captures."
        return {"observations": actions, "geometry": results}
    finally:
        context.close()


def write_operations(output, results):
    op = results["en-1440"]["observations"]
    reports = {name: data for result in results.values() for name, data in result["geometry"].items()}
    overflow = {
        name: info for name, info in reports.items()
        if info["document"] > info["viewport"] or info["content"] > info["detail"] + 1
        or info["outside"] or info["clipped"] or any(lines != 1 for lines in info["resetLines"])
    }
    def label(key):
        return op[key]["label"]

    def grade(ok):
        return "통과" if ok else "관찰 사항 있음"

    focused = op["claude_open"]["label"] == "Claude verification code" and all(op[key]["visible"] for key in (
        "settings_open", "node_expand", "claude_open", "claude_close", "delete_close",
        "consent_open", "consent_close", "codex_open", "codex_close", "model_close", "git_retry",
    ))
    tabbed = all(op[key]["visible"] and op[key]["inside"] for key in ("claude_tab", "git_tab"))
    resized = len(set(op["resize"])) == 1
    lines = [
        "# 조작 결과", "", "## 14번부터 18번", "",
        "| 항목 | 결과 | 근거 |", "| :--- | :--- | :--- |",
        f"| 14 | {grade(focused)} | 노드 펼치기 {label('node_expand')}, Git 재시도 뒤 {label('git_retry')}. 나머지 초점은 아래 표 참조 |",
        f"| 15 | {grade(tabbed)} | Claude 인증 코드 다음 {label('claude_tab')}, Git 이름 다음 {label('git_tab')}. Esc로 로그인·동의·모델 목록·설정을 닫음 |",
        f"| 16 | {grade(not overflow)} | {len(reports)}장. 패널과 문서 폭, 컨트롤 경계, 글 영역, 한도 재설정 시각의 줄 수를 측정 |",
        "| 17 | 통과 | Git 읽기 응답을 보류해 로딩을 확인한 뒤 503을 반환. 재시도로 Git 설정을 복구 |",
        f"| 18 | {grade(resized)} | Git 입력값 유지. 1440 → 360 → 1440에서 상세 스크롤 {op['resize']}px |",
        "", "## 대화상자와 줄 안 편집", "",
        "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
        f"| 설정 창 | 도구 막대의 설정 | {label('settings_open')} | 현재 단추 실행 | 창 닫힘 | {label('settings_close')} |",
        f"| Claude 로그인 | 계정 추가에서 Enter | {label('claude_open')} | 계정 추가로 시트 열기 | 시트 닫힘 | {label('claude_close')} |",
        f"| Claude 삭제 확인줄 | 계정 삭제에서 Enter | {label('delete_open')} | 취소에서 확인줄 닫힘 | 측정 안 함 | {label('delete_close')} |",
        f"| Codex 로그인 | 연결에서 Enter | {label('codex_open')} | 시트 열림 | 시트 닫힘 | {label('codex_close')} |",
        f"| Antigravity 동의 | 스위치에서 Space | {label('consent_open')} | 승인 값이 비어 있으면 열림 유지 | 동의 창 닫힘 | {label('consent_close')} |",
        f"| 모델 고르기 | 기본 모델에서 Enter | {label('model_open')} | 모델 목록 열림 | 목록 닫힘 | {label('model_close')} |",
        f"| SSH 기술 상세 | 연결 확인 후 상세에서 Enter | {label('ssh_details')} | 상세 펼침 | 인라인 펼침 | 상세 요약에 유지 |",
        "", "## 측정과 실행", "",
        "- 기존 설정 창, 목록·상세, 계정 행, 입력과 단추, 한도 표시를 사용했습니다. 추가 CSS와 픽셀 값은 없습니다.",
        "- 실제 설정 창에서 API 응답만 대체했습니다. 긴 계정 이메일, 저장소명, 사용량 상한과 재설정 시각을 포함했습니다.",
        f"- 실행 `python3 -P scripts/visual-check/accounts_i18n.py --output {output}`",
        f"- 산출물 `{output}`",
    ]
    lines.extend(f"- {name} `{json.dumps(data, ensure_ascii=False)}`" for name, data in overflow.items())
    (output / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf8")


def main():
    cases = {"ko-1440": ("ko", 1440), "en-1440": ("en", 1440), "en-360": ("en", 360)}
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--only", choices=cases)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    proc, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for case in (args.only,) if args.only else cases:
                print(f"Capturing {case}", flush=True)
                result = run_case(browser, base, args.output, *cases[case])
                (args.output / f"{case}.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=20)
    if all((args.output / f"{case}.json").is_file() for case in cases):
        results = {case: json.loads((args.output / f"{case}.json").read_text(encoding="utf8")) for case in cases}
        write_operations(args.output, results)


if __name__ == "__main__":
    main()

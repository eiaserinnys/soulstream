#!/usr/bin/env python3
"""Capture the PAS first window, the merged settings window, the coding agents tab, and the toolbar with fake responses.

카드 #1787 U17. 서버 PR(U18a 로그인, U18b 기본 PAS)이 없어도 약속 문서의 모양대로 가짜 응답을 내려 화면을 찍는다.
기준선(merge-base 빌드)이 있는 화면은 같은 이름 규칙으로 baseline- 접두어를 붙여 함께 찍는다.
일회용 코드와 인증 주소는 모두 가짜 값이다.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "unified-dashboard" / "dist"
ATOM_URL = "https://atom.example.invalid"
FAKE_USER_CODE = "WXYZ-1234"
FAKE_PASTED_CODE = "pasted-fake-code-777"
SESSION_ID = "components-session"
INDEX: list[tuple[str, int, str]] = []
CHECKS: list[dict] = []


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/components" or path.startswith("/persistent"):
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, format, *args):
        pass


def serve(directory):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


SETTINGS = {
    "default_model": {"model_preset": "sample-sol", "reasoning_effort": None}, "fallback_models": [],
    "show_generation_separator": True, "show_character": False, "animate_character": False, "show_jev_candidates": True,
    "show_work_details": False, "show_turn_usage": True, "turn_usage_mode": "collapsed",
}
PAS = {
    "session_id": SESSION_ID, "display_name": "검수 PAS", "node_id": "eiaserinnys", "folder_id": None, "agent_id": "roselin",
    "agent_name": "로젤린", "persistent": True, "settings": SETTINGS,
    "runtime": {"current_model": {"model_preset": "sample-sol", "reasoning_effort": None, "model": "sample-sol-model"}, "pending": None},
}
SUMMARY = {"agentSessionId": SESSION_ID, "displayName": "검수 PAS", "status": "running", "eventCount": 3, "agentId": "roselin", "agentName": "로젤린", "nodeId": "eiaserinnys", "backend": "codex", "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z"}
NODE = {"nodeId": "eiaserinnys", "host": "localhost", "port": 3105, "status": "connected", "capabilities": {}, "connectedAt": 0, "sessionCount": 1}
MODEL_PRESETS = [{"id": "sample-sol", "label": "Sol", "backend": "codex", "available": True, "reason": None, "reason_label": None, "resets_at": None, "usage_warning": False}]
CREATE_DEFAULTS = {"node_id": "eiaserinnys", "preferred_agent_id": "roselin", "settings": SETTINGS, "initial_instruction": "새 영구 에이전트 세션입니다."}
UNAVAILABLE = "쓸 수 있는 모델이 없습니다. 코딩 에이전트를 먼저 연결해 주십시오."


def quota(qid, label, window, percent):
    return {"id": qid, "label": label, "window": window, "model": None, "remainingPercent": percent, "resetAt": 1_900_000_000}


def provider(status, quotas=(), **extra):
    base = {"status": status, "weeklyRemainingPercent": None, "weeklyResetAt": None, "shortRemainingPercent": None, "shortResetAt": None, "quotas": list(quotas)}
    if quotas:
        base.update(weeklyRemainingPercent=quotas[0]["remainingPercent"], weeklyResetAt=quotas[0]["resetAt"])
    return {**base, **extra}


def usage_summary(login_supported: bool):
    """Codex는 연결 안 됨, Antigravity는 연결됨. login_supported는 서버가 더하는 새 필드다."""
    extra = {"login_supported": True} if login_supported else {"login_supported": False}
    return {
        "generatedAt": "2026-11-24T00:00:00Z", "collectedAt": None,
        "nodes": [{"nodeId": "eiaserinnys", "fetchedAt": "2026-11-24T00:00:00Z", "stale": False, "staleSince": None, "providers": {
            "claude": provider("auto", [quota("claude:weekly", "7일", "7d", 66)], mode="legacy"),
            "opencode_go": None,
            "codex": provider("not_configured", **extra),
            "antigravity": provider("auto", [quota("antigravity:weekly", "7일", "7d", 56)], **extra),
        }}],
    }


def soon():
    """Codex 기기 코드의 만료 시각. 열 때마다 14분 뒤로 둔다."""
    return (datetime.now(timezone.utc) + timedelta(minutes=14)).strftime("%Y-%m-%dT%H:%M:%SZ")


def flow(provider_id, state, **patch):
    return {"login_id": f"fake-login-{provider_id}", "provider": provider_id, "state": state, "auth_url": None, "user_code": None,
            "expects_code": provider_id == "antigravity", "expires_at": None, "error": None, **patch}


class Fake:
    """한 페이지가 부르는 API의 가짜 응답. 장면별 값은 속성으로 바꾼다."""

    def __init__(self, atom=True, sessions="one", login_supported=True):
        self.atom = atom
        self.sessions = sessions  # one | two | manual | unavailable | bootstrap
        self.login_supported = login_supported
        self.flows: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.held_bootstrap = None
        self.login_posts = 0

    def handle(self, route):
        request = route.request
        path = urlsplit(request.url).path
        method = request.method
        self.calls.append((method, path))
        if path == "/api/health":
            return route.fulfill(json={"healthy": True, "ready": True, "draining": False, "build_id": "dev"})
        if path == "/api/status":
            return route.fulfill(json={"status": "ok", "atom_public_url": ATOM_URL if self.atom else None})
        if path == "/api/auth/status":
            return route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True}})
        if path == "/api/auth/config":
            return route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
        if path == "/api/persistent-sessions" and method == "GET":
            defaults = {**CREATE_DEFAULTS, "unavailable_reason": UNAVAILABLE if self.sessions == "unavailable" else None}
            if self.sessions in ("unavailable", "bootstrap"):
                defaults["bootstrap_enabled"] = True
            sessions = {"one": [PAS], "two": [PAS, {**PAS, "session_id": "components-session-2", "display_name": "둘째 PAS"}]}.get(self.sessions, [])
            return route.fulfill(json={"sessions": sessions, "total": len(sessions), "create_defaults": defaults})
        if path == "/api/persistent-sessions/bootstrap" and method == "POST":
            self.held_bootstrap = route  # 만드는 중 화면을 찍는 동안 응답하지 않는다.
            return
        if path == f"/api/persistent-sessions/{SESSION_ID}":
            return route.fulfill(json={"session": PAS})
        if path == f"/api/persistent-sessions/{SESSION_ID}/instructions":
            return route.fulfill(json={"instructions": [{"id": "i-1", "text": "결정에 필요한 근거만 간결하게 알려 줍니다.", "source_turns": ["T195"], "created_at": "2026-10-06T10:00:00Z", "updated_at": "2026-10-06T11:00:00Z", "origin": "agent"}]})
        if path == "/api/sessions":
            return route.fulfill(json={"sessions": [SUMMARY], "total": 1})
        if path == "/api/nodes":
            return route.fulfill(json={"nodes": [NODE]})
        if path == "/api/nodes/stream":
            return route.fulfill(content_type="text/event-stream", body=f"event: snapshot\ndata: {json.dumps([NODE])}\n\n")
        if path == "/api/sessions/stream":
            return route.fulfill(content_type="text/event-stream", body=f"event: session_list\ndata: {json.dumps({'type': 'session_list', 'sessions': [SUMMARY], 'total': 1})}\n\n")
        if path.endswith("/events"):
            return route.fulfill(content_type="text/event-stream", body='event: history_sync\ndata: {"type":"history_sync","last_event_id":3,"is_live":true,"status":"running"}\n\n')
        if path.endswith("/timeline"):
            return route.fulfill(json={"messages": [], "next_cursor": None})
        if path.endswith("/story"):
            return route.fulfill(json={"highlight": None, "narrative": "세션 줄거리 예시입니다.", "unfolded_turn_summaries": [], "narrative_through_event_id": 0, "fold_count": 0, "updated_at": None})
        if path.endswith("/model-presets"):
            return route.fulfill(json={"model_presets": MODEL_PRESETS})
        if path == "/api/usage/summary":
            return route.fulfill(json=usage_summary(self.login_supported))
        if path == "/api/config/settings":
            return route.fulfill(json={"categories": []})
        if path.endswith("/claude-auth/accounts"):
            return route.fulfill(json={"mode": "legacy", "accounts": [], "pool": None, "fable_pool": None})
        if path.endswith("/claude-auth/status"):
            return route.fulfill(json={"has_token": True})
        if path.endswith("/claude-auth/profile"):
            return route.fulfill(json={"account": {"email": "qa@example.test", "display_name": "QA", "has_claude_max": True}})
        if path.startswith("/api/claude-auth/central"):
            return route.fulfill(json={"mode": "pool", "accounts": [], "pool": None, "fable_pool": None, "default_receive": True, "nodes": {}, "effective": []})
        if path == "/cogito/briefs":
            return route.fulfill(json={"nodes": []})
        parts = path.split("/")
        if "agent-logins" in parts:
            return self.agent_login(route, method, parts)
        return route.continue_()

    def agent_login(self, route, method, parts):
        tail = parts[parts.index("agent-logins") + 1:]
        if method == "POST" and len(tail) == 1:  # /agent-logins/<provider>
            self.login_posts += 1
            current = self.flows[tail[0]]
            return route.fulfill(status=202, json=current)
        provider_id = next(key for key, value in self.flows.items() if value["login_id"] == tail[0])
        if method == "POST" and tail[-1] == "code":
            self.flows[provider_id] = self.after_code.get(provider_id, flow(provider_id, "verifying"))
            return route.fulfill(json=self.flows[provider_id])
        if method == "DELETE":
            return route.fulfill(json={**self.flows[provider_id], "state": "cancelled"})
        return route.fulfill(json=self.flows[provider_id])

    after_code: dict[str, dict] = {}


def new_page(browser, base, fake, width, height=900, theme="dark", preferences=None):
    context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme, reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
    page = context.new_page()
    init = f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');"
    if preferences is not None:
        init += f"localStorage.setItem('soulstream-pas-device:qa@example.test', {json.dumps(json.dumps(preferences))});"
    page.add_init_script(init)
    page.route("**/api/**", fake.handle)
    page.route("**/cogito/**", fake.handle)
    return context, page


def shot(page, out: Path, name: str, width: int, state: str, locator=None):
    target = locator if locator is not None else page
    target.screenshot(path=str(out / name), animations="disabled")
    INDEX.append((name, width, state))


def toolbar_metrics(page, selector):
    return page.evaluate("""(selector) => {
        const bar = document.querySelector(selector);
        const actions = bar.querySelector('.dashboard-toolbar-actions');
        const buttons = [...actions.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, right: Math.round(r.right * 10) / 10 }; });
        return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, buttons };
    }""", selector)


def check(label, condition, detail):
    CHECKS.append({"check": label, "ok": bool(condition), "detail": detail})
    assert condition, f"{label}: {json.dumps(detail, ensure_ascii=False)}"


def capture_toolbars(browser, base, out: Path, prefix: str, atom_expected: bool):
    """PAS 창 툴바 360, 768, 1280과 기존 대시보드 툴바 360, 1280. atom 단추 유무와 넘침, 단추 크기를 잰다."""
    for width in (360, 768, 1280):
        # 영구 세션이 둘이면 세션 바꾸기 단추까지 보여 가장 단추가 많은 경우가 된다.
        fake = Fake(atom=True, sessions="two")
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        metrics = toolbar_metrics(page, '[data-testid="v3-global-toolbar"]')
        atom_buttons = [b for b in metrics["buttons"] if b["label"] == "atom 열기"]
        if prefix == "":
            check(f"PAS 창 툴바 {width}px atom 단추 {'있음' if atom_expected else '없음'}", bool(atom_buttons) == atom_expected, metrics)
            check(f"PAS 창 툴바 {width}px 가로 넘침 없음", metrics["scrollWidth"] <= metrics["clientWidth"] and metrics["docScrollWidth"] <= metrics["innerWidth"], metrics)
            check(f"PAS 창 툴바 {width}px 단추 40x40 이상", all(b["width"] >= 40 and b["height"] >= 40 for b in metrics["buttons"]), metrics)
        shot(page, out, f"{prefix}pas-toolbar-{width}.png", width, f"PAS 창 툴바, atom {'있음' if atom_expected else '없음'}", page.get_by_test_id("v3-global-toolbar"))
        context.close()
    for width in (360, 1280):
        fake = Fake(atom=True)
        context, page = new_page(browser, base, fake, width, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
        page.goto(base + "/", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        metrics = toolbar_metrics(page, '[data-testid="v3-global-toolbar"]')
        if prefix == "":
            check(f"대시보드 툴바 {width}px atom 단추 {'있음' if atom_expected else '없음'}", bool([b for b in metrics["buttons"] if b["label"] == "atom 열기"]) == atom_expected, metrics)
            check(f"대시보드 툴바 {width}px 가로 넘침 없음", metrics["scrollWidth"] <= metrics["clientWidth"] and metrics["docScrollWidth"] <= metrics["innerWidth"], metrics)
            check(f"대시보드 툴바 {width}px 단추 40x40 이상", all(b["width"] >= 40 and b["height"] >= 40 for b in metrics["buttons"]), metrics)
        shot(page, out, f"{prefix}dashboard-toolbar-{width}.png", width, "기존 대시보드 툴바", page.get_by_test_id("v3-global-toolbar"))
        context.close()


def listen(page, sink):
    page.on("console", lambda message: sink.append(message.text))
    page.on("pageerror", lambda error: sink.append(str(error)))


def assert_no_secret_output(sink, label):
    leaked = [line for line in sink if FAKE_USER_CODE in line or FAKE_PASTED_CODE in line or "auth.example.invalid" in line]
    check(f"{label}: 일회용 코드, 인증 주소, 붙여 넣은 코드가 콘솔에 없음", not leaked, {"lines": len(sink)})


def open_settings(page):
    page.get_by_role("button", name="서버 설정").click()
    expect(page.locator('[data-slot="dialog-popup"]')).to_be_visible(timeout=15000)


def capture_settings_and_logins(browser, base, out: Path):
    """설정창 persistent 탭(PAS를 고른 채), coding_agents 탭, 로그인 시트 각 상태."""
    width = 1280
    fake = Fake(atom=True)
    fake.flows = {
        "codex": flow("codex", "url_ready", auth_url="https://auth.example.invalid/codex/device", user_code=FAKE_USER_CODE, expires_at=soon()),
        "antigravity": flow("antigravity", "url_ready", auth_url="https://auth.example.invalid/antigravity/oauth"),
    }
    fake.after_code = {"antigravity": flow("antigravity", "verifying")}
    context, page = new_page(browser, base, fake, width)
    sink: list[str] = []
    listen(page, sink)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    dialog = page.locator('[data-slot="dialog-popup"]')
    tab = page.get_by_test_id("persistent-sessions-tab")
    expect(tab).to_be_visible(timeout=15000)
    sections = page.get_by_test_id("persistent-session-settings-sections")
    expect(sections).to_be_visible(timeout=15000)
    labels = sections.locator("> section").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    check("설정창 persistent 탭: 요청한 PAS를 고른 채 다섯 절이 모두 보임", labels == ["지속 지시", "계정과 모델", "표시와 모션", "기록", "세션 스토리"], labels)
    check("설정창 persistent 탭: 새 세션 양식이 아님", tab.get_by_text("세션 추가").count() == 0, "세션 추가 단추 없음")
    page.wait_for_timeout(500)
    shot(page, out, "settings-persistent-top-1280.png", width, "설정창 영구 세션 탭, PAS를 고른 채 열림(위쪽)", dialog)
    page.locator(".config-detail").evaluate("e => { e.scrollTop = e.scrollHeight; }")
    page.wait_for_timeout(300)
    shot(page, out, "settings-persistent-bottom-1280.png", width, "설정창 영구 세션 탭(아래쪽: 기록과 세션 스토리)", dialog)
    dialog.get_by_role("button", name="완료").click()
    expect(dialog).to_have_count(0)
    check("설정창을 닫으면 PAS 창에 그대로 있음", page.url.endswith(f"/persistent/{SESSION_ID}"), page.url)

    open_settings(page)
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트").click()
    expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
    expect(page.get_by_test_id("agent-login-button-codex")).to_have_text("연결", timeout=15000)
    expect(page.get_by_test_id("agent-login-button-antigravity")).to_have_text("다시 연결")
    page.wait_for_timeout(400)
    shot(page, out, "settings-coding-agents-1280.png", width, "코딩 에이전트 탭: Codex 연결 안 됨(연결), Antigravity 연결됨(다시 연결)", dialog)

    # Codex: 주소 열기 단추, 고정폭 코드, 복사, 남은 시간
    page.get_by_test_id("agent-login-button-codex").click()
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_have_text(FAKE_USER_CODE, timeout=10000)
    link = sheet.get_by_role("link", name="주소 열기")
    check("Codex 시트: 주소 열기가 새 탭, noopener", link.get_attribute("target") == "_blank" and "noopener" in (link.get_attribute("rel") or ""), link.get_attribute("rel"))
    shot(page, out, "login-codex-url-ready-1280.png", width, "로그인 시트 Codex: 주소 열기와 코드", sheet)
    sheet.get_by_role("button", name="취소").click()
    expect(sheet).to_have_count(0)

    # Codex 실패: device_code_disabled
    fake.flows["codex"] = flow("codex", "failed", error={"code": "device_code_disabled", "message": "x"})
    page.get_by_test_id("agent-login-button-codex").click()
    expect(sheet.locator('[role="alert"]')).to_contain_text("ChatGPT 설정의 보안 항목에서 Codex 기기 코드 인증을 켠 뒤 다시 시도해 주세요.", timeout=10000)
    shot(page, out, "login-failed-device-code-1280.png", width, "로그인 시트 실패 device_code_disabled", sheet)
    sheet.get_by_role("button", name="닫기").click()
    expect(sheet).to_have_count(0)

    # Antigravity: 다시 연결은 확인을 한 번 받는다
    posts_at_confirm = fake.login_posts
    page.get_by_test_id("agent-login-button-antigravity").click()
    confirm = page.get_by_test_id("agent-login-confirm-antigravity")
    expect(confirm).to_be_visible()
    page.wait_for_timeout(300)
    check("다시 연결: 확인 전에는 로그인을 시작하지 않음", fake.login_posts == posts_at_confirm, fake.login_posts)
    shot(page, out, "login-antigravity-confirm-1280.png", width, "다시 연결 확인줄", confirm)
    confirm.get_by_role("button", name="다시 연결").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    shot(page, out, "login-antigravity-url-ready-1280.png", width, "로그인 시트 Antigravity: 주소 열기와 코드 입력칸", sheet)
    sheet.get_by_label("Antigravity 인증 코드").fill(FAKE_PASTED_CODE)
    sheet.get_by_role("button", name="제출").click()
    expect(sheet.get_by_text("사용량을 확인하고 있습니다")).to_be_visible(timeout=10000)
    check("제출한 코드는 화면에 남지 않음", FAKE_PASTED_CODE not in page.content(), "DOM에 없음")
    shot(page, out, "login-verifying-1280.png", width, "로그인 시트 확인 중", sheet)
    fake.flows["antigravity"] = flow("antigravity", "done")
    expect(sheet.get_by_text("연결되었습니다")).to_be_visible(timeout=10000)
    shot(page, out, "login-done-1280.png", width, "로그인 시트 연결되었습니다", sheet)
    sheet.get_by_role("button", name="닫기").click()

    # Antigravity 코드 거절: invalid_code
    fake.flows["antigravity"] = flow("antigravity", "url_ready", auth_url="https://auth.example.invalid/antigravity/oauth")
    fake.after_code = {"antigravity": flow("antigravity", "failed", error={"code": "invalid_code", "message": "x"})}
    page.get_by_test_id("agent-login-button-antigravity").click()
    page.get_by_test_id("agent-login-confirm-antigravity").get_by_role("button", name="다시 연결").click()
    sheet.get_by_label("Antigravity 인증 코드").fill(FAKE_PASTED_CODE)
    sheet.get_by_role("button", name="제출").click()
    expect(sheet.locator('[role="alert"]')).to_contain_text("인증 코드가 맞지 않습니다. 다시 시도하면 새 주소가 열립니다.", timeout=10000)
    shot(page, out, "login-failed-invalid-code-1280.png", width, "로그인 시트 실패 invalid_code", sheet)
    posts_before = fake.login_posts
    fake.flows["antigravity"] = flow("antigravity", "url_ready", login_id="fake-login-antigravity-2", auth_url="https://auth.example.invalid/antigravity/oauth-2")
    sheet.get_by_role("button", name="다시 시도").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    check("invalid_code 뒤 다시 시도는 새 흐름을 시작함", fake.login_posts == posts_before + 1, fake.login_posts)
    assert_no_secret_output(sink, "설정창 로그인 흐름")
    context.close()

    # 좁은 폭에서도 로그인 시트가 넘치지 않는다.
    fake = Fake(atom=True)
    fake.flows = {"codex": flow("codex", "url_ready", auth_url="https://auth.example.invalid/codex/device", user_code=FAKE_USER_CODE, expires_at=soon()), "antigravity": flow("antigravity", "url_ready")}
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    page.get_by_role("button", name="모든 설정").click()  # 좁은 폭은 한 칸씩 보인다.
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트").click()
    page.get_by_test_id("agent-login-button-codex").click()
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    dims = sheet.evaluate("e => ({scroll: e.scrollWidth, client: e.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
    check("로그인 시트 360px 가로 넘침 없음", dims["scroll"] <= dims["client"] and dims["doc"] <= dims["inner"], dims)
    shot(page, out, "login-codex-url-ready-360.png", 360, "로그인 시트 Codex, 좁은 폭", page.locator('[data-slot="dialog-popup"]'))
    context.close()


def capture_empty_states(browser, base, out: Path, prefix: str):
    """PAS가 0개일 때의 세 경우와 만드는 중. 기준선은 설정창이 자동으로 열리던 화면이다."""
    width = 1280
    if prefix:
        fake = Fake(atom=False, sessions="manual")
        context, page = new_page(browser, base, fake, width)
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        expect(page.locator('[data-slot="dialog-popup"]')).to_be_visible(timeout=20000)
        page.wait_for_timeout(500)
        shot(page, out, f"{prefix}pas-empty-1280.png", width, "PAS 0개: 설정창이 자동으로 열림(기준선)", page)
        context.close()
        fake = Fake(atom=False)
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_settings(page)
        expect(page.locator('[data-testid="persistent-session-settings-dialog"]')).to_be_visible(timeout=15000)
        page.wait_for_timeout(800)
        shot(page, out, f"{prefix}settings-persistent-1280.png", width, "PAS 설정 대화창(기준선)", page.locator('[data-slot="dialog-popup"]'))
        context.close()
        return

    # 만들 수 없는 설정(bootstrap 꺼짐): 영구 세션 만들기
    fake = Fake(atom=True, sessions="manual")
    context, page = new_page(browser, base, fake, width)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    expect(page.get_by_test_id("persistent-empty-manual")).to_be_visible(timeout=20000)
    check("빈 상태(bootstrap 꺼짐): 설정창이 저절로 열리지 않음", page.locator('[data-slot="dialog-popup"]').count() == 0, "설정창 없음")
    check("빈 상태(bootstrap 꺼짐): bootstrap을 부르지 않음", ("POST", "/api/persistent-sessions/bootstrap") not in fake.calls, fake.calls[-5:])
    shot(page, out, "pas-empty-manual-1280.png", width, "PAS 0개, bootstrap 꺼짐: 영구 세션 만들기", page)
    page.get_by_role("button", name="영구 세션 만들기").click()
    expect(page.get_by_test_id("persistent-sessions-tab")).to_be_visible(timeout=15000)
    expect(page.get_by_text("새 영구 에이전트 세션").first).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    shot(page, out, "pas-empty-manual-create-1280.png", width, "영구 세션 만들기를 누르면 설정창의 생성 양식", page.locator('[data-slot="dialog-popup"]'))
    context.close()

    # 켜졌지만 모델이 없음: 코딩 에이전트 연결 안내
    for narrow in (1280, 360):
        fake = Fake(atom=True, sessions="unavailable")
        context, page = new_page(browser, base, fake, narrow)
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        expect(page.get_by_test_id("persistent-empty-unavailable")).to_be_visible(timeout=20000)
        check(f"빈 상태(연결 필요) {narrow}px: bootstrap을 부르지 않음", ("POST", "/api/persistent-sessions/bootstrap") not in fake.calls, fake.calls[-5:])
        dims = page.evaluate("() => ({doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
        check(f"빈 상태(연결 필요) {narrow}px: 가로 넘침 없음", dims["doc"] <= dims["inner"], dims)
        shot(page, out, f"pas-empty-unavailable-{narrow}.png", narrow, "PAS 0개, 연결 필요: 코딩 에이전트 연결 안내(관리자)", page)
        if narrow == 1280:
            page.get_by_role("button", name="코딩 에이전트 연결").click()
            expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
            page.wait_for_timeout(400)
            shot(page, out, "pas-empty-unavailable-connect-1280.png", narrow, "코딩 에이전트 연결을 누르면 설정창의 코딩 에이전트 탭", page.locator('[data-slot="dialog-popup"]'))
            fake.sessions = "bootstrap"
            page.locator('[data-slot="dialog-popup"]').get_by_role("button", name="완료").click()
            expect(page.get_by_test_id("persistent-empty-creating")).to_be_visible(timeout=15000)
            check("설정창을 닫은 뒤 목록을 다시 읽고 기본 세션 만들기로 이어짐", ("POST", "/api/persistent-sessions/bootstrap") in fake.calls, fake.calls[-6:])
        context.close()

    # 기본 세션 만드는 중, 그리고 성공하면 그 세션으로 이동
    fake = Fake(atom=True, sessions="bootstrap")
    context, page = new_page(browser, base, fake, width)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    creating = page.get_by_test_id("persistent-empty-creating")
    expect(creating).to_contain_text("기본 영구 세션을 만드는 중입니다", timeout=20000)
    page.wait_for_timeout(300)
    posts = [call for call in fake.calls if call == ("POST", "/api/persistent-sessions/bootstrap")]
    check("빈 상태(기본 세션): bootstrap을 한 번만 부름", len(posts) == 1, len(posts))
    shot(page, out, "pas-empty-creating-1280.png", width, "PAS 0개, bootstrap 켜짐: 기본 영구 세션을 만드는 중", page)
    fake.sessions = "one"
    fake.held_bootstrap.fulfill(status=201, json={"created": True, "session_id": SESSION_ID})
    page.wait_for_url(f"**/persistent/{SESSION_ID}", timeout=15000)
    check("기본 세션을 만들면 그 세션으로 옮김", page.url.endswith(f"/persistent/{SESSION_ID}"), page.url)
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline-dist", required=True)
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    server, base = serve(DIST)
    baseline_server, baseline_base = serve(Path(args.baseline_dist))
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            capture_toolbars(browser, baseline_base, out, "baseline-", atom_expected=False)
            capture_empty_states(browser, baseline_base, out, "baseline-")
            capture_toolbars(browser, base, out, "", atom_expected=True)
            capture_settings_and_logins(browser, base, out)
            capture_empty_states(browser, base, out, "")
            browser.close()
    finally:
        server.shutdown()
        baseline_server.shutdown()
    write_index(out)


def write_index(out: Path):
    lines = ["# 카드 #1787 U17 화면 캡처", "", "| 파일 | 폭(px) | 상태 |", "| --- | ---: | --- |"]
    lines += [f"| {name} | {width} | {state} |" for name, width, state in INDEX]
    lines += ["", "## 실측 단언", ""]
    lines += [f"- {'통과' if item['ok'] else '실패'}: {item['check']}" for item in CHECKS]
    (out / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

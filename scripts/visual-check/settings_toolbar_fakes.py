"""settings_toolbar.py가 쓰는 가짜 서버 응답과 공용 도구.

카드 #1787 U17. 서버 PR(U18a 로그인, U18b 기본 PAS)이 없어도 약속 문서의 모양대로 가짜 응답을 내려 화면을 찍는다.
일회용 코드와 인증 주소는 모두 가짜 값이다.
"""
from __future__ import annotations

import functools
import http.server
import io
import json
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect

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
UNAVAILABLE = "기본 모델 sample-neon이(가) 노드 local에 없습니다. 기본 모델 sample-opus을(를) 지금 쓸 수 없습니다. 기본 모델 sample-sol을(를) 지금 쓸 수 없습니다."


def uploaded_photo_png() -> bytes:
    """사용자가 올린 사진 대역. 번들 그림과 겹치지 않게 따뜻한 색 가로 줄무늬로 그린다."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (480, 270))
    draw = ImageDraw.Draw(image)
    for y in range(270):
        draw.line([(0, y), (480, y)], fill=(230 - y // 4, 150 + y // 6, 90 + y // 3))
    draw.ellipse([300, 40, 380, 120], fill=(255, 236, 190))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


BUNDLED_WALLPAPER = re.compile(r"^/wallpapers/[a-z0-9-]+\.webp$")


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

    def __init__(self, atom=True, sessions="one", login_supported=True, admin=True, nodes="one", hold_usage=False, bootstrap="hold", hold_login_post=False, login_post_error=None, agent_name="로젤린", defaults_node="eiaserinnys", user_prefs=None):
        self.atom = atom
        self.sessions = sessions  # one | two | manual | unavailable | bootstrap
        self.login_supported = login_supported
        self.admin = admin
        self.nodes = nodes  # one | none | down | many
        self.hold_usage = hold_usage
        self.held_usage: list = []
        self.bootstrap = bootstrap  # hold | fail
        self.hold_login_post = hold_login_post
        self.held_login_post = None
        self.login_post_error = login_post_error  # (status, code)
        self.agent_name = agent_name
        self.defaults_node = defaults_node  # 영구 세션 만들기 기본 노드. 연결된 노드가 없으면 서버가 빈 값을 준다
        # None이면 /api/user/preferences를 가짜로 받지 않는다. 딕셔너리면 {"wallpaper": {...}, "uploaded": bool}로 서버 저장값을 흉내 낸다.
        self.user_prefs = user_prefs
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
            return route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": self.admin}})
        if path == "/api/auth/config":
            return route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
        if self.user_prefs is not None and path == "/api/user/preferences":
            return self.user_preferences(route, method, request)
        if self.user_prefs is not None and path == "/api/user/background" and method == "GET":
            return route.fulfill(body=uploaded_photo_png(), content_type="image/png")
        if path == "/api/persistent-sessions" and method == "GET":
            defaults = {**CREATE_DEFAULTS, "node_id": self.defaults_node, "unavailable_reason": UNAVAILABLE if self.sessions == "unavailable" else None}
            if self.sessions in ("unavailable", "bootstrap"):
                defaults["bootstrap_enabled"] = True
            first = {**PAS, "agent_name": self.agent_name}
            sessions = {"one": [first], "two": [first, {**first, "session_id": "components-session-2", "display_name": "둘째 PAS"}]}.get(self.sessions, [])
            return route.fulfill(json={"sessions": sessions, "total": len(sessions), "create_defaults": defaults})
        if path == "/api/persistent-sessions/bootstrap" and method == "POST":
            if self.bootstrap == "fail":
                return route.fulfill(status=502, json={"code": "bad_gateway", "message": "서버가 요청을 처리하지 못했습니다."})
            self.held_bootstrap = route  # 만드는 중 화면을 찍는 동안 응답하지 않는다.
            return
        if path == f"/api/persistent-sessions/{SESSION_ID}":
            return route.fulfill(json={"session": PAS})
        if path == f"/api/persistent-sessions/{SESSION_ID}/instructions":
            return route.fulfill(json={"instructions": [{"id": "i-1", "text": "결정에 필요한 근거만 간결하게 알려 줍니다.", "source_turns": ["T195"], "created_at": "2026-10-06T10:00:00Z", "updated_at": "2026-10-06T11:00:00Z", "origin": "agent"}]})
        if path == "/api/sessions":
            return route.fulfill(json={"sessions": [SUMMARY], "total": 1})
        if path == "/api/nodes":
            return route.fulfill(json={"nodes": self.node_list()})
        if path == "/api/nodes/stream":
            return route.fulfill(content_type="text/event-stream", body=f"event: snapshot\ndata: {json.dumps(self.node_list())}\n\n")
        if path.endswith("/agents") and path.startswith("/api/nodes/"):
            return route.fulfill(json={"agents": [{"id": "roselin", "name": "로젤린", "backend": "codex", "default_preset": "sample-sol"}]})
        if path == "/api/sessions/stream":
            return route.fulfill(content_type="text/event-stream", body=f"event: session_list\ndata: {json.dumps({'type': 'session_list', 'sessions': [SUMMARY], 'total': 1})}\n\n")
        if path.endswith("/events"):
            return route.fulfill(content_type="text/event-stream", body='event: history_sync\ndata: {"type":"history_sync","last_event_id":3,"is_live":true,"status":"running"}\n\n')
        if path.endswith("/timeline"):
            return route.fulfill(json={"messages": [], "next_cursor": None})
        if path.endswith("/story"):
            return route.fulfill(json={"highlight": None, "narrative": "세션 줄거리 예시입니다.", "unfolded_turn_summaries": [], "narrative_through_event_id": None, "fold_count": 0, "updated_at": None})
        if path.endswith("/model-presets"):
            return route.fulfill(json={"model_presets": MODEL_PRESETS})
        if path == "/api/usage/summary":
            if self.hold_usage:
                self.held_usage.append(route)  # 불러오는 중 화면을 찍는 동안 응답하지 않는다.
                return
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

    def user_preferences(self, route, method, request):
        """서버 serializePreferences와 같은 꼴: 올린 그림이 있어도 번들 경로의 customImage는 덮어쓰지 않는다."""
        state = self.user_prefs
        if method == "PUT":
            body = request.post_data_json or {}
            state["wallpaper"] = body.get("wallpaper", state["wallpaper"])
            state["last_put"] = body
            if body.get("clearBackground"):
                state["uploaded"] = False
        background = "/api/user/background?v=1" if state["uploaded"] else None
        wallpaper = dict(state["wallpaper"])
        if background and wallpaper.get("mode") == "photo" and not BUNDLED_WALLPAPER.match(wallpaper.get("customImage", "")):
            wallpaper["customImage"] = background
        return route.fulfill(json={"email": "qa@example.test", "preferences": {"appearance": "system", "wallpaper": wallpaper}, "hasBackground": state["uploaded"], "backgroundUrl": background, "updatedAt": None})

    def agent_login(self, route, method, parts):
        tail = parts[parts.index("agent-logins") + 1:]
        if method == "POST" and len(tail) == 1:  # /agent-logins/<provider>
            self.login_posts += 1
            if self.login_post_error:
                status, code = self.login_post_error
                return route.fulfill(status=status, json={"code": code, "message": "x"})
            if self.hold_login_post:
                self.held_login_post = route  # 「로그인을 준비하고 있습니다」를 찍는 동안 응답하지 않는다.
                return
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

    def node_list(self):
        if self.nodes == "none":
            return []
        if self.nodes == "down":
            return [{**NODE, "status": "disconnected"}]
        if self.nodes == "many":
            return [NODE, {**NODE, "nodeId": "eias-linegames", "port": 3106}, {**NODE, "nodeId": "silent-manari-ts", "port": 3107, "status": "disconnected"}]
        return [NODE]


def new_page(browser, base, fake, width, height=900, theme="dark", preferences=None, scale=1):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=scale, color_scheme=theme, reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
    page = context.new_page()
    init = f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');"
    if preferences is not None:
        init += f"localStorage.setItem('soulstream-pas-device:qa@example.test', {json.dumps(json.dumps(preferences))});"
    page.add_init_script(init)
    page.route("**/api/**", fake.handle)
    page.route("**/cogito/**", fake.handle)
    return context, page


# 1차 그림(접두어 없음)을 지우지 않도록 2차 그림은 이 접두어로 구별한다.
PREFIX = "r2-"


def shot(page, out: Path, name: str, width: int, state: str, locator=None):
    name = PREFIX + name
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


def wait_for_call(page, fake, call, timeout_ms=5000):
    """가짜 서버가 그 호출을 받을 때까지 기다린다. 화면이 먼저 바뀌고 요청이 뒤따르는 경우의 경쟁을 막는다."""
    waited = 0
    while call not in fake.calls and waited < timeout_ms:
        page.wait_for_timeout(100)
        waited += 100
    return call in fake.calls


def check(label, condition, detail):
    CHECKS.append({"check": label, "ok": bool(condition), "detail": detail})
    assert condition, f"{label}: {json.dumps(detail, ensure_ascii=False)}"


# 서버가 보내는 사유 문장의 조각. 어느 것도 화면에 그려지면 안 된다.
UNAVAILABLE_FRAGMENTS = ("sample-neon", "sample-opus", "sample-sol", "지금 쓸 수 없습니다", "에 없습니다", "unavailable")

CONNECT_GUIDE_MEASURE = """() => {
    const root = document.querySelector('[data-testid="persistent-empty-unavailable"]');
    const group = root.querySelector('.persistent-empty-state');
    const title = group.querySelector(':scope > p');
    const lines = [...title.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => {
        const range = document.createRange();
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()];
        return {text: n.textContent, rects: rects.length, left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top))};
    });
    const steps = [...group.querySelectorAll('.persistent-empty-steps > li')];
    const list = group.querySelector('.persistent-empty-steps');
    const button = [...group.querySelectorAll('button')].find((b) => b.textContent.trim() === '코딩 에이전트 연결');
    const frame = group.parentElement.getBoundingClientRect();
    const box = group.getBoundingClientRect();
    return {
        lines, steps: steps.map((li) => li.textContent), listLeft: list ? list.getBoundingClientRect().left : null,
        stepLeft: steps.map((li) => li.getBoundingClientRect().left), buttonLeft: button ? button.getBoundingClientRect().left : null,
        buttonCount: group.querySelectorAll('button').length, groupLeft: box.left, groupRight: box.right,
        frameLeft: frame.left, frameRight: frame.right, text: root.innerText,
        reasonNodes: document.querySelectorAll('.persistent-empty-reason').length,
        docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    };
}"""

TITLE_ADMIN = ("기본 영구 세션을 만들기 위해", "코딩 에이전트에 로그인해주세요.")
TITLE_USER = ("기본 영구 세션을 만들기 위해", "관리자가 코딩 에이전트에 로그인해야 합니다.")


def assert_connect_guide(page, label, admin):
    """연결 필요 안내의 실측. 제목 두 줄, 사유 문장 없음, 단계와 단추의 왼쪽 끝이 제목과 같음, 묶음이 프레임 가운데, 가로 넘침 없음."""
    m = page.evaluate(CONNECT_GUIDE_MEASURE)
    want = TITLE_ADMIN if admin else TITLE_USER
    check(f"{label}: 제목이 두 줄이고 정해진 자리에서 끊김", [line["text"] for line in m["lines"]] == list(want) and all(line["rects"] == 1 for line in m["lines"]) and m["lines"][0]["top"] < m["lines"][1]["top"], m["lines"])
    check(f"{label}: 서버 사유 문장이 화면에 없음", not any(piece in m["text"] for piece in UNAVAILABLE_FRAGMENTS) and m["reasonNodes"] == 0, m["text"])
    left = min(line["left"] for line in m["lines"])
    if admin:
        check(f"{label}: 단계 두 줄과 단추", len(m["steps"]) == 2 and m["buttonCount"] == 1, {"steps": m["steps"], "buttons": m["buttonCount"]})
        check(f"{label}: 단계와 단추의 왼쪽 끝이 제목과 같음", abs(m["listLeft"] - left) <= 1 and all(abs(x - left) <= 1 for x in m["stepLeft"]) and abs(m["buttonLeft"] - left) <= 1, {"title": left, "list": m["listLeft"], "steps": m["stepLeft"], "button": m["buttonLeft"]})
    else:
        check(f"{label}: 비관리자는 제목만(단계와 단추 없음)", not m["steps"] and m["buttonCount"] == 0 and m["listLeft"] is None, {"steps": m["steps"], "buttons": m["buttonCount"]})
    center_gap = abs((m["groupLeft"] + m["groupRight"]) / 2 - (m["frameLeft"] + m["frameRight"]) / 2)
    check(f"{label}: 묶음이 프레임 가운데에 섬", center_gap <= 2, {"group": [m["groupLeft"], m["groupRight"]], "frame": [m["frameLeft"], m["frameRight"]]})
    check(f"{label}: 글이 프레임 밖으로 나가지 않고 가로 넘침 없음", m["groupLeft"] >= m["frameLeft"] - 1 and m["groupRight"] <= m["frameRight"] + 1 and max(line["right"] for line in m["lines"]) <= m["frameRight"] + 1 and m["docScrollWidth"] <= m["innerWidth"], m)
    return m


def listen(page, sink):
    page.on("console", lambda message: sink.append(message.text))
    page.on("pageerror", lambda error: sink.append(str(error)))


def assert_no_secret_output(sink, label):
    leaked = [line for line in sink if FAKE_USER_CODE in line or FAKE_PASTED_CODE in line or "auth.example.invalid" in line]
    check(f"{label}: 일회용 코드, 인증 주소, 붙여 넣은 코드가 콘솔에 없음", not leaked, {"lines": len(sink)})


def open_settings(page):
    page.get_by_test_id("config-button").click()
    expect(page.locator('[data-slot="dialog-popup"]')).to_be_visible(timeout=15000)


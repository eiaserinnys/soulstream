#!/usr/bin/env python3
"""Capture the real card workspace with intercepted workspace responses."""
from __future__ import annotations
import argparse
from contextlib import ExitStack
import functools
import http.server
import importlib.util
import json
import os
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeoutError

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "unified-dashboard" / "dist"
_pas_spec = importlib.util.spec_from_file_location("session_files_pas_width", Path(__file__).with_name("session_files_pas_width.py"))
_pas_module = importlib.util.module_from_spec(_pas_spec)
_pas_spec.loader.exec_module(_pas_module)
_diff_spec = importlib.util.spec_from_file_location("session_files_diff_fixtures", Path(__file__).with_name("session_files_diff_fixtures.py"))
_diff_fixture = importlib.util.module_from_spec(_diff_spec)
_diff_spec.loader.exec_module(_diff_fixture)
SHORT_TEXT = b"// session file preview\n"
LONG_TEXT = ("// session file preview\n" + "".join(f"export const eventType{i:02} = 'session:{i:02}';\n" for i in range(40))).encode()
LONG_BRANCH = "feature/" + "very-long-session-files-branch-" * 5
FILE = dict(orig_path=None, added=None, deleted=None, size=len(SHORT_TEXT), wrote=False, read=False, committed=False, last_activity_at=None)
DATA = {
    "session_id": "components-session", "root": "/workspace/card1789", "node": {"id": "eiaserinnys", "status": "ok"},
    "snapshot": {"state": "ready", "observed_at": "2026-11-22T15:12:00Z", "refreshing": False, "branch": "card1789-files-dashboard", "head": "abc", "upstream": "origin/main", "ahead": 1, "behind": 0, "truncated": False},
    "attribution": "partial", "files": [
        {**FILE, "path": "soul-server-ts/src/config.ts", "git_status": "modified", "added": _diff_fixture.CONFIG_ADD, "deleted": _diff_fixture.CONFIG_DEL},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox_types.ts", "size": len(LONG_TEXT), "git_status": None, "committed": True, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox.ts", "git_status": "modified", "added": _diff_fixture.EVENT_ADD, "deleted": _diff_fixture.EVENT_DEL, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/outbox_retry.ts", "git_status": "untracked", "added": len(_diff_fixture.NEW_LINES), "deleted": 0, "wrote": True},
    ], "read_only": [{"path": "soul-server-ts/src/upstream/dispatcher.ts", "size": None, "last_read_at": None}],
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path == "/components" or urlsplit(self.path).path.startswith("/persistent"): self.path = "/index.html"
        return super().do_GET()
    def log_message(self, format, *args): pass

def serve(directory):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"

def wait_stable(page, locator, kind):
    page.wait_for_function("""async ({el, kind}) => {
        let previous = null, stable = 0;
        while (stable < 3) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            const current = kind === 'scroll' ? [el.scrollHeight, el.scrollTop]
                : kind === 'style' ? [r.x, r.y, r.width, r.height, s.color, s.backgroundColor, s.borderColor, s.borderWidth, s.outline, s.boxShadow]
                : [r.x, r.y, r.width, r.height];
            const value = JSON.stringify(current);
            stable = value === previous ? stable + 1 : 1;
            previous = value;
        }
        return true;
    }""", arg={'el': locator.element_handle(), 'kind': kind}, timeout=15000)

def install_routes(page, scene="ready", requests=None):
    requests = requests if requests is not None else {"workspace": 0}
    settings = {"default_model": {"model_preset": None, "reasoning_effort": None}, "fallback_models": [], "show_generation_separator": True, "show_character": False, "animate_character": False, "show_jev_candidates": True, "show_turn_usage": True, "turn_usage_mode": "collapsed"}
    session = {"session_id": "components-session", "display_name": "검수 PAS", "node_id": "eiaserinnys", "folder_id": None, "agent_id": "roselin", "agent_name": "로젤린", "persistent": True, "settings": settings, "runtime": {"current_model": {"model_preset": None, "reasoning_effort": None, "model": None}, "pending": None}}
    summary = {"agentSessionId": "components-session", "displayName": "검수 PAS", "status": "running", "eventCount": 80, "agentId": "roselin", "agentName": "로젤린", "nodeId": "eiaserinnys", "backend": "codex", "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z"}
    node = {"nodeId": "eiaserinnys", "host": "localhost", "port": 3105, "status": "connected", "capabilities": {}, "connectedAt": 0, "sessionCount": 1}
    def route_handler(route):
        path = urlsplit(route.request.url).path
        if path == "/api/health": return route.fulfill(json={"healthy": True, "ready": True, "draining": False, "build_id": "dev"})
        if path == "/api/auth/status": return route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True}})
        if path == "/api/auth/config": return route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
        if path == "/api/persistent-sessions": return route.fulfill(json={"sessions": [session], "total": 1, "create_defaults": {"node_id": "eiaserinnys", "preferred_agent_id": "roselin", "settings": settings, "initial_instruction": "", "unavailable_reason": None}})
        if path == "/api/persistent-sessions/components-session": return route.fulfill(json={"session": session})
        if path == "/api/sessions": return route.fulfill(json={"sessions": [summary], "total": 1})
        if path == "/api/nodes": return route.fulfill(json={"nodes": [node]})
        if path == "/api/cards" and scene == "pas-width":
            card = {"id": "pas-width-card", "number": 1789, "folderId": "review", "title": "세션 파일 폭 확인", "request": "", "brief": "", "attachments": [], "status": "running", "blockedKind": None, "blockedDetail": None, "positionKey": "a", "queuePositionKey": None, "assigneeKind": None, "assigneeAgentId": None, "assigneeUserId": None, "assigneeSessionId": None, "nodeId": None, "modelPreset": None, "version": 1, "archived": False, "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z"}
            return route.fulfill(json={"cards": [card]})
        if path == "/api/nodes/stream": return route.fulfill(content_type="text/event-stream", body=f"event: snapshot\ndata: {json.dumps([node])}\n\n")
        if path == "/api/sessions/stream": return route.fulfill(content_type="text/event-stream", body=f"event: session_list\ndata: {json.dumps({'type':'session_list', 'sessions':[summary], 'total':1})}\n\n")
        if path.endswith("/events"): return route.fulfill(content_type="text/event-stream", body='event: history_sync\ndata: {"type":"history_sync","last_event_id":80,"is_live":true,"status":"running"}\n\n')
        if path.endswith("/timeline"):
            messages = [{"id": n, "parent_event_id": None, "event_type": "assistant_message", "payload": {"timestamp": n, "content": f"대화 기록 {n}: 파일을 확인합니다.", "tool_use_id": str(n), "_final_for_live_stream": True}, "created_at": f"2026-10-01T00:{n // 60:02}:{n % 60:02}Z"} for n in range(80, 0, -1)]
            return route.fulfill(json={"messages": messages, "next_cursor": None})
        if path.endswith('/story'): return route.fulfill(json={"highlight": None, "narrative": "", "unfolded_turn_summaries": [], "narrative_through_event_id": 0, "fold_count": 0, "updated_at": None})
        if path.endswith("/workspace/session-diff"):
            requested = parse_qs(urlsplit(route.request.url).query).get("path", [""])[0]
            requests["session_diff"] = requests.get("session_diff", 0) + 1
            if scene == "session-error" and requests["session_diff"] == 1: return route.fulfill(status=503, json={"error": "unavailable"})
            edits = [
                {"at":"2026-11-22T15:12:00Z", "tool":"Edit", "kind":"edit", "text":"@@ @@\n 같은 줄\n-이전 내용\n+바뀐 내용", "line_numbers":False, "replace_all":False},
                {"at":"2026-11-22T15:13:00Z", "tool":"Write", "kind":"write", "text":"@@ -0,0 +1,2 @@\n+첫 줄\n+둘째 줄", "line_numbers":True, "replace_all":False},
                {"at":"2026-11-22T15:14:00Z", "tool":"file_change", "kind":"edit", "text":"@@ -10,1 +10,1 @@\n-old\n+new", "line_numbers":True, "replace_all":False},
            ]
            if scene == "session-unrecorded": edits = []
            return route.fulfill(json={"path":requested,"edits":edits,"unrecorded":2 if scene in ("session-unrecorded", "session-mixed") else 0,"truncated":scene == "session-truncated"})
        if path.endswith("/workspace/diff"):
            requested = parse_qs(urlsplit(route.request.url).query).get("path", [""])[0]
            if scene == "diff-loading":
                requests["pending_diff"] = route
                return
            if scene == "diff-error": return route.fulfill(status=503, json={"error": "unavailable"})
            if scene == "diff-old": return route.fulfill(status=501, json={"error": "unsupported"})
            status = {"diff-new": "added", "diff-deleted": "deleted", "diff-renamed": "renamed"}.get(scene, "modified")
            text = _diff_fixture.EVENT_DIFF
            if scene == "diff-new": text = _diff_fixture.NEW_DIFF
            elif scene == "diff-deleted": text = _diff_fixture.DELETED_DIFF
            elif scene == "diff-renamed": text = ""
            elif requested.endswith("/outbox_retry.ts"): status, text = "untracked", _diff_fixture.NEW_DIFF
            elif requested.endswith("/config.ts"): text = _diff_fixture.CONFIG_DIFF
            return route.fulfill(json={"path": requested, "status": status, "text": text, "truncated": scene == "diff-truncated", "binary": scene == "diff-binary"})
        if path.endswith("/workspace/file"):
            requested = parse_qs(urlsplit(route.request.url).query).get('path', [''])[0]
            requests.setdefault('file_ranges', []).append({'path': requested, 'range': route.request.headers.get('range')})
            raw = LONG_TEXT if requested.endswith('event_outbox_types.ts') else SHORT_TEXT
            data = raw[:1] if route.request.headers.get('range') == 'bytes=0-0' else raw
            return route.fulfill(status=206, body=data, headers={"Content-Type": "text/plain", "Content-Range": f"bytes 0-{len(data)-1}/{len(raw)}", "Content-Length": str(len(data))})
        if path.endswith("/workspace"):
            requests["workspace"] += 1
            if scene == "error" and requests["workspace"] == 1: return route.fulfill(status=503, json={"error": "unavailable"})
            data = json.loads(json.dumps(DATA, ensure_ascii=False))
            if scene == "loading": data["snapshot"]["state"] = "pending"
            if scene == "offline": data["node"]["status"] = "offline"
            if scene == "long": data["files"][0]["path"] = "매우-긴-폴더-이름/아주-긴-파일-이름을-좁은-화면에서-읽기-위한-이름-123456789.ts"
            if scene == "matrix": data["snapshot"].update(branch=LONG_BRANCH, ahead=12)
            if scene in ("unsupported", "no_workspace"):
                data.update(node={"id": "eiaserinnys", "status": scene}, snapshot=None, files=[], read_only=[])
            if scene == "session-no-workspace":
                data.update(root=None, node={"id":"eiaserinnys", "status":"no_workspace"}, snapshot=None)
                data["files"] = [data["files"][1]]
            if scene == "empty":
                data.update(files=[], read_only=[], attribution="full")
                data["snapshot"].update(branch=None, ahead=0, behind=0)
            if scene == "not_git":
                data["snapshot"].update(state="not_git", branch=None, ahead=0, behind=0)
                data["files"] = []
            if scene == "expanded": data["read_only"].append({"path": "soul-server-ts/src/config/defaults.ts", "size": None, "last_read_at": None})
            if scene.startswith("diff-"):
                data["files"][2]["git_status"] = {"diff-new": "added", "diff-deleted": "deleted", "diff-renamed": "renamed"}.get(scene, "modified")
                if scene == "diff-new":
                    data["files"][2].update(path=f"{_diff_fixture.UP}/outbox_retry.ts", added=len(_diff_fixture.NEW_LINES), deleted=0)
                    data["files"].pop(3)
                if scene == "diff-deleted": data["files"][2].update(path=f"{_diff_fixture.UP}/retry_constants.ts", added=0, deleted=len(_diff_fixture.DELETED_LINES))
                if scene == "diff-renamed": data["files"][2].update(path="soul-server-ts/tests/upstream/outbox_retry.test.ts", orig_path="soul-server-ts/tests/upstream/retry.test.ts", added=0, deleted=0)
                if scene == "diff-binary": data["files"][2].update(path="soul-server-ts/tests/fixtures/outbox.db", added=None, deleted=None, wrote=False)
            if scene == "interaction":
                data["files"][0].update(size=0, git_status=None, wrote=True)
                data["files"] += [{**FILE, "path": f"fixtures/folder-{i // 10}/example-{i:02}.ts", "git_status": "modified", "wrote": True} for i in range(40)]
                data["read_only"] += [{"path": f"fixtures/read-only/read-{i:02}.ts", "size": None, "last_read_at": None} for i in range(50)]
            return route.fulfill(json=data)
        return route.continue_()
    page.route("**/api/**", route_handler)

def story_comparison(browser, baseline, current, out):
    results = {}
    for label, base in [("before", baseline), ("after", current)]:
        context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", reduced_motion="reduce", service_workers="block")
        page = context.new_page()
        page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
        def route(route):
            path = urlsplit(route.request.url).path
            if path == "/api/health": return route.fulfill(json={"healthy": True, "ready": True, "draining": False, "build_id": "dev"})
            if path == "/api/auth/status": return route.fulfill(json={"authenticated": True, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True}})
            if path == "/api/auth/config": return route.fulfill(json={"authEnabled": True, "devModeEnabled": False})
            if path.endswith('/story'): return route.fulfill(json={"highlight": None, "narrative": "", "unfolded_turn_summaries": [], "narrative_through_event_id": 0, "fold_count": 0, "updated_at": None})
            return route.continue_()
        page.route("**/api/**", route)
        page.goto(base + "/components", wait_until="domcontentloaded")
        story = page.locator('[data-testid="components-panel-headers"] [data-testid="session-story-trigger"]')
        story.scroll_into_view_if_needed(); expect(story).to_be_visible(); page.evaluate("document.fonts.ready")
        def style():
            return story.evaluate("""el => {const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {width:r.width,height:r.height,color:s.color,background:s.backgroundColor,border:s.borderColor,borderWidth:s.borderWidth,outline:s.outline,boxShadow:s.boxShadow}}""")
        normal = style(); story.hover(); wait_stable(page, story, 'style'); hover = style()
        story.focus(); page.keyboard.press("Tab"); page.keyboard.press("Shift+Tab"); expect(story).to_be_focused(); wait_stable(page, story, 'style'); focus = style()
        story.screenshot(path=str(out / f"story-{label}.png"), animations="disabled")
        story.click(); expect(story).to_have_attribute("aria-expanded", "true")
        results[label] = {"normal": normal, "hover": hover, "focus": focus, "expanded": story.get_attribute("aria-expanded")}
        context.close()
    return results

def capture_pas_and_folder(browser, base, out):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
    page = context.new_page()
    page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
    install_routes(page)
    page.goto(base + "/persistent/components-session", wait_until="domcontentloaded")
    trigger = page.get_by_role("button", name="세션 파일")
    expect(trigger).to_be_visible(timeout=60000)
    expect(trigger).to_have_attribute("data-appearance", "bare")
    expect(trigger).to_have_attribute("aria-pressed", "false")
    page.screenshot(path=str(out / "pas-entry.png"), animations="disabled")
    trigger.click(); expect(trigger).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_role("region", name="세션 파일")).to_be_visible()
    page.screenshot(path=str(out / "pas-panel.png"), animations="disabled")
    pas = trigger.evaluate("el => ({tag:el.tagName, pressed:el.getAttribute('aria-pressed'), className:el.className, ariaLabel:el.getAttribute('aria-label')})")
    page.goto(base + "/components?sample=session-files-folder", wait_until="domcontentloaded")
    trigger = page.get_by_role("button", name="파일", exact=True)
    expect(trigger).to_be_visible(timeout=60000); trigger.click()
    expect(page.get_by_role("region", name="세션 파일")).to_be_visible()
    page.screenshot(path=str(out / "folder-panel.png"), animations="disabled")
    context.close()
    return {"pas": pas, "folder": "실제 FolderWorkspace에서 파일 칸 표시"}

def capture_retention(browser, base):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", reduced_motion="reduce", service_workers="block")
    page = context.new_page()
    page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
    requests = {"workspace": 0}
    install_routes(page, "interaction", requests)
    page.goto(base + "/components?filesReview=1", wait_until="domcontentloaded")
    sample = page.get_by_test_id("card-board-sample")
    sample.locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click()
    workspace = page.get_by_test_id("v3-card-workspace")
    chat = workspace.get_by_test_id("v3-card-session-chat")
    trigger = chat.get_by_role("button", name="파일", exact=True)
    expect(trigger).to_be_visible(timeout=60000)
    draft = chat.locator('textarea')
    expect(draft).to_be_enabled(timeout=15000)
    draft.fill('파일 확인 중인 임시 글')
    scroller = chat.locator('[data-virtuoso-scroller="true"]')
    expect(scroller).to_be_visible(timeout=15000)
    page.wait_for_function("""() => {const e=document.querySelector('[data-testid="v3-card-session-chat"] [data-virtuoso-scroller="true"]');return e && e.scrollHeight > e.clientHeight + 200} """, timeout=15000)
    scroller.evaluate("e => {e.scrollTop = Math.floor((e.scrollHeight-e.clientHeight)/2); e.dispatchEvent(new Event('scroll'))}")
    wait_stable(page, scroller, 'scroll')
    chat_before = scroller.evaluate('e => e.scrollTop')
    trigger.click()
    pane = workspace.get_by_role("region", name="세션 파일")
    expect(pane.get_by_text('example-39.ts')).to_be_attached()
    pane.get_by_text('config.ts', exact=True).click()
    pane.get_by_role('region', name='config.ts 변경분').get_by_role('button', name='전체 보기').click()
    dialog = page.get_by_role('dialog')
    expect(dialog.locator('pre')).to_contain_text('// session file preview')
    expect(dialog.locator('.chat-image-viewer-metadata')).to_have_text(f'{len(SHORT_TEXT)} B')
    page.wait_for_function("document.querySelector('[data-slot=dialog-popup][data-attachment-kind]')?.contains(document.activeElement)", timeout=5000)
    page.keyboard.press('Escape'); expect(dialog).to_have_count(0)
    row = pane.get_by_role('button', name='config.ts', exact=False)
    row.click(); expect(row).to_have_attribute('aria-expanded', 'false')
    ranges = [entry['range'] for entry in requests['file_ranges'] if entry['path'].endswith('config.ts')]
    assert ranges == ['bytes=0-0', f'bytes=0-{len(SHORT_TEXT)-1}'], ranges
    read_toggle = pane.get_by_role('button', name='읽기만 한 파일', exact=False)
    expect(pane).to_be_visible(timeout=5000)
    expect(read_toggle).to_be_visible(timeout=5000)
    body = pane.locator('.v3-session-files-body')
    read_toggle.scroll_into_view_if_needed()
    toggle_scroll_before = body.evaluate('e => e.scrollTop')
    read_toggle.click(); expect(read_toggle).to_have_attribute('aria-expanded', 'true')
    toggle_scroll_after = body.evaluate('e => e.scrollTop')
    assert abs(toggle_scroll_before - toggle_scroll_after) <= 2, (toggle_scroll_before, toggle_scroll_after)
    body.evaluate("e => {e.scrollTop = e.scrollHeight - e.clientHeight - 100; e.dispatchEvent(new Event('scroll'))}")
    wait_stable(page, body, 'scroll')
    file_before = body.evaluate('e => e.scrollTop')
    def geometry(): return body.evaluate("e => ({top:e.scrollTop, height:e.scrollHeight, client:e.clientHeight, anchor:getComputedStyle(e).overflowAnchor})")
    before_geometry = geometry()
    assert chat_before > 0 and file_before > 0, (chat_before, file_before)
    pane.get_by_role('button', name='파일 닫기').click()
    expect(draft).to_have_value('파일 확인 중인 임시 글')
    chat_after_close = scroller.evaluate('e => e.scrollTop')
    trigger.click(); expect(pane.get_by_text('example-39.ts')).to_be_attached()
    expect(read_toggle).to_have_attribute('aria-expanded', 'true')
    wait_stable(page, body, 'scroll')
    file_after_open = body.evaluate('e => e.scrollTop')
    page.set_viewport_size({"width": 390, "height": 900})
    if workspace.get_attribute('data-mobile-view') != 'chat': page.get_by_test_id('v3-mobile-tab-chat').click()
    expect(pane).to_be_visible(); wait_stable(page, body, 'scroll'); file_narrow = body.evaluate('e => e.scrollTop')
    narrow_geometry = geometry()
    page.set_viewport_size({"width": 1440, "height": 900})
    expect(draft).to_have_value('파일 확인 중인 임시 글')
    wait_stable(page, scroller, 'scroll')
    wait_stable(page, body, 'scroll')
    chat_wide = scroller.evaluate('e => e.scrollTop'); file_wide = body.evaluate('e => e.scrollTop')
    result = {"draft": draft.input_value(), "chat_scroll": [chat_before, chat_after_close, chat_wide], "file_scroll": [file_before, file_after_open, file_narrow, file_wide], "toggle_scroll": [toggle_scroll_before, toggle_scroll_after], "file_geometry": [before_geometry, narrow_geometry, geometry()], "read_only_expanded": read_toggle.get_attribute('aria-expanded'), "stale_size_preview_ranges": ranges}
    assert abs(chat_before - chat_after_close) <= 2 and abs(chat_before - chat_wide) <= 2, result
    assert all(abs(file_before - value) <= 2 for value in [file_after_open, file_narrow, file_wide]), result
    context.close()
    return result

def capture_layout_checks(browser, base, out):
    """검수에서 반려된 화면의 실측값과 단언을 함께 남긴다."""
    results, errors = {"surfaces": {}, "states": {}, "expanded": {}}, []
    def check(condition, label, detail):
        if not condition: errors.append({"check": label, "detail": detail})
    def open_surface(surface, scene):
        context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
        page = context.new_page()
        page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
        requests = {"workspace": 0}
        install_routes(page, scene, requests)
        if surface == 'pas':
            page.goto(base + '/persistent/components-session', wait_until='domcontentloaded')
            trigger = page.get_by_role('button', name='세션 파일')
            workspace = None
        elif surface == 'folder':
            page.goto(base + '/components?sample=session-files-folder', wait_until='domcontentloaded')
            trigger = page.get_by_role('button', name='파일', exact=True)
            workspace = None
        else:
            page.goto(base + '/components', wait_until='domcontentloaded')
            page.get_by_test_id('card-board-sample').locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click()
            workspace = page.get_by_test_id('v3-card-workspace')
            trigger = workspace.get_by_role('button', name='파일', exact=True)
        expect(trigger).to_be_visible(timeout=60000); trigger.click()
        pane = page.get_by_role('region', name='세션 파일') if workspace is None else workspace.get_by_role('region', name='세션 파일')
        expect(pane).to_be_visible()
        return context, page, workspace, pane
    def resize(page, workspace, pane, width, surface='card'):
        page.set_viewport_size({"width": width, "height": 900})
        if workspace is not None and width <= 760 and workspace.get_attribute('data-mobile-view') != 'chat':
            page.get_by_test_id('v3-mobile-tab-chat').click()
        if surface == 'folder' and width <= 760:
            expect(page.locator('.v3-workspace[data-mobile-view="chat"][data-mobile-files="true"]')).to_be_visible(timeout=15000)
        expect(pane).to_be_visible()
        if surface == 'folder':
            try:
                page.wait_for_function('el => el.getBoundingClientRect().right <= window.innerWidth', arg=pane.element_handle(), timeout=15000)
            except PlaywrightTimeoutError:
                print(json.dumps(pane.evaluate("""el => {const s=getComputedStyle(el);return {class:el.className, position:s.position, left:s.left, width:s.width, borderRadius:s.borderRadius, innerWidth:window.innerWidth, right:el.getBoundingClientRect().right}}"""), ensure_ascii=False), flush=True)
                raise
        wait_stable(page, pane, 'rect')
    for surface in ('card', 'folder', 'pas'):
        context, page, workspace, pane = open_surface(surface, 'matrix')
        expect(pane.locator('.v3-session-files-title strong')).to_have_text(LONG_BRANCH)
        page.evaluate('document.fonts.ready')
        results['surfaces'][surface] = {}
        for width in (1440, 1150, 900, 390, 360):
            resize(page, workspace, pane, width, surface)
            m = pane.evaluate("""el => {
                const title=el.querySelector('.v3-session-files-title'), svg=title.querySelector('svg'), strong=title.querySelector('strong');
                const header=el.querySelector('.v3-chat-header'), caps=[...header.querySelectorAll('.dashboard-icon-cap')];
                const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
                const probe=document.createElement('span');probe.style.color='var(--v3-text-tertiary)';el.append(probe);const tertiary=getComputedStyle(probe).color;probe.remove();
                const css=getComputedStyle(strong);
                return {pane:rect(el),header:rect(header),title:rect(title),icon:rect(svg),iconColor:getComputedStyle(svg).color,tertiary,
                  iconShrink:getComputedStyle(svg).flexShrink,strong:rect(strong),strongScroll:strong.scrollWidth,strongClient:strong.clientWidth,
                  strongOverflow:css.overflow,strongEllipsis:css.textOverflow,strongWhiteSpace:css.whiteSpace,strongFontSize:parseFloat(css.fontSize),strongTitle:strong.getAttribute('title'),
                  ahead:rect(title.querySelector('span')),aheadText:title.querySelector('span').textContent,
                  caps:caps.map(rect),radius:getComputedStyle(el).borderRadius,border:getComputedStyle(el).borderTopWidth,
                  class:el.className,position:getComputedStyle(el).position,left:getComputedStyle(el).left,width:getComputedStyle(el).width,innerWidth:window.innerWidth};
            }""")
            results['surfaces'][surface][str(width)] = m
            key = f'{surface}-{width}'
            check(abs(m['icon']['width'] - 16) <= .5 and abs(m['icon']['height'] - 16) <= .5, key + ' icon', m)
            check(m['iconShrink'] == '0' and m['iconColor'] == m['tertiary'], key + ' icon style', m)
            check(m['strongScroll'] > m['strongClient'] and m['strong']['width'] >= m['strongFontSize'] and m['strongOverflow'] == 'hidden' and m['strongEllipsis'] == 'ellipsis' and m['strongWhiteSpace'] == 'nowrap', key + ' title ellipsis', m)
            check(m['strongTitle'] == LONG_BRANCH, key + ' full branch title', m)
            check(m['aheadText'] == '↑12' and m['ahead']['width'] > 0 and len(m['caps']) == 2 and all(cap['width'] >= 32 and cap['height'] >= 32 and cap['left'] >= m['header']['left'] - .5 and cap['right'] <= m['header']['right'] + .5 for cap in m['caps']) and m['title']['right'] <= m['caps'][0]['left'] + .5 and m['caps'][0]['right'] <= m['caps'][1]['left'] + .5, key + ' caps', m)
            if width <= 390:
                expected = '24px' if surface == 'pas' else '0px'
                check(m['radius'] == expected and m['pane']['left'] >= -.5 and m['pane']['right'] <= width + .5 and (surface != 'pas' or m['border'] != '0px'), key + ' radius and viewport', m)
            if surface == 'pas' or (width <= 390 and surface in ('card', 'folder')):
                page.screenshot(path=str(out / f'{surface}-{width}.png'), animations='disabled')
        context.close()
    labels = {'unsupported': '이 노드는 파일 보기를 지원하지 않습니다.', 'no_workspace': '작업 폴더가 없습니다.', 'empty': '바뀐 파일 없음'}
    for scene in ('offline', 'error', 'not_git', 'unsupported', 'no_workspace', 'empty', 'expanded'):
        context, page, workspace, pane = open_surface('card', scene)
        if scene == 'error': expect(pane.get_by_role('button', name='다시 시도')).to_be_visible()
        elif scene in labels: expect(pane.get_by_text(labels[scene], exact=True)).to_be_visible()
        else: expect(pane.get_by_text('읽기만 한 파일', exact=False)).to_be_visible()
        if scene == 'expanded': pane.get_by_role('button', name='읽기만 한 파일', exact=False).click()
        results['states'][scene] = {}
        for width in (1440, 360):
            resize(page, workspace, pane, width)
            if scene in ('offline', 'error', 'not_git'):
                notice = pane.locator('.v3-session-files-notice')
                m = notice.evaluate("""el => {const r=el.getBoundingClientRect(),s=getComputedStyle(el), b=el.querySelector('button'), br=b?.getBoundingClientRect(), range=document.createRange();if(b)range.selectNodeContents(b);return {radius:s.borderRadius,right:r.right,top:r.top,bottom:r.bottom,paddingRight:parseFloat(s.paddingRight), button:br?{left:br.left,right:br.right,top:br.top,bottom:br.bottom,width:br.width,height:br.height,textRects:range.getClientRects().length}:null}}""")
                results['states'][scene][str(width)] = m
                check(m['radius'] == '12px', f'{scene}-{width} radius', m)
                if scene == 'error':
                    b = m['button']
                    check(b and b['textRects'] == 1 and b['width'] > 0 and b['left'] >= 0 and b['right'] <= width and b['top'] >= m['top'] and b['bottom'] <= m['bottom'] and abs(m['right'] - b['right'] - m['paddingRight']) <= 1, f'error-{width} retry position', m)
                    text = pane.locator('[data-slot="dialog-error-message"]'); r = text.bounding_box()
                    page.mouse.move(r['x'] + 1, r['y'] + r['height'] / 2); page.mouse.down(); page.mouse.move(r['x'] + r['width'] - 1, r['y'] + r['height'] / 2, steps=12); page.mouse.up()
                    m['selection'] = page.evaluate('window.getSelection().toString()')
                    check('파일을 불러오지 못했습니다' in m['selection'], f'error-{width} selectable', m)
            elif scene in labels:
                m = pane.evaluate("""(el, label) => {const p=[...el.querySelectorAll('p')].find(e=>e.textContent===label),t=el.querySelector('.v3-session-files-title strong'),s=getComputedStyle(p);return {left:p.getBoundingClientRect().left,titleLeft:t.getBoundingClientRect().left,font:s.font,color:s.color}}""", labels[scene])
                results['states'][scene][str(width)] = m
                check(abs(m['left'] - m['titleLeft']) <= 1, f'{scene}-{width} alignment', m)
            else:
                m = pane.evaluate("""el => {const toggle=el.querySelector('.v3-session-files-row[aria-expanded=true]'),a=toggle.nextElementSibling,b=a.nextElementSibling,p=a.querySelector('p'),row=a.querySelector('button');return {first:a.getBoundingClientRect().top-toggle.getBoundingClientRect().bottom,next:b.getBoundingClientRect().top-a.getBoundingClientRect().bottom,pathToRow:row.getBoundingClientRect().top-p.getBoundingClientRect().bottom}}""")
                results['expanded'][str(width)] = m
                check(m['pathToRow'] < m['first'] <= m['next'] and m['next'] == 16, f'expanded-{width} spacing', m)
            if scene != 'empty': page.screenshot(path=str(out / f'{"read-expanded" if scene == "expanded" else scene}-{width}.png'), animations='disabled')
        context.close()
    for width in ('1440', '360'):
        reference = results['states']['empty'][width]
        for scene in ('unsupported', 'no_workspace'):
            m = results['states'][scene][width]
            check(m['font'] == reference['font'] and m['color'] == reference['color'], f'{scene}-{width} typography', {'actual': m, 'empty': reference})
    return results, errors

def assert_pas_width(result):
    failures = []
    def check(ok, name, value):
        if not ok: failures.append({"check": name, "detail": value})
    for width in _pas_module.TASK_WIDTHS:
        before, after = (result['tasks'][side][str(width)] for side in ('before', 'after'))
        for part in ('main', 'composer', 'pane'):
            check(all(abs(before[part][key] - after[part][key]) <= .5 for key in ('left', 'top', 'width', 'height')), f'tasks-{width}-{part}', {'before': before[part], 'after': after[part]})
    for part in ('main', 'composer', 'pane'):
        before, after = result['tasks']['after']['900'][part], result['tasks']['restored'][part]
        check(all(abs(before[key] - after[key]) <= .5 for key in ('left', 'top', 'width', 'height')), f'tasks-restored-{part}', {'before': before, 'after': after})
    for width in _pas_module.WIDTHS:
        m = result['files'][str(width)]
        check(m['draft'] == 'PAS 파일 확인 중', f'pas-{width}-draft', m['draft'])
        check(m['branch']['title'] == 'card1789-files-dashboard', f'pas-{width}-branch-title', m['branch'])
        if width >= 768:
            check(m['after']['main']['width'] >= 360 and m['after']['main']['right'] <= m['pane']['left'] + .5, f'pas-{width}-columns', m)
            for name in ('event_outbox_types.ts', 'outbox_retry.ts'):
                item = m['names'].get(name)
                check(item and item['scroll'] <= item['client'] and item['rect']['left'] >= m['pane']['left'] and item['rect']['right'] <= m['pane']['right'], f'pas-{width}-{name}', item)
            for label, expected in (('label', '읽기만 한 파일'), ('badge', '일부'), ('count', '1개')):
                item = m['read'][label]
                check(item['text'] == expected and item['scroll'] <= item['client'] and item['rect']['width'] > 0 and item['rect']['left'] >= m['pane']['left'] and item['rect']['right'] <= m['pane']['right'], f'pas-{width}-read-{label}', item)
        else:
            check(m['coversChat'] and m['radius'] == '24px' and m['border'] != '0px', f'pas-{width}-mobile', m)
        check(abs(m['before']['composer']['top'] - m['after']['composer']['top']) <= 1, f'pas-{width}-composer-y', m)
    branch = result['files']['1440']['branch']
    check(branch['scroll'] <= branch['client'], 'pas-1440-branch-visible', branch)
    assert not failures, json.dumps(failures, ensure_ascii=False)


def capture_diff(browser, base, out):
    results = {}
    scenarios = [
        ("diff-card-1440", "card", "dark", "diff-ready"),
        ("diff-pas-384", "pas", "dark", "diff-ready"),
        ("diff-light-1440", "card", "light", "diff-ready"),
        ("diff-new", "pas", "dark", "diff-new"),
        ("diff-deleted", "pas", "dark", "diff-deleted"),
        ("diff-renamed", "pas", "dark", "diff-renamed"),
        ("diff-binary", "pas", "dark", "diff-binary"),
        ("diff-truncated", "pas", "dark", "diff-truncated"),
        ("diff-loading", "pas", "dark", "diff-loading"),
        ("diff-error", "pas", "dark", "diff-error"),
        ("diff-old-node", "pas", "dark", "diff-old"),
        ("diff-not-git", "card", "dark", "not_git"),
    ]
    for name, surface, theme, scene in scenarios:
        context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme=theme, reduced_motion="reduce", locale="ko-KR", service_workers="block")
        page = context.new_page()
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        requests = {"workspace": 0}
        install_routes(page, scene, requests)
        if surface == "pas":
            page.goto(base + "/persistent/components-session", wait_until="domcontentloaded")
            trigger = page.get_by_role("button", name="세션 파일", exact=True)
            expect(trigger).to_be_visible(timeout=60000); trigger.click()
            pane = page.get_by_role("region", name="세션 파일")
        else:
            page.goto(base + "/components", wait_until="domcontentloaded")
            page.get_by_test_id("card-board-sample").locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click(timeout=60000)
            workspace = page.get_by_test_id("v3-card-workspace")
            trigger = workspace.get_by_role("button", name="파일", exact=True)
            expect(trigger).to_be_visible(timeout=60000); trigger.click()
            pane = workspace.get_by_role("region", name="세션 파일")
        expect(pane).to_be_visible()
        if scene == "not_git":
            expect(pane.get_by_text("Git 작업 폴더가 아닙니다")).to_be_visible()
        else:
            filename = {"diff-new": "outbox_retry.ts", "diff-deleted": "retry_constants.ts", "diff-renamed": "outbox_retry.test.ts", "diff-binary": "outbox.db"}.get(scene, "event_outbox.ts")
            if scene == "diff-binary":
                pane.get_by_role("button", name="다른 변경", exact=False).click()
                expect(pane.get_by_text("셸로 고친 파일은 여기 나옵니다")).to_be_visible()
            row = pane.get_by_role("button", name=filename, exact=False)
            expect(row).to_be_visible(timeout=60000)
            row.click(); page.mouse.move(2, 2)
            expect(row).to_have_attribute("aria-expanded", "true")
            box = pane.get_by_role("region", name=f"{filename} 변경분")
            expect(box).to_be_visible()
            states = {"diff-new": "새 파일", "diff-deleted": "지움", "diff-renamed": "바뀐 내용 없음",
                      "diff-binary": "바이너리 파일", "diff-truncated": "앞 512KiB만 보입니다",
                      "diff-error": "변경분을 불러오지 못했습니다", "diff-old": "이 노드는 아직 변경분을 보이지 않습니다"}
            if scene in states: expect(box.get_by_text(states[scene], exact=True)).to_be_visible()
            elif scene == "diff-loading": expect(box.get_by_label("변경분을 읽는 중")).to_be_visible()
            else: expect(box.locator('[data-kind="add"]').first).to_be_visible()
            if scene == "diff-deleted": expect(box.get_by_role("button", name="전체 보기")).to_have_count(0)
            if scene == "diff-new":
                assert box.locator('[data-kind="add"]').count() == len(_diff_fixture.NEW_LINES)
                assert f"+{len(_diff_fixture.NEW_LINES)}" in row.inner_text() and "−" not in row.inner_text()
            if scene == "diff-deleted":
                assert box.locator('[data-kind="del"]').count() == len(_diff_fixture.DELETED_LINES)
                assert f"−{len(_diff_fixture.DELETED_LINES)}" in row.inner_text() and "+0" not in row.inner_text()
            if scene == "diff-ready":
                expect(box.locator(".v3-session-file-diff-body")).to_have_css("padding-left", "0px")
                diff_body = box.locator(".v3-session-file-diff-body")
                assert box.locator('[data-kind="add"]').count() == _diff_fixture.EVENT_ADD
                assert box.locator('[data-kind="del"]').count() == _diff_fixture.EVENT_DEL
                content = diff_body.evaluate("""el => {
                    el.scrollTop = el.scrollHeight;
                    return {height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop,
                      digits: el.style.getPropertyValue('--v3-diff-digits')};
                }""")
                assert content["scrollHeight"] > content["height"] and content["top"] > 0 and int(content["digits"]) >= 3, content
                m = pane.evaluate("""el => {
                    const rect = e => {const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
                    const row=el.querySelector('.v3-session-files-entry.is-open .v3-session-files-row'), h=el.querySelector('.v3-session-files-section h3 button'), box=el.querySelector('.v3-session-file-diff'), head=box.querySelector('.v3-session-file-diff-head'), line=box.querySelector('.v3-session-file-diff-line'), icon=row.querySelector('.v3-session-files-mark'), num=line.querySelector('.v3-session-file-diff-num'), action=head.querySelector('button svg'), arrow=h.querySelector('svg'), diff=box.querySelector('.v3-session-file-diff-body');
                    return {row:rect(row),icon:rect(icon),heading:rect(h.querySelector('.v3-persistent-task-group-name')),arrow:rect(arrow),status:rect(head.querySelector('.v3-session-file-diff-status')),number:rect(num),action:rect(action),diff:rect(diff),line:rect(line),linePadding:getComputedStyle(line).padding,bodyPadding:getComputedStyle(diff).padding,scrollLeft:diff.scrollLeft,scrollWidth:diff.scrollWidth,clientWidth:diff.clientWidth};
                }""")
                assert m["scrollWidth"] <= m["clientWidth"], m
                assert max(abs(m["heading"]["left"] - m[key]["left"]) for key in ("icon", "status", "number")) <= 1, m
                assert abs(m["arrow"]["right"] - m["action"]["right"]) <= 1, m
                assert abs(m["row"]["left"] - pane.locator(".v3-persistent-task-group-toggle").first.bounding_box()["x"]) <= 1
                assert abs(m["row"]["right"] - (pane.locator(".v3-persistent-task-group-toggle").first.bounding_box()["x"] + pane.locator(".v3-persistent-task-group-toggle").first.bounding_box()["width"])) <= 1
                results[name] = {"alignment": m, "content": content}
        page.evaluate("document.fonts.ready")
        page.mouse.move(2, 2)
        assert page.evaluate("() => document.querySelector(':focus-visible') === null"), f"기본 그림에 키보드 초점 고리: {scene}"
        if scene == "diff-ready":
            outline = box.locator(".v3-session-file-diff-body").evaluate("e => getComputedStyle(e).outlineStyle")
            assert outline == "none", f"기본 그림에 본문 초점 고리: {outline}"
        page.screenshot(path=str(out / (name + ".png")), animations="disabled")
        if "pending_diff" in requests: requests["pending_diff"].abort()
        if scene == "diff-ready" and surface == "card" and theme == "dark":
            for path, expected_status, expected_counts in (
                (f"{_diff_fixture.UP}/outbox_retry.ts", "untracked", (len(_diff_fixture.NEW_LINES), 0)),
                ("soul-server-ts/src/config.ts", "modified", (_diff_fixture.CONFIG_ADD, _diff_fixture.CONFIG_DEL)),
            ):
                payload = page.evaluate("""async path => {
                    const url='/api/sessions/components-session/workspace/diff?path='+encodeURIComponent(path);
                    return (await fetch(url)).json();
                }""", path)
                changes = [line for line in payload["text"].splitlines() if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
                counts = (sum(line.startswith("+") for line in changes), sum(line.startswith("-") for line in changes))
                assert payload["status"] == expected_status and f"b/{path}" in payload["text"].splitlines()[0] and counts == expected_counts, (path, payload, counts)
            pane.get_by_role("button", name="이번 세션", exact=False).hover()
            pane.screenshot(path=str(out / "diff-hover-card-1440.png"), animations="disabled")
            page.mouse.move(2, 2)
            body = pane.locator(".v3-session-files-body")
            scroll_before = body.evaluate("e => e.scrollTop")
            page.set_viewport_size({"width": 1024, "height": 900})
            page.wait_for_function("""wide => {
                const pane=document.querySelector('[data-testid="v3-card-workspace"] .v3-session-files-pane');
                const body=pane?.querySelector('.v3-session-file-diff-body');
                return innerWidth === 1024 && body && body.clientWidth < wide - 1
                    && Math.abs(pane.getBoundingClientRect().width - 324) <= 1;
            }""", arg=m["clientWidth"])
            expect(row).to_have_attribute("aria-expanded", "true")
            page.mouse.move(2, 2)
            narrow = pane.evaluate("""el => {
                const pane=el.getBoundingClientRect(), body=el.querySelector('.v3-session-file-diff-body').getBoundingClientRect();
                const outside=[...el.querySelectorAll('*')].filter(e => {
                    const r=e.getBoundingClientRect();
                    return r.width > 0 && (r.left < pane.left - 1 || r.right > pane.right + 1);
                }).map(e => e.className?.baseVal ?? e.className);
                return {width:body.width, right:body.right, paneLeft:pane.left, paneRight:pane.right, outside, viewport:innerWidth};
            }""")
            assert narrow["right"] <= narrow["paneRight"] + 1, narrow
            assert narrow["width"] < m["clientWidth"], narrow
            assert not narrow["outside"], narrow
            assert box.locator(".v3-session-file-diff-body").evaluate("e => getComputedStyle(e).outlineStyle") == "none"
            assert page.evaluate("() => document.querySelector(':focus-visible') === null"), "1024px 기본 그림에 키보드 초점 고리"
            page.screenshot(path=str(out / "diff-card-1024.png"), animations="disabled")
            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_function("""wide => {
                const body=document.querySelector('[data-testid="v3-card-workspace"] .v3-session-file-diff-body');
                return innerWidth === 1440 && body && Math.abs(body.clientWidth - wide) <= 1;
            }""", arg=m["clientWidth"])
            expect(row).to_have_attribute("aria-expanded", "true")
            assert abs(body.evaluate("e => e.scrollTop") - scroll_before) <= 2
        if scene == "diff-ready":
            row.focus(); page.keyboard.press("Tab")
            full = box.get_by_role("button", name="전체 보기")
            expect(full).to_be_focused()
            page.keyboard.press("Tab")
            expect(box.get_by_role("tab", name="커밋 전 변경")).to_be_focused()
            page.keyboard.press("Tab")
            expect(box.get_by_role("tab", name="세션 기록")).to_be_focused()
            page.keyboard.press("Tab")
            expect(box.locator(".v3-session-file-diff-body")).to_be_focused()
            results[name]["tab"] = ["행", "전체 보기", "커밋 전 변경", "세션 기록", "diff 본문"]
        if scene == "diff-ready" and surface == "card" and theme == "dark":
            full.click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_be_visible()
            page.wait_for_function("document.querySelector('[data-slot=dialog-popup][data-attachment-kind]')?.contains(document.activeElement)", timeout=5000)
            page.keyboard.press("Escape"); expect(dialog).to_have_count(0); expect(full).to_be_focused()
            row.focus(); page.keyboard.press("Space"); expect(row).to_have_attribute("aria-expanded", "false"); expect(row).to_be_focused()
            page.keyboard.press("Space"); expect(row).to_have_attribute("aria-expanded", "true")
            page.keyboard.press("Escape"); expect(pane).to_have_count(0)
            results[name]["operations"] = {"focus": "행과 전체 보기 복귀", "escape": "보기와 칸 순서대로 닫힘", "resize": "1024 ↔ 1440 펼침과 스크롤 유지", "narrow": narrow}
        context.close()
    return results

def capture_session_history(browser, baseline, base, out):
    results = {}
    scenarios = [
        ("session-card-1440", "card", "dark", "session-ready", False),
        ("session-pas-384", "pas", "dark", "session-ready", False),
        ("session-tabs-1440", "card", "dark", "session-ready", True),
        ("session-no-workspace-1440", "card", "dark", "session-no-workspace", False),
        ("session-unrecorded-384", "pas", "dark", "session-unrecorded", False),
        ("session-light-1440", "card", "light", "session-ready", False),
        ("session-mixed-1440", "card", "dark", "session-mixed", False),
        ("session-truncated-1440", "card", "dark", "session-truncated", False),
        ("session-error-1440", "card", "dark", "session-error", False),
    ]
    for name, surface, theme, scene, tabs in [("session-before-1440", "card", "dark", "session-ready", False), ("session-before-384", "pas", "dark", "session-ready", False)] + scenarios:
        old = name.startswith("session-before")
        width = 384 if surface == "pas" else 1440
        context = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=theme, reduced_motion="reduce", locale="ko-KR", service_workers="block")
        page=context.new_page()
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        install_routes(page, scene)
        if surface == "pas":
            page.goto((baseline if old else base) + "/persistent/components-session", wait_until="domcontentloaded")
            trigger=page.get_by_role("button", name="세션 파일", exact=True)
        else:
            page.goto((baseline if old else base) + "/components", wait_until="domcontentloaded")
            page.get_by_test_id("card-board-sample").locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click(timeout=60000)
            trigger=page.get_by_test_id("v3-card-workspace").get_by_role("button", name="파일", exact=True)
        expect(trigger).to_be_visible(timeout=60000); trigger.click()
        pane=page.get_by_role("region", name="세션 파일")
        filename="event_outbox.ts" if tabs else "event_outbox_types.ts"
        row=pane.get_by_role("button", name=filename, exact=False)
        expect(row).to_be_visible(timeout=60000)
        old_row = row.element_handle() if old else None
        row.click()
        if old:
            try:
                assert old_row.get_attribute("aria-expanded") == "true"
            except AssertionError:
                pass
            else:
                raise AssertionError("수정 전 코드가 새 단언을 이미 만족함")
            page.screenshot(path=str(out / (name + ".png")), animations="disabled")
            results["before_red"] = "커밋된 행에 펼침 속성이 없어 새 단언 실패"
            context.close(); continue
        expect(row).to_have_attribute("aria-expanded", "true")
        box=pane.get_by_role("region",name=f"{filename} 변경분")
        if scene == "session-error":
            expect(box.get_by_text("변경분을 불러오지 못했습니다")).to_be_visible()
            page.screenshot(path=str(out / "session-error-before-retry.png"),animations="disabled")
            box.get_by_role("button",name="다시 시도").click()
        if tabs:
            tab=box.get_by_role("tab",name="세션 기록"); tab.click(); expect(box.get_by_role("tab",name="세션 기록")).to_be_focused()
        if scene == "session-unrecorded": expect(box.get_by_text("이 엔진은 고친 내용을 기록에 남기지 않습니다")).to_be_visible()
        else:
            expect(box.get_by_text("1/3",exact=False)).to_be_visible()
            expect(box.get_by_text("전체 씀",exact=False)).to_be_visible()
        if scene == "session-no-workspace":
            expect(pane.get_by_text("작업 폴더가 지워져",exact=False)).to_be_visible()
            expect(box.get_by_role("button",name="전체 보기")).to_have_count(0)
        if scene == "session-mixed": expect(box.get_by_text("내용이 기록되지 않은 편집 2번")).to_be_visible()
        if scene == "session-truncated": expect(box.get_by_text("기록이 길어 오래된 편집은 빠졌습니다")).to_be_visible()
        page.mouse.move(2,2); page.screenshot(path=str(out / (name + ".png")),animations="disabled")
        metrics=pane.evaluate("""el => {const r=el.getBoundingClientRect(), b=el.querySelector('.v3-session-file-diff-body');return {pane:{left:r.left,right:r.right,width:r.width},scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,bodyWidth:b?.clientWidth,bodyScroll:b?.scrollWidth}}""")
        assert metrics["scrollWidth"] <= metrics["clientWidth"] and metrics["bodyScroll"] <= metrics["bodyWidth"], metrics
        if tabs:
            row.focus(); page.keyboard.press("Tab"); expect(box.get_by_role("button",name="전체 보기")).to_be_focused()
            page.keyboard.press("Tab"); expect(box.get_by_role("tab",name="커밋 전 변경")).to_be_focused()
            page.keyboard.press("Tab"); expect(box.get_by_role("tab",name="세션 기록")).to_be_focused()
            page.set_viewport_size({"width":1024,"height":900}); expect(row).to_have_attribute("aria-expanded","true")
            page.set_viewport_size({"width":1440,"height":900}); expect(row).to_have_attribute("aria-expanded","true")
            page.keyboard.press("Escape"); expect(pane).to_have_count(0)
        results[name]=metrics
        context.close()
    return results

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--output", required=True); parser.add_argument("--baseline-dist", required=True); parser.add_argument("--session-only", action="store_true"); parser.add_argument("--story-only", action="store_true"); parser.add_argument("--retention-only", action="store_true"); parser.add_argument("--layout-only", action="store_true"); parser.add_argument("--pas-width-only", action="store_true"); parser.add_argument("--diff-only", action="store_true"); parser.add_argument("--skip-diff", action="store_true"); args = parser.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    server, base = serve(DIST)
    baseline_server, baseline_base = serve(Path(args.baseline_dist))
    measurements = {}
    try:
        with sync_playwright() as p, ExitStack() as browser_cleanup:
            browser = p.chromium.launch(headless=True)
            browser_cleanup.callback(browser.close)
            measurements["session_history"] = capture_session_history(browser, baseline_base, base, out)
            if args.session_only: return
            if args.pas_width_only:
                measurements['pas_width'] = _pas_module.capture_pas_width(browser, baseline_base, base, out, install_routes)
                assert_pas_width(measurements['pas_width'])
                return
            if args.layout_only:
                measurements['layout'], failures = capture_layout_checks(browser, base, out)
                assert not failures, json.dumps(failures, ensure_ascii=False)
                return
            if args.retention_only:
                measurements['retention'] = capture_retention(browser, base)
                return
            if not args.skip_diff: measurements["diff"] = capture_diff(browser, base, out)
            if args.diff_only: return
            measurements["story"] = story_comparison(browser, baseline_base, base, out)
            assert measurements["story"]["before"] == measurements["story"]["after"], measurements["story"]
            if args.story_only: return
            measurements.update(capture_pas_and_folder(browser, base, out))
            measurements['pas_width'] = _pas_module.capture_pas_width(browser, baseline_base, base, out, install_routes)
            assert_pas_width(measurements['pas_width'])
            for width, scene in [(1440, "ready"), (390, "ready"), (1440, "loading"), (1440, "offline"), (1440, "error"), (360, "long"), (390, "light")]:
                theme = "light" if scene == "light" else "dark"
                context = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=theme, reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
                page = context.new_page()
                requests = {"workspace": 0}
                page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
                install_routes(page, scene, requests)
                page.goto(base + "/components", wait_until="domcontentloaded")
                sample = page.get_by_test_id("card-board-sample")
                sample.locator('[data-card-id="board-size-comparison"] .v3-postit-open').first.click()
                workspace = page.get_by_test_id("v3-card-workspace")
                expect(workspace.get_by_test_id("card-detail")).to_be_visible()
                if width < 760: page.get_by_test_id("v3-mobile-tab-chat").click()
                trigger = workspace.get_by_role("button", name="파일", exact=True)
                expect(trigger).to_be_visible(timeout=60000)
                chat = workspace.get_by_test_id("v3-card-session-chat")
                before = chat.bounding_box()
                if width == 1440 and scene == "ready": chat.locator('.v3-chat-content').screenshot(path=str(out / "unchanged-before.png"), animations="disabled")
                trigger.click()
                pane = workspace.get_by_role("region", name="세션 파일")
                expect(pane).to_be_visible()
                if scene == "loading": expect(pane.get_by_text("파일 상태를 읽는 중")).to_be_visible()
                elif scene == "offline": expect(pane.get_by_text("노드 끊김", exact=False)).to_be_visible()
                elif scene == "error": expect(pane.get_by_role("button", name="다시 시도")).to_be_visible()
                else:
                    expect(pane.get_by_text("outbox_retry.ts")).to_be_visible()
                    expect(pane.locator('[data-activity="commit"]')).to_have_count(1)
                page.evaluate("document.fonts.ready")
                name = {"loading":"loading.png", "offline":"offline.png", "error":"error.png", "long":"long-names.png", "light":"light-panel.png"}.get(scene, "wide-panel.png" if width == 1440 else "narrow-panel.png")
                page.screenshot(path=str(out / name), animations="disabled")
                box = pane.bounding_box(); after = chat.bounding_box()
                info = page.evaluate("""() => { const pane = document.querySelector('[data-testid="v3-card-workspace"] .v3-session-files-pane'); const h = pane.querySelector('.v3-chat-header'); const b = pane.getBoundingClientRect(), r = h.getBoundingClientRect(); const names = [...pane.querySelectorAll('.v3-session-files-name')].map(e => {const x=e.getBoundingClientRect();return {left:x.left,right:x.right,width:x.width,scroll:e.scrollWidth,client:e.clientWidth,ellipsis:getComputedStyle(e).textOverflow}}); return {pane: {left:b.left,right:b.right,top:b.top,bottom:b.bottom}, header:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}, names, scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth, active:document.activeElement?.getAttribute('aria-label')}; }""")
                if scene == "offline":
                    info["timestamp"] = pane.get_by_role("status").inner_text()
                    assert "11. 23." in info["timestamp"] and "기준" in info["timestamp"], info
                if scene == "long":
                    info["group_gaps"] = pane.locator('.v3-session-files-list > .v3-session-files-group').evaluate_all("els => els.slice(1).map((el,i) => el.getBoundingClientRect().top - els[i].getBoundingClientRect().bottom)")
                    assert all(gap >= 16 for gap in info["group_gaps"]), info
                assert info["scrollWidth"] <= info["clientWidth"], info
                assert abs(info["pane"]["left"] - info["header"]["left"]) <= 1 and abs(info["pane"]["top"] - info["header"]["top"]) <= 1, info
                for name_box in info["names"]:
                    assert name_box["width"] >= 32 and name_box["left"] >= info["pane"]["left"] and name_box["right"] <= info["pane"]["right"]
                    assert name_box["scroll"] <= name_box["client"] or name_box["ellipsis"] == "ellipsis"
                if width == 1440 and scene == "ready":
                    assert abs(before["width"] - after["width"]) <= 1
                    chat.locator('.v3-chat-content').screenshot(path=str(out / "unchanged-after.png"), animations="disabled")
                    info["unchanged_equal"] = (out / "unchanged-before.png").read_bytes() == (out / "unchanged-after.png").read_bytes()
                    assert info["unchanged_equal"]
                    assert info["active"] == "다시 읽기"
                    info["tab"] = ["다시 읽기"]
                    for _ in range(6):
                        page.keyboard.press("Tab")
                        info["tab"].append(page.evaluate("document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()"))
                    assert info["tab"] == ["다시 읽기", "파일 닫기", "이번 세션3개일부", "event_outbox_types.ts", f"event_outbox.ts+{_diff_fixture.EVENT_ADD}−{_diff_fixture.EVENT_DEL}", f"outbox_retry.ts새+{len(_diff_fixture.NEW_LINES)}", "읽기만 한 파일1개"], info["tab"]
                    pane.get_by_role("button", name="다른 변경", exact=False).click()
                    pane.get_by_text("event_outbox.ts", exact=True).click()
                    pane.get_by_role("region", name="event_outbox.ts 변경분").get_by_role("button", name="전체 보기").click()
                    expect(page.get_by_role("dialog")).to_be_visible()
                    dialog = page.get_by_role("dialog")
                    expect(dialog.locator('pre')).to_contain_text('// session file preview')
                    page.screenshot(path=str(out / "wide-preview.png"), animations="disabled")
                    info["preview_tab"] = []
                    for _ in range(7):
                        page.keyboard.press("Tab")
                        info["preview_tab"].append(page.evaluate("""() => {const e=document.activeElement;return {label:e?.getAttribute('aria-label'),slot:e?.getAttribute('data-slot'),text:e?.textContent?.trim()?.slice(0,35)}}"""))
                    tab_names = [entry['label'] or entry['slot'] for entry in info['preview_tab']]
                    assert tab_names == ['dialog-panel', '이전 첨부', '다음 첨부', '원본 저장', '닫기', 'dialog-panel', '이전 첨부'], tab_names
                    info["preview_navigation"] = []
                    name = dialog.locator('[data-slot="attachment-name"]')
                    previous = dialog.get_by_role('button', name='이전 첨부')
                    following = dialog.get_by_role('button', name='다음 첨부')
                    previous.click(); info["preview_navigation"].append(name.inner_text())
                    expect(previous).to_have_attribute('aria-disabled', 'true'); page.keyboard.press('ArrowLeft'); assert name.inner_text() == 'event_outbox_types.ts'
                    following.click(); info["preview_navigation"].append(name.inner_text())
                    page.keyboard.press('ArrowRight'); info["preview_navigation"].append(name.inner_text())
                    page.keyboard.press('ArrowRight'); info["preview_navigation"].append(name.inner_text())
                    expect(following).to_have_attribute('aria-disabled', 'true'); page.keyboard.press('ArrowRight'); assert name.inner_text() == 'config.ts'
                    assert info["preview_navigation"] == ['event_outbox_types.ts', 'event_outbox.ts', 'outbox_retry.ts', 'config.ts']
                    page.keyboard.press('ArrowLeft'); info['preview_arrow_left'] = name.inner_text(); assert info['preview_arrow_left'] == 'outbox_retry.ts'
                    info["preview_bounds"] = []
                    for resized in [390, 1440]:
                        page.set_viewport_size({"width": resized, "height": 900}); wait_stable(page, dialog, 'rect')
                        rect = dialog.bounding_box(); assert rect and rect['x'] >= 0 and rect['y'] >= 0 and rect['x'] + rect['width'] <= resized and rect['y'] + rect['height'] <= 900, rect
                        info["preview_bounds"].append({"viewport": resized, **rect})
                    page.keyboard.press("Escape"); expect(page.get_by_role("dialog")).to_have_count(0)
                    info["preview_focus"] = page.evaluate("document.activeElement?.textContent")
                    page.keyboard.press("Escape"); expect(pane).to_have_count(0)
                    expect(trigger).to_be_focused()
                    info["close_focus"] = page.evaluate("document.activeElement?.textContent")
                    assert info["close_focus"] == "파일"
                if scene == "error":
                    error_text = pane.locator('[data-slot="dialog-error-message"]')
                    rect = error_text.bounding_box(); assert rect
                    page.mouse.move(rect['x'] + 1, rect['y'] + rect['height'] / 2); page.mouse.down(); page.mouse.move(rect['x'] + rect['width'] - 1, rect['y'] + rect['height'] / 2, steps=12); page.mouse.up()
                    info["error_selection"] = page.evaluate("window.getSelection().toString()")
                    assert "파일을 불러오지 못했습니다" in info["error_selection"], info
                    pane.get_by_role("button", name="다시 시도").click()
                    expect(pane.get_by_text("outbox_retry.ts")).to_be_visible()
                    info["retry"] = "recovered"
                if width == 390 and scene == "ready":
                    page.set_viewport_size({"width": 1440, "height": 900})
                    expect(pane).to_be_visible()
                    page.set_viewport_size({"width": 390, "height": 900})
                    expect(pane).to_be_visible()
                    info["resize"] = "panel retained"
                measurements[f"{scene}-{width}"] = info
                context.close()
            measurements['retention'] = capture_retention(browser, base)
            measurements['layout'], failures = capture_layout_checks(browser, base, out)
            assert not failures, json.dumps(failures, ensure_ascii=False)
    except Exception:
        print(f"실패 시 load (1분·5분·15분): {os.getloadavg()}", flush=True)
        raise
    finally:
        server.shutdown(); server.server_close(); baseline_server.shutdown(); baseline_server.server_close()
        (out / "measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__": main()

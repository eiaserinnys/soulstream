#!/usr/bin/env python3
"""Capture the real card workspace with intercepted workspace responses."""
from __future__ import annotations
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "unified-dashboard" / "dist"
SHORT_TEXT = b"// session file preview\n"
LONG_TEXT = ("// session file preview\n" + "".join(f"export const eventType{i:02} = 'session:{i:02}';\n" for i in range(40))).encode()
FILE = dict(orig_path=None, added=None, deleted=None, size=len(SHORT_TEXT), wrote=False, read=False, committed=False, last_activity_at=None)
DATA = {
    "session_id": "components-session", "root": "/workspace/card1789", "node": {"id": "eiaserinnys", "status": "ok"},
    "snapshot": {"state": "ready", "observed_at": "2026-11-22T15:12:00Z", "refreshing": False, "branch": "card1789-files-dashboard", "head": "abc", "upstream": "origin/main", "ahead": 1, "behind": 0, "truncated": False},
    "attribution": "partial", "files": [
        {**FILE, "path": "soul-server-ts/src/config.ts", "git_status": "modified", "added": 3, "deleted": 1},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox_types.ts", "size": len(LONG_TEXT), "git_status": None, "committed": True, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/event_outbox.ts", "git_status": "modified", "added": 42, "deleted": 18, "wrote": True},
        {**FILE, "path": "soul-server-ts/src/upstream/outbox_retry.ts", "git_status": "untracked", "added": 33, "deleted": 0, "wrote": True},
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
        if path == "/api/nodes/stream": return route.fulfill(content_type="text/event-stream", body=f"event: snapshot\ndata: {json.dumps([node])}\n\n")
        if path == "/api/sessions/stream": return route.fulfill(content_type="text/event-stream", body=f"event: session_list\ndata: {json.dumps({'type':'session_list', 'sessions':[summary], 'total':1})}\n\n")
        if path.endswith("/events"): return route.fulfill(content_type="text/event-stream", body='event: history_sync\ndata: {"type":"history_sync","last_event_id":80,"is_live":true,"status":"running"}\n\n')
        if path.endswith("/timeline"):
            messages = [{"id": n, "parent_event_id": None, "event_type": "assistant_message", "payload": {"timestamp": n, "content": f"대화 기록 {n}: 파일을 확인합니다.", "tool_use_id": str(n), "_final_for_live_stream": True}, "created_at": f"2026-10-01T00:{n // 60:02}:{n % 60:02}Z"} for n in range(80, 0, -1)]
            return route.fulfill(json={"messages": messages, "next_cursor": None})
        if path.endswith('/story'): return route.fulfill(json={"highlight": None, "narrative": "", "unfolded_turn_summaries": [], "narrative_through_event_id": 0, "fold_count": 0, "updated_at": None})
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
            if scene == "interaction":
                data["files"][0]["size"] = 0
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
        normal = style(); story.hover(); page.wait_for_timeout(250); hover = style()
        story.focus(); page.keyboard.press("Tab"); page.keyboard.press("Shift+Tab"); expect(story).to_be_focused(); page.wait_for_timeout(250); focus = style()
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
    expect(trigger).to_be_visible(timeout=15000)
    expect(trigger).to_have_attribute("data-appearance", "bare")
    expect(trigger).to_have_attribute("aria-pressed", "false")
    page.screenshot(path=str(out / "pas-entry.png"), animations="disabled")
    trigger.click(); expect(trigger).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_role("region", name="세션 파일")).to_be_visible()
    page.screenshot(path=str(out / "pas-panel.png"), animations="disabled")
    pas = trigger.evaluate("el => ({tag:el.tagName, pressed:el.getAttribute('aria-pressed'), className:el.className, ariaLabel:el.getAttribute('aria-label')})")
    page.goto(base + "/components?sample=session-files-folder", wait_until="domcontentloaded")
    trigger = page.get_by_role("button", name="파일", exact=True)
    expect(trigger).to_be_visible(timeout=15000); trigger.click()
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
    expect(trigger).to_be_visible(timeout=15000)
    draft = chat.locator('textarea')
    expect(draft).to_be_enabled(timeout=15000)
    draft.fill('파일 확인 중인 임시 글')
    scroller = chat.locator('[data-virtuoso-scroller="true"]')
    expect(scroller).to_be_visible(timeout=15000)
    page.wait_for_function("""() => {const e=document.querySelector('[data-testid="v3-card-session-chat"] [data-virtuoso-scroller="true"]');return e && e.scrollHeight > e.clientHeight + 200} """, timeout=15000)
    scroller.evaluate("e => {e.scrollTop = Math.floor((e.scrollHeight-e.clientHeight)/2); e.dispatchEvent(new Event('scroll'))}")
    page.wait_for_timeout(500)
    chat_before = scroller.evaluate('e => e.scrollTop')
    trigger.click()
    pane = workspace.get_by_role("region", name="세션 파일")
    expect(pane.get_by_text('example-39.ts')).to_be_attached()
    pane.get_by_text('config.ts', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog.locator('pre')).to_contain_text('// session file preview')
    expect(dialog.locator('.chat-image-viewer-metadata')).to_have_text(f'{len(SHORT_TEXT)} B')
    page.wait_for_function("document.querySelector('[data-slot=dialog-popup][data-attachment-kind]')?.contains(document.activeElement)", timeout=5000)
    page.keyboard.press('Escape'); expect(dialog).to_have_count(0)
    ranges = [entry['range'] for entry in requests['file_ranges'] if entry['path'].endswith('config.ts')]
    assert ranges == ['bytes=0-0', f'bytes=0-{len(SHORT_TEXT)-1}'], ranges
    read_toggle = pane.get_by_role('button', name='읽기만 한 파일', exact=False)
    expect(pane).to_be_visible(timeout=5000)
    expect(read_toggle).to_be_visible(timeout=5000)
    read_toggle.click(); expect(read_toggle).to_have_attribute('aria-expanded', 'true')
    body = pane.locator('.v3-session-files-body')
    body.evaluate("e => {e.scrollTop = e.scrollHeight - e.clientHeight - 100; e.dispatchEvent(new Event('scroll'))}")
    page.wait_for_timeout(200)
    file_before = body.evaluate('e => e.scrollTop')
    def geometry(): return body.evaluate("e => ({top:e.scrollTop, height:e.scrollHeight, client:e.clientHeight, anchor:getComputedStyle(e).overflowAnchor})")
    before_geometry = geometry()
    assert chat_before > 0 and file_before > 0, (chat_before, file_before)
    pane.get_by_role('button', name='파일 닫기').click()
    expect(draft).to_have_value('파일 확인 중인 임시 글')
    chat_after_close = scroller.evaluate('e => e.scrollTop')
    trigger.click(); expect(pane.get_by_text('example-39.ts')).to_be_attached()
    expect(read_toggle).to_have_attribute('aria-expanded', 'true')
    page.wait_for_timeout(200)
    file_after_open = body.evaluate('e => e.scrollTop')
    page.set_viewport_size({"width": 390, "height": 900}); page.wait_for_timeout(500)
    if workspace.get_attribute('data-mobile-view') != 'chat': page.get_by_test_id('v3-mobile-tab-chat').click()
    expect(pane).to_be_visible(); file_narrow = body.evaluate('e => e.scrollTop')
    narrow_geometry = geometry()
    page.set_viewport_size({"width": 1440, "height": 900}); page.wait_for_timeout(500)
    expect(draft).to_have_value('파일 확인 중인 임시 글')
    chat_wide = scroller.evaluate('e => e.scrollTop'); file_wide = body.evaluate('e => e.scrollTop')
    result = {"draft": draft.input_value(), "chat_scroll": [chat_before, chat_after_close, chat_wide], "file_scroll": [file_before, file_after_open, file_narrow, file_wide], "file_geometry": [before_geometry, narrow_geometry, geometry()], "read_only_expanded": read_toggle.get_attribute('aria-expanded'), "stale_size_preview_ranges": ranges}
    assert abs(chat_before - chat_after_close) <= 2 and abs(chat_before - chat_wide) <= 2, result
    assert all(abs(file_before - value) <= 2 for value in [file_after_open, file_narrow, file_wide]), result
    context.close()
    return result

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--output", required=True); parser.add_argument("--baseline-dist", required=True); parser.add_argument("--story-only", action="store_true"); parser.add_argument("--retention-only", action="store_true"); args = parser.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    server, base = serve(DIST)
    baseline_server, baseline_base = serve(Path(args.baseline_dist))
    measurements = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            if args.retention_only:
                measurements['retention'] = capture_retention(browser, base)
                return
            measurements["story"] = story_comparison(browser, baseline_base, base, out)
            assert measurements["story"]["before"] == measurements["story"]["after"], measurements["story"]
            if args.story_only: return
            measurements.update(capture_pas_and_folder(browser, base, out))
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
                expect(trigger).to_be_visible(timeout=15000)
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
                    assert info["tab"] == ["다시 읽기", "파일 닫기", "config.ts+3−1", "event_outbox_types.ts", "event_outbox.ts+42−18", "outbox_retry.ts새+33", "읽기만 한 파일일부1"], info["tab"]
                    pane.get_by_text("event_outbox_types.ts", exact=True).click()
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
                    expect(previous).to_have_attribute('aria-disabled', 'true'); page.keyboard.press('ArrowLeft'); assert name.inner_text() == 'config.ts'
                    following.click(); info["preview_navigation"].append(name.inner_text())
                    page.keyboard.press('ArrowRight'); info["preview_navigation"].append(name.inner_text())
                    page.keyboard.press('ArrowRight'); info["preview_navigation"].append(name.inner_text())
                    expect(following).to_have_attribute('aria-disabled', 'true'); page.keyboard.press('ArrowRight'); assert name.inner_text() == 'outbox_retry.ts'
                    assert info["preview_navigation"] == ['config.ts', 'event_outbox_types.ts', 'event_outbox.ts', 'outbox_retry.ts']
                    page.keyboard.press('ArrowLeft'); info['preview_arrow_left'] = name.inner_text(); assert info['preview_arrow_left'] == 'event_outbox.ts'
                    info["preview_bounds"] = []
                    for resized in [390, 1440]:
                        page.set_viewport_size({"width": resized, "height": 900}); page.wait_for_timeout(200)
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
            browser.close()
    finally:
        server.shutdown(); server.server_close(); baseline_server.shutdown(); baseline_server.server_close()
        (out / "measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__": main()

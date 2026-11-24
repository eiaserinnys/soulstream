#!/usr/bin/env python3
"""빌드된 대시보드와 가짜 관리 API로 MCP 설정을 조작하고 캡처한다."""
from __future__ import annotations
import argparse
import base64
import copy
import functools
import http.server
import io
import json
import os
import threading
from pathlib import Path
from urllib.parse import urlsplit, unquote
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / 'unified-dashboard' / 'dist'
NODES = ['eiaserinnys', 'eias-linegames', 'eias-linegames-wsl']
NAMES = ['arbor', 'atom', 'atom-nl', 'chrome-devtools', 'clipper', 'cloistermont', 'corksheet', 'dorothy-memory', 'eb-index', 'exa', 'haniel', 'kaleidoscope', 'mbti-mcp', 'ms-todo', 'nnow', 'openaiDeveloperDocs', 'opgg', 'outline', 'seosoyoung-mcp', 'serendipity', 'shay', 'slack', 'slides', 'soulstream', 'soulstream-cogito', 'trello']
IMAGE_BUFFER = io.BytesIO()
Image.new('RGB', (24, 24), 'blue').save(IMAGE_BUFFER, format='PNG')
FAKE_IMAGE = IMAGE_BUFFER.getvalue()
PROFILES = ['seosoyoung', 'ariella-system1', 'ariella-system2', 'keke', 'writer-seosoyoung', 'roselin', 'remiel', 'galiliel', 'utonium', 'seosoyoung-intervene'] + [f'{name}-{node}' for name in ['roselin', 'keke', 'utonium', 'seosoyoung', 'writer-seosoyoung'] for node in NODES[1:]]

def fixture():
    servers = []
    for i, name in enumerate(NAMES):
        kind = 'stdio' if name == 'chrome-devtools' else 'sse' if name == 'seosoyoung-mcp' else 'streamable_http'
        config = {'command': 'fake-tool', 'args': ['--example'], 'env': {'EXAMPLE': '{{secret:srv-chrome-devtools-env-EXAMPLE}}'}} if kind == 'stdio' else {'url': f'https://{name.lower()}.example.invalid/mcp', 'headers': {'Authorization': f'Bearer {{{{secret:srv-{name}-hdr-example}}}}'}, 'timeout': 30}
        if i >= 14: config.pop('headers', None)
        if name == 'exa': config['url'] += '?first=%7B%7Bsecret%3Asrv-exa-qry-first%7D%7D&second=%7B%7Benv%3AEXAMPLE_VAR%7D%7D'
        icon = {'kind': 'brand', 'slug': 'github', 'hex': '#181717'} if i == 0 else {'kind': 'symbol', 'name': 'plug', 'color': 'node-user'} if i == 1 else None
        overrides = {NODES[1]: {'type': kind, 'config': copy.deepcopy(config)}} if i < 11 else {}
        servers.append({'id': name, 'name': name, 'type': kind, 'config': config, 'node_scope': [] if i == 25 else NODES[:], 'node_overrides': overrides if i != 25 else {}, 'icon': icon, 'version': 1})
    profiles = [{'id': name, 'name': name, 'description': '가짜 검수 프로필', 'mcp_servers': [] if name == 'seosoyoung-intervene' else NAMES[:(i % 8 + 1)], 'hosted_tools': [], 'node_scope': NODES[:1], 'version': 1} for i, name in enumerate(PROFILES)]
    profiles[0]['hosted_tools'] = [{'type': 'web_search'}]
    secrets = [{'name': f'srv-{name}-hdr-example', 'updated_at': '2026-11-23T00:00:00Z', 'servers': [name], 'profiles': [PROFILES[0]]} for name in NAMES[:14]]
    secrets.append({'name': 'srv-chrome-devtools-env-EXAMPLE', 'updated_at': '2026-11-23T00:00:00Z', 'servers': ['chrome-devtools'], 'profiles': []})
    secrets.append({'name': 'srv-exa-qry-first', 'updated_at': '2026-11-23T00:00:00Z', 'servers': ['exa'], 'profiles': []})
    secrets.append({'name': 'unused-example', 'updated_at': '2026-11-23T00:00:00Z', 'servers': [], 'profiles': []})
    return {'current_revision': 14, 'servers': servers, 'profiles': profiles, 'secrets': secrets, 'bindings': [{'agent_id': 'example-agent', 'node_id': NODES[0], 'mcp_profile_id': PROFILES[0], 'version': 1}], 'managed_nodes': [{'node_id': node, 'connected': i != 2, 'central_sync_supported': True, 'ack': {'revision': 14-i}, 'applied_revision': 14-i} for i, node in enumerate(NODES)]}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if '.' not in urlsplit(self.path).path.rsplit('/', 1)[-1]: self.path = '/index.html'
        try: super().do_GET()
        except (BrokenPipeError, ConnectionResetError): pass
    def log_message(self, format, *args): pass

def serve(directory=DIST):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'

def install(page, base, data, requests, state='ready', theme='light'):
    def route_handler(route):
        request = route.request
        parsed = urlsplit(request.url)
        path = parsed.path
        if parsed.netloc != urlsplit(base).netloc:
            requests['external'].append(request.url); return route.abort()
        if path == '/brand-icons/index.json': requests['index'] += 1
        if path.startswith('/brand-icons/icons/'): requests.setdefault('icons', []).append(path)
        if not path.startswith('/api/'): return route.continue_()
        if path == '/api/auth/config': return route.fulfill(json={'authEnabled': True, 'devModeEnabled': False})
        if path == '/api/auth/status': return route.fulfill(json={'authenticated': True, 'user': {'email': 'qa@example.test', 'name': 'QA', 'isAdmin': True}})
        if path == '/api/health': return route.fulfill(json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'})
        if path == '/api/config/settings': return route.fulfill(json={'categories': []})
        if path == '/api/user/preferences': return route.fulfill(json={'preferences': {'appearance': theme, 'chatFontSize': 14, 'wallpaper': {'mode': 'plain'}}, 'hasBackground': False, 'backgroundUrl': None})
        if path == '/api/mcp/config':
            if state == 'loading': requests['held'] = route; return
            if state == 'error' and not requests.get('retried'): requests['retried'] = True; return route.fulfill(status=503, json={'code': 'FAKE_FAILURE', 'message': 'fixture'})
            if state == 'empty': return route.fulfill(json={**data, 'servers': [], 'profiles': [], 'secrets': []})
            if requests.get('ack_countdown') is not None:
                if requests['ack_countdown'] == 0:
                    for node in data['managed_nodes']:
                        if node['connected']: node['ack']['revision'] = data['current_revision']
                    del requests['ack_countdown']
                else: requests['ack_countdown'] -= 1
            return route.fulfill(json=data)
        if path == '/api/mcp/revisions': return route.fulfill(json={'revisions': [{'id': 10, 'target': 'server', 'target_id': 'arbor', 'created_at': '2026-11-23T00:00:00Z'}]})
        if path == '/api/mcp/server-icons' and request.method == 'POST':
            assert base64.b64decode(request.post_data_json['data_base64']) == FAKE_IMAGE
            return route.fulfill(json={'ref': '11111111-1111-4111-8111-111111111111', 'content_hash': 'a' * 64, 'url': '/api/mcp/server-icons/11111111-1111-4111-8111-111111111111?v=' + 'a' * 64})
        if path.startswith('/api/mcp/server-icons/'): return route.fulfill(body=FAKE_IMAGE, content_type='image/png')
        if path.startswith('/api/mcp/'):
            parts = path.split('/')
            if request.method == 'DELETE': return route.fulfill(status=409, json={'code': {'servers': 'MCP_SERVER_INUSE', 'profiles': 'MCP_PROFILE_INUSE', 'secrets': 'MCP_SECRET_INUSE'}.get(parts[3], 'MCP_REVISION_CONFLICT'), 'message': 'fixture'})
            if request.method == 'PUT' and parts[3] == 'servers':
                body = request.post_data_json; item = {'id': unquote(parts[4]), 'name': body.get('name'), 'type': body['type'], 'config': body['config'], 'node_scope': body['node_scope'], 'node_overrides': body.get('node_overrides', {}), 'icon': body.get('icon'), 'version': 1}
                if item['id'] == 'fake-new-server':
                    assert body['config']['headers']['Authorization'] == 'Bearer {{secret:fake-bearer}}'
                    assert body['inline_secrets']['fake-bearer'] == 'obviously-fake-value'
                    data['secrets'].append({'name': 'fake-bearer', 'updated_at': '2026-11-23T00:00:00Z', 'servers': [item['id']], 'profiles': []})
                data['servers'] = [server for server in data['servers'] if server['id'] != item['id']] + [item]; data['current_revision'] += 1
                requests['ack_countdown'] = 1
                return route.fulfill(json={'server': item, 'current_revision': data['current_revision']})
            if request.method == 'PUT' and parts[3] == 'profiles':
                body = request.post_data_json; profile = next(p for p in data['profiles'] if p['id'] == unquote(parts[4])); assert body['hosted_tools'] == profile['hosted_tools']; profile.update({key: body[key] for key in ['name', 'description', 'mcp_servers', 'hosted_tools']}); profile['version'] += 1; data['current_revision'] += 1
                return route.fulfill(json={'profile': profile, 'current_revision': data['current_revision']})
            return route.fulfill(json={'current_revision': data['current_revision'] + 1})
        if path.endswith('/stream') or path.endswith('/events'): return route.fulfill(content_type='text/event-stream', body=': fixture\n\n')
        if path == '/api/folders': return route.fulfill(json={'folders': [], 'sessions': {}})
        if path == '/api/sessions': return route.fulfill(json={'sessions': [], 'total': 0})
        if path == '/api/nodes': return route.fulfill(json={'nodes': []})
        if path == '/api/cards': return route.fulfill(json={'cards': []})
        if path == '/api/persistent-sessions': return route.fulfill(json={'sessions': [], 'total': 0, 'create_defaults': None})
        return route.fulfill(json={})
    page.route('**/*', route_handler)

def open_panel(page, base):
    page.goto(base + '/components?sample=mcp', wait_until='domcontentloaded')
    page.get_by_role('button', name='MCP 설정 열기').click(timeout=25000)

def capture(page, out, name):
    page.screenshot(path=str(out / f'{name}.png'), animations='disabled')

def pixel_contrast(page, out, name, minimum=4.5):
    tile = page.locator('.config-detail header.flex .mcp-icon').first
    tile.scroll_into_view_if_needed(); page.wait_for_timeout(300)
    page.screenshot(path=str(out / f'{name}.png'), animations='disabled')
    rect = tile.bounding_box(); assert rect
    image = Image.open(out / f'{name}.png').convert('RGB')
    crop = image.crop((int(rect['x']), int(rect['y']), int(rect['x'] + rect['width']), int(rect['y'] + rect['height'])))
    pixels = crop.get_flattened_data() if hasattr(crop, 'get_flattened_data') else crop.getdata()
    def luminance(rgb):
        parts = [c / 255 for c in rgb]
        linear = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in parts]
        return sum(c * weight for c, weight in zip(linear, [.2126, .7152, .0722]))
    levels = [luminance(pixel) for pixel in pixels]
    ratio = (max(levels) + .05) / (min(levels) + .05)
    assert ratio >= minimum, (name, ratio, minimum)
    return round(ratio, 2)

def assert_controls_fit(page):
    failures = page.evaluate("""() => {
      const root = document.querySelector('[data-testid=mcp-settings]');
      const boundary = document.querySelector('.config-detail').getBoundingClientRect();
      const issues = [];
      for (const el of root.querySelectorAll('button,input,select,textarea')) {
        const r = el.getBoundingClientRect();
        if (!el.getClientRects().length || (!r.width && !r.height)) continue;
        if ((r.width < 16 && !(el.tagName === 'INPUT' && el.type === 'checkbox')) || r.left < boundary.left - 1 || r.right > boundary.right + 1) issues.push(`${el.tagName}:${el.getAttribute('aria-label') || el.textContent}:${r.left},${r.right}`);
        if (el.tagName !== 'BUTTON') continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent.trim() || text.parentElement.closest('.truncate')) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          for (const line of range.getClientRects()) if (line.width && (line.left < r.left - 1 || line.right > r.right + 1)) issues.push(`text:${text.textContent}`);
        }
      }
      return issues;
    }""")
    assert not failures, failures

def run(browser, base, out):
    records = []
    for width, theme in [(1440, 'light'), (360, 'dark')]:
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(15000)
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); req = {'index': 0, 'external': []}; install(page, base, data, req, theme=theme)
        try: open_panel(page, base)
        except Exception:
            capture(page, out, 'entry-failure')
            print('진입 실패 화면:', page.locator('body').inner_text()[:2000])
            raise
        expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        page.wait_for_timeout(300)  # 공용 DialogPopup의 열기 전환이 끝난 좌표를 잰다.
        assert req['index'] == 0 and not req['external'], req
        assert set(req.get('icons', [])) <= {'/brand-icons/icons/github.svg'}, req
        alignment = page.evaluate("""() => Object.fromEntries([['heading', '.config-detail-heading'], ['status', '.mcp-tabs + div'], ['tabs', '.mcp-tabs'], ['frame', '[data-testid=mcp-settings]']].map(([name, selector]) => {const el = document.querySelector(selector); const r = el?.getBoundingClientRect(); return [name, r ? {left: r.left, right: r.right} : null]}))""")
        alignment['status'] = page.evaluate("""() => { const r = document.querySelector('.mcp-tabs').previousElementSibling.getBoundingClientRect(); return {left:r.left,right:r.right} }""")
        assert all(alignment[key] for key in ['heading', 'status', 'tabs', 'frame'])
        assert max(alignment[key]['left'] for key in alignment) - min(alignment[key]['left'] for key in alignment) <= 1, alignment
        assert max(alignment[key]['right'] for key in ['status', 'tabs', 'frame']) - min(alignment[key]['right'] for key in ['status', 'tabs', 'frame']) <= 1, alignment
        tops = page.evaluate("""() => { const frame = document.querySelector('[data-testid=mcp-settings]'); return [...frame.children].map(el => el.getBoundingClientRect().top); }""")
        if width > 360: assert abs(tops[0] - tops[1]) <= 1, tops
        capture(page, out, f'servers-{width}-{theme}')
        page.locator('.config-detail header.flex .mcp-icon').first.scroll_into_view_if_needed(); page.wait_for_function("document.querySelector('.config-detail header.flex .mcp-icon-mask') !== null"); github_contrast = pixel_contrast(page, out, f'contrast-github-{width}-{theme}')
        page.get_by_role('button', name='아이콘 고르기').click(); page.get_by_label('브랜드 이름 검색').wait_for(); assert req['index'] == 1
        expect(page.get_by_label('브랜드 이름 검색')).to_be_focused()
        page.keyboard.press('Enter'); expect(page.get_by_label('브랜드 이름 검색')).to_be_visible()
        page.get_by_label('브랜드 이름 검색').fill('linear'); page.get_by_role('button', name='Linear', exact=True).click()
        page.locator('.config-detail header.flex .mcp-icon').first.scroll_into_view_if_needed(); page.wait_for_timeout(500); linear_contrast = pixel_contrast(page, out, f'contrast-linear-{width}-{theme}', 3 if theme == 'light' else 4.5)
        capture(page, out, f'brand-{width}-{theme}')
        page.get_by_role('button', name='기호 고르기').click(); capture(page, out, f'symbol-{width}-{theme}')
        page.get_by_role('button', name='이미지 올리기').click(); page.locator('input[type=file]').set_input_files({'name': 'fake-icon.png', 'mimeType': 'image/png', 'buffer': FAKE_IMAGE}); capture(page, out, f'upload-{width}-{theme}')
        page.get_by_role('button', name='머리글자로 두기').click(); capture(page, out, f'initial-{width}-{theme}')
        page.keyboard.press('Escape'); expect(page.get_by_role('button', name='아이콘 고르기', exact=True)).to_be_focused(); expect(page.get_by_role('dialog')).to_have_count(1)
        page.get_by_text('노드별 덮어쓰기', exact=True).click(); capture(page, out, f'override-{width}-{theme}')
        history_button = page.get_by_role('button', name='되돌리기', exact=True)
        history_button.click(); expect(page.get_by_role('dialog').last.get_by_text('판 10', exact=False)).to_be_visible(); capture(page, out, f'history-{width}-{theme}')
        expect(page.get_by_role('dialog').last.get_by_role('button', name='닫기', exact=True).first).to_be_focused()
        page.get_by_role('dialog').last.get_by_role('button', name='닫기', exact=True).first.focus(); page.keyboard.press('Enter'); expect(history_button).to_be_focused(); history_button.click()
        history_dialog = page.get_by_role('dialog', name='되돌리기')
        expect(history_dialog).to_be_visible(); expect(history_dialog.get_by_role('button', name='닫기', exact=True).first).to_be_focused()
        page.keyboard.press('Tab'); assert history_dialog.evaluate('(el) => el.contains(document.activeElement)'), page.evaluate('document.activeElement.outerHTML')
        page.keyboard.press('Escape'); expect(page.get_by_role('dialog').last.get_by_text('판 10', exact=False)).to_have_count(0); expect(history_button).to_be_focused()
        delete_button = page.get_by_role('button', name='삭제', exact=True).first
        delete_button.click(); expect(page.get_by_role('dialog', name='삭제').get_by_role('button', name='취소')).to_be_focused(); capture(page, out, f'delete-{width}-{theme}')
        page.get_by_role('dialog').last.get_by_role('button', name='취소').focus(); page.keyboard.press('Enter'); expect(delete_button).to_be_focused(); delete_button.click(); page.keyboard.press('Escape'); expect(delete_button).to_be_focused(); delete_button.click()
        page.get_by_role('dialog').last.get_by_role('button', name='삭제', exact=True).click(); expect(page.get_by_role('alert')).to_contain_text('사용 중인 프로필'); capture(page, out, f'conflict-{width}-{theme}')
        page.get_by_role('tab', name='프로필', exact=True).click(); capture(page, out, f'profiles-{width}-{theme}')
        page.get_by_role('tab', name='비밀값', exact=True).click(); capture(page, out, f'secrets-{width}-{theme}')
        page.get_by_role('button', name='값 교체').click(); field = page.get_by_label('새 값'); assert field.input_value() == '' and field.get_attribute('autocomplete') == 'off'; expect(field).to_be_focused(); page.keyboard.press('Enter'); expect(field).to_be_visible(); capture(page, out, f'replace-{width}-{theme}'); page.keyboard.press('Escape'); expect(page.get_by_role('button', name='값 교체')).to_be_focused(); expect(page.get_by_role('dialog')).to_have_count(1)
        page.get_by_role('tab', name='서버', exact=True).click(); page.get_by_role('button', name='+ 새 서버').click(); page.get_by_label('서버 ID').fill('fake-new-server'); page.get_by_label('URL', exact=True).fill('https://new.example.invalid/mcp')
        page.get_by_label('인증 방식').select_option('bearer'); page.get_by_role('button', name='줄 더하기').click(); page.locator('.config-dialog').get_by_label('참조 이름').fill('fake-bearer'); page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-value'); page.keyboard.press('Enter'); page.keyboard.press('Escape'); expect(page.get_by_role('button', name='값 교체')).to_be_focused(); page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-value')
        page.set_viewport_size({'width': 360 if width > 360 else 1440, 'height': 800}); assert page.get_by_label('서버 ID').input_value() == 'fake-new-server'; page.set_viewport_size({'width': width, 'height': 900 if width > 360 else 800})
        page.get_by_role('button', name='저장', exact=True).click(); expect(page.get_by_text('어느 프로필에 바로 추가할까요?')).to_be_visible(); assert page.evaluate("document.activeElement?.textContent.includes('어느 프로필에 바로 추가할까요?')")
        page.get_by_label('전송 이름').fill('저장 뒤 작성 중'); expect(page.get_by_text('eiaserinnys 판 15', exact=False)).to_be_visible(timeout=12000); assert page.get_by_label('전송 이름').input_value() == '저장 뒤 작성 중'
        page.get_by_text('어느 프로필에 바로 추가할까요?').scroll_into_view_if_needed(); capture(page, out, f'add-profile-{width}-{theme}')
        checkbox = page.get_by_text('seosoyoung', exact=True).last.locator('..').locator('input[type=checkbox]'); checkbox.focus(); page.keyboard.press('Enter'); assert not checkbox.is_checked(); page.keyboard.press('Space'); assert checkbox.is_checked(); page.get_by_role('button', name='선택한 프로필에 추가').click(); expect(page.get_by_text('어느 프로필에 바로 추가할까요?')).to_have_count(0); expect(page.get_by_role('button', name='아이콘 고르기', exact=True)).to_be_focused(); assert 'fake-new-server' in data['profiles'][0]['mcp_servers']
        overflow = page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'); assert not overflow and not req['external']; assert_controls_fit(page)
        records.append(f"| {width}px / {theme} | 왼쪽 정렬: {alignment}; GitHub 대비 {github_contrast}:1, Linear 대비 {linear_contrast}:1(캡처 화소); 입력 초점과 폭 변경 뒤 입력 보존 |")
        context.close()
    for state in ['error', 'loading', 'empty']:
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(15000); data = fixture(); req = {'index': 0, 'external': []}; install(page, base, data, req, state)
        open_panel(page, base)
        if state == 'error':
            expect(page.get_by_role('alert')).to_contain_text('불러오지 못했습니다'); capture(page, out, 'error'); page.get_by_role('button', name='다시 시도').click(); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        elif state == 'loading':
            expect(page.get_by_text('MCP 설정을 불러오는 중…')).to_be_attached(); capture(page, out, 'loading'); req['held'].fulfill(json=data)
        else:
            expect(page.get_by_text('항목이 없습니다.')).to_be_visible(); capture(page, out, 'empty')
        context.close()
    context = browser.new_context(viewport={'width': 360, 'height': 800}, color_scheme='dark', reduced_motion='reduce', service_workers='block')
    page = context.new_page(); page.set_default_timeout(15000); data = fixture()
    for i in range(14):
        item = copy.deepcopy(data['servers'][0]); item.update(id=f'fake-extra-{i}', name=f'fake-extra-{i}', icon=None, node_overrides={}); data['servers'].append(item)
    data['profiles'][0]['mcp_servers'] = [server['id'] for server in data['servers']]
    install(page, base, data, {'index': 0, 'external': []}, theme='dark'); open_panel(page, base); page.get_by_role('tab', name='프로필', exact=True).click()
    expect(page.get_by_text('seosoyoung', exact=True).first).to_be_visible(); capture(page, out, 'profile-40-360-dark')
    assert not page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'); assert_controls_fit(page); context.close()
    out.joinpath('operations.md').write_text('# 조작 결과\n\n| 항목 | 결과 | 근거 |\n|---|---|---|\n| 14 초점 | 통과 | 브랜드·새 값 입력에 초점, Esc 뒤 연 단추로 복귀 |\n| 15 Tab·Esc | 통과 | 되돌리기 창 안에 초점 유지, Esc로 닫힘 |\n| 16 최소 폭 | 통과 | 360px 문서 가로 넘침 없음 |\n| 17 오류 | 통과 | 실패 안내·재시도, 삭제 409 안내 |\n| 18 창 크기 | 통과 | 1440 ↔ 360px 변경 뒤 입력 보존 |\n| 노드 적용 판 | 통과 | 저장 뒤 ACK 재조회와 작성 중 입력 보존 |\n\n| 폭과 테마 | 실측 |\n|---|---|\n' + '\n'.join(records) + '\n\n| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |\n|---|---|---|---|---|---|\n| 되돌리기 목록 | 되돌리기 단추 | 창 안 | 닫기 단추 실행 | 창 닫힘 | 연 단추 |\n| 삭제 확인 | 삭제 단추 | 창 안 | 취소 단추 실행 | 창 닫힘 | 삭제 단추 |\n| 아이콘 고르기 | 아이콘 고르기 | 브랜드 검색 | 입력 유지 | 편집 접힘 | 연 단추 |\n| 비밀값 교체 | 값 교체 | 빈 새 값 입력 | 입력 유지 | 편집 취소 | 연 단추 |\n| 서버 값 교체 | 값 교체 | 빈 새 값 입력 | 입력 유지 | 편집 취소 | 연 단추 |\n| 프로필 바로 추가 | 새 서버 저장 | 안내 묶음 | 체크 상태 유지, Space로 선택 | 해당 없음(화면 안 편집) | 아이콘 고르기 |\n\n실행: `python3 -P scripts/visual-check/mcp_settings_panel.py --output <shots> --baseline-dist <기준 dist>`\n', encoding='utf8')

def compare_existing(browser, baseline, current, out):
    measurements = {}
    for name, base in [('before', baseline), ('after', current)]:
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, color_scheme='light', reduced_motion='reduce', service_workers='block')
        page = context.new_page(); install(page, base, fixture(), {'index': 0, 'external': []})
        page.goto(base + '/dialogues?sample=settings', wait_until='domcontentloaded')
        page.get_by_role('navigation', name='설정 카테고리').get_by_role('button', name='반복 작업').click()
        head = page.locator('.config-detail header.flex').first
        expect(head).to_be_visible(); page.screenshot(path=str(out / f'existing-{name}.png'), animations='disabled')
        measurements[name] = head.evaluate("el => {const r=el.getBoundingClientRect(), s=getComputedStyle(el); return {x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,color:s.color}}")
        context.close()
    assert measurements['before'] == measurements['after'], measurements
    with out.joinpath('operations.md').open('a', encoding='utf8') as result:
        result.write(f"\n기존 반복 작업 머리 전후 좌표·글꼴·색 일치: {measurements['after']}\n")

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', default=os.environ.get('MCP_SHOTS_DIR', str(ROOT / '.local' / 'mcp-settings-shots'))); parser.add_argument('--baseline-dist', default=os.environ.get('MCP_BASELINE_DIST')); args = parser.parse_args()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    server, base = serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(); run(browser, base, out)
            if args.baseline_dist:
                baseline_server, baseline = serve(Path(args.baseline_dist))
                try: compare_existing(browser, baseline, base, out)
                finally: baseline_server.shutdown()
            browser.close()
    finally: server.shutdown()
    print(f'MCP 화면 캡처와 조작 결과: {out}')

if __name__ == '__main__': main()

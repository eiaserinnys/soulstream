#!/usr/bin/env python3
"""빌드된 대시보드와 가짜 관리 API로 MCP 설정을 조작하고 캡처한다."""
# 500줄 예외: 위임된 기존 조작과 검수 보완 시나리오의 단일 실행 진입점이다.
from __future__ import annotations
import argparse
import base64
import copy
from concurrent.futures import ThreadPoolExecutor
import functools
import http.server
import io
import json
import os
import re
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, unquote
from PIL import Image
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeoutError

expect.set_options(timeout=15000)

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / 'unified-dashboard' / 'dist'
NODES = ['eiaserinnys', 'eias-linegames', 'eias-linegames-wsl']
NAMES = ['arbor', 'atom', 'atom-nl', 'chrome-devtools', 'clipper', 'cloistermont', 'corksheet', 'dorothy-memory', 'eb-index', 'exa', 'haniel', 'example-mcp', 'mbti-mcp', 'ms-todo', 'nnow', 'openaiDeveloperDocs', 'opgg', 'outline', 'seosoyoung-mcp', 'serendipity', 'shay', 'slack', 'slides', 'soulstream', 'soulstream-cogito', 'trello']
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
    # Playwright가 서비스 워커를 차단할 때 register()가 빈 결과를 돌려주므로,
    # 화면 검수에서는 워커 미지원 브라우저로 두고 SW 산출물은 별도 시험에서 검사한다.
    page.add_init_script("Object.defineProperty(navigator, 'serviceWorker', {value: undefined, configurable: true});")
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
      for (const el of root.querySelectorAll('button,input,select,textarea,[role=checkbox]')) {
        if (el.closest('[aria-hidden="true"]')) continue;
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
        expect(page.get_by_test_id('mcp-no-nodes')).to_have_text('적용 노드 없음', timeout=3000)
        expect(page.get_by_test_id('mcp-no-nodes')).to_have_attribute('data-slot', 'badge')
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
        page.locator('summary', has_text='노드별 덮어쓰기').click(); capture(page, out, f'override-{width}-{theme}')
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
        page.keyboard.press('Escape')
        page.get_by_role('tab', name='프로필', exact=True).click(); capture(page, out, f'profiles-{width}-{theme}')
        page.get_by_role('tab', name='비밀값', exact=True).click(); capture(page, out, f'secrets-{width}-{theme}')
        page.get_by_role('button', name='값 교체').click(); field = page.get_by_label('새 값'); assert field.input_value() == '' and field.get_attribute('autocomplete') == 'off'; expect(field).to_be_focused(); page.keyboard.press('Enter'); expect(field).to_be_visible(); capture(page, out, f'replace-{width}-{theme}'); page.keyboard.press('Escape'); expect(page.get_by_role('button', name='값 교체')).to_be_focused(); expect(page.get_by_role('dialog')).to_have_count(1)
        page.get_by_role('tab', name='서버', exact=True).click(); page.get_by_role('button', name='+ 새 서버').click(); page.get_by_label('서버 ID').fill('fake-new-server'); page.get_by_label('URL', exact=True).fill('https://new.example.invalid/mcp')
        page.get_by_label('인증 방식').select_option('bearer'); page.get_by_role('button', name='줄 더하기').click(); page.locator('.config-dialog').get_by_label('참조 이름').fill('fake-bearer'); page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-value'); page.keyboard.press('Enter'); page.keyboard.press('Escape'); expect(page.get_by_role('button', name='값 교체')).to_be_focused(); page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-value')
        page.set_viewport_size({'width': 360 if width > 360 else 1440, 'height': 800}); assert page.get_by_label('서버 ID').input_value() == 'fake-new-server'; page.set_viewport_size({'width': width, 'height': 900 if width > 360 else 800})
        page.get_by_role('button', name='저장', exact=True).click(); expect(page.get_by_text('어느 프로필에 바로 추가할까요?')).to_be_visible(); assert page.evaluate("document.activeElement?.textContent.includes('어느 프로필에 바로 추가할까요?')")
        page.get_by_label('전송 이름').fill('저장 뒤 작성 중'); expect(page.get_by_text('eiaserinnys 판 15', exact=False)).to_be_visible(timeout=12000); assert page.get_by_label('전송 이름').input_value() == '저장 뒤 작성 중'
        page.get_by_text('어느 프로필에 바로 추가할까요?').scroll_into_view_if_needed(); capture(page, out, f'add-profile-{width}-{theme}')
        checkbox = page.get_by_text('seosoyoung', exact=True).last.locator('..').get_by_role('checkbox'); checkbox.focus(); expect(checkbox).not_to_be_checked(); page.keyboard.press('Enter'); expect(checkbox).to_be_checked(); page.keyboard.press('Space'); expect(checkbox).not_to_be_checked(); page.keyboard.press('Space'); expect(checkbox).to_be_checked(); page.get_by_role('button', name='선택한 프로필에 추가').click(); expect(page.get_by_text('어느 프로필에 바로 추가할까요?')).to_have_count(0); expect(page.get_by_role('button', name='아이콘 고르기', exact=True)).to_be_focused(); assert 'fake-new-server' in data['profiles'][0]['mcp_servers']
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
    out.joinpath('operations.md').write_text('# 조작 결과\n\n| 항목 | 결과 | 근거 |\n|---|---|---|\n| 14 초점 | 통과 | 브랜드·새 값 입력에 초점, Esc 뒤 연 단추로 복귀 |\n| 15 Tab·Esc | 통과 | 되돌리기 창 안에 초점 유지, Esc로 닫힘 |\n| 16 최소 폭 | 통과 | 360px 문서 가로 넘침 없음 |\n| 17 오류 | 통과 | 실패 안내·재시도, 삭제 409 안내 |\n| 18 창 크기 | 통과 | 1440 ↔ 360px 변경 뒤 입력 보존 |\n| 노드 적용 판 | 통과 | 저장 뒤 ACK 재조회와 작성 중 입력 보존 |\n\n| 폭과 테마 | 실측 |\n|---|---|\n' + '\n'.join(records) + '\n\n| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |\n|---|---|---|---|---|---|\n| 되돌리기 목록 | 되돌리기 단추 | 닫기 단추 | 닫기 단추 실행 | 창 닫힘 | 연 단추 |\n| 삭제 확인 | 삭제 단추 | 취소 단추 | 취소 단추 실행 | 창 닫힘 | 삭제 단추 |\n| 아이콘 고르기 | 아이콘 고르기 | 브랜드 검색 또는 고른 꼴 | 검색 입력 유지, 꼴 선택 | 편집 접힘 | 연 단추 |\n| 비밀값 교체 | 값 교체 | 빈 새 값 입력 | 입력 유지 | 편집 취소 | 연 단추 |\n| 서버 값 교체 | 값 교체 | 빈 새 값 입력 | 입력 유지 | 편집 취소 | 연 단추 |\n| 프로필 바로 추가 | 새 서버 저장 | 안내 묶음 | 체크박스에서 선택 전환, Space도 전환 | 해당 없음(화면 안 편집) | 아이콘 고르기 |\n\n실행: `python3 -P scripts/visual-check/mcp_settings_panel.py --output <shots> --baseline-dist <기준 dist>`\n', encoding='utf8')

def run_r1(browser, base, out):
    """세라피엘의 긴 데이터·선택·스크롤 시나리오를 실제 설정 창에서 잰다."""
    results = []
    def check(label, callback):
        try:
            ok, detail = callback()
            results.append({'check': label, 'ok': bool(ok), 'detail': detail})
        except Exception as error:
            results.append({'check': label, 'ok': False, 'detail': str(error)[:500]})
    def in_view(locator):
        return locator.evaluate("""el => { const view = el.closest('.config-detail').getBoundingClientRect();
          const r = el.getBoundingClientRect(); return {top:r.top, bottom:r.bottom, viewTop:view.top, viewBottom:view.bottom,
          visible:r.top >= view.top - 1 && r.bottom <= view.bottom + 1}; }""")
    def visible_after_scroll(page, locator):
        try:
            page.wait_for_function("""el => { const view = el.closest('.config-detail').getBoundingClientRect();
              const r = el.getBoundingClientRect(); return r.top >= view.top - 1 && r.bottom <= view.bottom + 1; }""",
              arg=locator.element_handle(), timeout=3000)
        except PlaywrightTimeoutError:
            pass
        rect = in_view(locator)
        return rect['visible'], rect
    def input_fits(page):
        values = page.locator('.config-dialog input[aria-label="참조 이름"]').evaluate_all("""items => items.filter(el => el.clientWidth > 0 && el.getClientRects().length).map(el => {
          const css = getComputedStyle(el), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          ctx.font = css.font; const needed = ctx.measureText(el.value).width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
          const unit = el.closest('[data-testid="mcp-value-unit"]');
          return {client:el.clientWidth, scroll:el.scrollWidth, needed, full:el.title === el.value && !!unit?.querySelector('[data-testid="mcp-reference-full-toggle"]')};
        })""")
        return bool(values) and all((v['scroll'] <= v['client'] + 1 and v['needed'] <= v['client'] + 1) or v['full'] for v in values), values
    def row_alignment(page):
        rows = page.locator('[data-testid="mcp-settings"] aside button').evaluate_all("""buttons => buttons.flatMap(button => {
          const title = button.querySelector('.font-medium'); if (!title) return [];
          const b = button.getBoundingClientRect(), r = title.getBoundingClientRect();
          return [{left:r.left,height:b.height,client:title.clientWidth,scroll:title.scrollWidth,text:title.textContent}];
        })""")
        return bool(rows) and max(r['left'] for r in rows)-min(r['left'] for r in rows) <= 1 and max(r['height'] for r in rows)-min(r['height'] for r in rows) <= 1, rows
    def button_style(locator):
        return locator.evaluate("""el => { const s=getComputedStyle(el); return {pressed:el.getAttribute('aria-pressed'),
          bg:s.backgroundColor, border:s.borderColor, color:s.color, shadow:s.boxShadow}; }""")
    def selected_diff(a, b):
        x, y = button_style(a), button_style(b)
        return x['pressed'] == 'true' and y['pressed'] == 'false' and any(x[k] != y[k] for k in ['bg','border','color','shadow']), [x, y]
    for width, theme in [(1440, 'light'), (360, 'dark')]:
        tag = f'{width}-{theme}'
        browser_errors = []
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(8000); page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); requests = {'index': 0, 'external': []}
        long_ref = 'srv-arbor-ovr-eias-linegames-hdr-authorization'
        data['servers'][0]['node_overrides'][NODES[1]]['config']['headers']['Authorization'] = '{{secret:' + long_ref + '}}'
        data['secrets'].append({'name': long_ref, 'updated_at': None, 'servers': ['arbor'], 'profiles': []})
        long_server = copy.deepcopy(data['servers'][1]); long_server.update(id='fake-server-with-a-very-long-name-and-node-suffix', name='fake-server-with-a-very-long-name-and-node-suffix', icon=None)
        data['servers'].append(long_server)
        long_profile = copy.deepcopy(data['profiles'][0]); long_profile.update(id='fake-profile-with-a-very-long-name-and-node-suffix', name='fake-profile-with-a-very-long-name-and-node-suffix', mcp_servers=NAMES[:9])
        data['profiles'].append(long_profile)
        install(page, base, data, requests, theme=theme)
        open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible(); page.wait_for_timeout(300)
        usage = page.locator('summary', has_text='사용 프로필')
        usage.click()
        profile_users = usage.locator('..').locator('p')
        check(f'13 사용 프로필 선택 {tag}', lambda: ((value := profile_users.evaluate('el => getComputedStyle(el).userSelect')) == 'text', value))
        usage.scroll_into_view_if_needed(); capture(page, out, f'r1-profile-users-{tag}')
        page.get_by_role('button', name='+ 새 서버').click()
        check(f'11 새 서버 사용 프로필 생략 {tag}', lambda: (page.locator('summary', has_text='사용 프로필').count() == 0, '저장 전 서버'))
        page.get_by_test_id('mcp-settings').locator('aside button', has_text='arbor').first.click()
        expect(page.locator('input[aria-label="참조 이름"][title="srv-arbor-hdr-example"]').first).to_be_visible()
        check(f'1 기본 참조 {tag}', lambda: input_fits(page))
        page.locator('.config-dialog input[aria-label="참조 이름"]').first.scroll_into_view_if_needed()
        capture(page, out, f'r1-reference-{tag}')
        page.locator('summary', has_text='노드별 덮어쓰기').click()
        check(f'1 덮어쓰기 참조 {tag}', lambda: input_fits(page))
        overflow_toggle = page.get_by_test_id('mcp-value-unit').filter(has=page.locator('input[aria-label="참조 이름"][title="' + long_ref + '"]')).get_by_test_id('mcp-reference-full-toggle')
        if overflow_toggle.count():
            overflow_toggle.click(); expect(page.get_by_text(long_ref, exact=True)).to_be_visible()
        page.locator('.config-dialog input[aria-label="참조 이름"]').last.scroll_into_view_if_needed(); capture(page, out, f'r1-override-{tag}')
        page.get_by_test_id('mcp-settings').locator('aside button', has_text='exa').first.click()
        expect(page.locator('input[aria-label="참조 이름"][title="srv-exa-qry-first"]').first).to_be_visible()
        check(f'1 환경 변수 참조 {tag}', lambda: input_fits(page))
        page.locator('.config-dialog input[aria-label="참조 이름"]').last.scroll_into_view_if_needed(); capture(page, out, f'r1-env-reference-{tag}')
        page.get_by_test_id('mcp-settings').locator('aside button', has_text='chrome-devtools').first.click()
        expect(page.get_by_label('전송 방식').first).to_have_value('stdio')
        check(f'8 stdio 단일 줄 종류 {tag}', lambda: (page.get_by_label('인증 방식').count() == 0 and page.get_by_role('button', name='줄 더하기').count() >= 1, '기본 정의와 덮어쓰기에서 env만 추가'))
        previous_env_count = page.get_by_label('환경 변수 이름').count()
        page.get_by_role('button', name='줄 더하기').first.click()
        expect(page.get_by_label('환경 변수 이름')).to_have_count(previous_env_count + 1)
        page.get_by_role('button', name='줄 더하기').first.scroll_into_view_if_needed(); capture(page, out, f'r1-stdio-{tag}')
        page.get_by_role('tab', name='프로필', exact=True).click()
        check(f'2 프로필 행 정렬 {tag}', lambda: row_alignment(page))
        check(f'6 프로필 공용 체크박스 {tag}', lambda: ((slots := page.get_by_test_id('mcp-settings').get_by_role('checkbox').evaluate_all("items => items.map(el => el.getAttribute('data-slot'))")) and all(slot == 'checkbox' for slot in slots), slots))
        page.get_by_test_id('mcp-settings').locator('aside').scroll_into_view_if_needed(); capture(page, out, f'r1-profiles-{tag}')
        def selectable_profile():
            values = page.locator('.config-detail').get_by_text('소속 노드:', exact=False).first.evaluate("el => getComputedStyle(el).userSelect")
            return values == 'text', values
        check(f'13 프로필 식별자 선택 {tag}', selectable_profile)
        check(f'13 연결된 에이전트 선택 {tag}', lambda: ((value := page.locator('.config-detail').get_by_text('연결된 에이전트:', exact=False).first.evaluate('el => getComputedStyle(el).userSelect')) == 'text', value))
        page.get_by_role('tab', name='서버', exact=True).click()
        row = page.get_by_test_id('mcp-settings').locator('aside button', has_text='exa').first
        row.scroll_into_view_if_needed(); row.click()
        head = page.locator('.config-detail header.flex').first
        check(f'4 선택한 상세 가시성 {tag}', lambda: visible_after_scroll(page, head))
        capture(page, out, f'r1-row-{tag}')
        def conflict(route):
            if route.request.method == 'PUT': return route.fulfill(status=409, json={'code':'MCP_SERVER_VERSION_CONFLICT','message':'fake'})
            return route.fallback()
        page.route('**/api/mcp/servers/**', conflict)
        page.get_by_role('button', name='저장', exact=True).scroll_into_view_if_needed()
        page.get_by_role('button', name='저장', exact=True).click()
        alert = page.get_by_role('alert').first; expect(alert).to_be_attached()
        check(f'3 저장 오류 가시성 {tag}', lambda: ((r := in_view(alert))['visible'], r))
        check(f'13 오류 선택 {tag}', lambda: ((value := alert.evaluate('el => getComputedStyle(el).userSelect')) == 'text', value))
        capture(page, out, f'r1-conflict-{tag}')
        context.close()
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(8000); page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); install(page, base, data, {'index':0, 'external':[]}, theme=theme)
        open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        page.get_by_role('button', name='아이콘 고르기', exact=True).click()
        page.get_by_label('브랜드 이름 검색').fill('git')
        expect(page.get_by_role('button', name='GitHub', exact=True)).to_be_visible()
        def picker_layout():
            names = ['브랜드 검색', '기호 고르기', '이미지 올리기', '머리글자로 두기']
            rects = page.evaluate("""async names => {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const buttons = [...document.querySelectorAll('.config-dialog button')];
              return names.map(name => {
                const button = buttons.find(el => el.textContent.trim() === name);
                if (!button) return null;
                const r = button.getBoundingClientRect();
                return {x:r.x, y:r.y, width:r.width, height:r.height};
              });
            }""", names)
            if any(rect is None for rect in rects): return False, rects
            tops = {round(r['y']) for r in rects}
            return len(tops) <= 2 and all(sum(round(r['y']) == top for r in rects) >= 2 for top in tops), rects
        check(f'5 꼴 선택 묶음 {tag}', picker_layout)
        github = page.get_by_role('button', name='GitHub', exact=True)
        other_brand = github.locator('xpath=following-sibling::button[1]')
        if not other_brand.count(): other_brand = github.locator('xpath=preceding-sibling::button[1]')
        check(f'5 브랜드 선택 표시 {tag}', lambda: selected_diff(github, other_brand))
        capture(page, out, f'r1-brand-{tag}')
        page.keyboard.press('Escape')
        page.get_by_test_id('mcp-settings').locator('aside button', has_text='atom').first.click()
        page.get_by_role('button', name='아이콘 고르기', exact=True).click()
        check(f'5 저장된 꼴 선택 {tag}', lambda: ((pressed := page.get_by_role('button', name='기호 고르기').get_attribute('aria-pressed')) == 'true', pressed))
        def selected_mode_focus():
            expect(page.get_by_role('button', name='기호 고르기')).to_be_focused()
            return True, '기호 고르기'
        check(f'5 고른 꼴 첫 초점 {tag}', selected_mode_focus)
        page.get_by_role('button', name='기호 고르기').click()
        check(f'5 기호 선택 표시 {tag}', lambda: selected_diff(page.get_by_role('button', name='plug', exact=True), page.get_by_role('button', name='cloud', exact=True)))
        page.get_by_role('button', name='plug', exact=True).scroll_into_view_if_needed(); capture(page, out, f'r1-symbol-{tag}')
        page.get_by_role('button', name='이미지 올리기').click()
        page.locator('input[type=file]').set_input_files({'name':'fake.gif', 'mimeType':'image/gif', 'buffer':b'GIF89a'})
        expect(page.get_by_role('alert')).to_contain_text('이미지를 올리지 못했습니다')
        page.get_by_role('alert').scroll_into_view_if_needed(); capture(page, out, f'r1-upload-error-{tag}')
        page.keyboard.press('Escape')
        def checkbox_style():
            boxes = page.get_by_test_id('mcp-settings').get_by_role('checkbox')
            slots = boxes.evaluate_all("items => items.map(el => el.getAttribute('data-slot'))")
            return bool(slots) and all(slot == 'checkbox' for slot in slots), slots
        check(f'6 공용 체크박스 {tag}', checkbox_style)
        box = page.get_by_test_id('mcp-settings').get_by_role('checkbox').first
        box.focus(); page.keyboard.press('Tab'); box.focus()
        box.scroll_into_view_if_needed(); capture(page, out, f'r1-checkbox-{tag}')
        summary = page.locator('summary', has_text='노드별 덮어쓰기')
        check(f'7 접힌 덮어쓰기 상태 {tag}', lambda: ('eias-linegames' in summary.inner_text(), summary.inner_text()))
        summary.focus(); page.keyboard.press('Tab'); summary.focus(); summary.scroll_into_view_if_needed(); capture(page, out, f'r1-summary-{tag}')
        page.get_by_role('button', name='삭제', exact=True).first.click()
        dialog = page.get_by_role('dialog', name='삭제')
        dialog.get_by_role('button', name='삭제', exact=True).click()
        def delete_error():
            error = dialog.get_by_role('alert')
            expect(error).to_be_visible()
            return dialog.is_visible() and error.is_visible(), {'dialog':dialog.is_visible(), 'error':error.count()}
        check(f'3 삭제 오류 대화상자 유지 {tag}', delete_error)
        capture(page, out, f'r1-delete-error-{tag}')
        page.keyboard.press('Escape')
        page.get_by_role('button', name='저장', exact=True).scroll_into_view_if_needed(); page.get_by_role('button', name='저장', exact=True).click()
        def save_success():
            status = page.get_by_role('status').filter(has_text='저장했습니다')
            expect(status).to_be_visible(); rect = in_view(status)
            return rect['visible'], rect
        check(f'3 저장 성공 가시성 {tag}', save_success)
        capture(page, out, f'r1-save-success-{tag}')
        page.get_by_role('tab', name='비밀값', exact=True).click()
        def secret_selectable():
            entries = page.locator('.config-detail').get_by_text('서버:', exact=False).first
            value = entries.evaluate('el => getComputedStyle(el).userSelect')
            return value == 'text', value
        check(f'13 비밀 사용처 선택 {tag}', secret_selectable)
        check(f'13 비밀 프로필 사용처 선택 {tag}', lambda: ((value := page.locator('.config-detail').get_by_text('프로필:', exact=False).first.evaluate('el => getComputedStyle(el).userSelect')) == 'text', value))
        check(f'11 비밀 목록 사용처 {tag}', lambda: ('서버' not in page.get_by_test_id('mcp-settings').locator('aside button').first.inner_text() and 'arbor' in page.get_by_test_id('mcp-settings').locator('aside button').first.inner_text(), page.get_by_test_id('mcp-settings').locator('aside button').first.inner_text()))
        capture(page, out, f'r1-secrets-{tag}')
        secret_state = {'fail': True}
        def secret_write(route):
            if route.request.method != 'PUT': return route.fallback()
            if secret_state['fail']: return route.fulfill(status=409, json={'code':'MCP_REVISION_CONFLICT','message':'fake'})
            data['current_revision'] += 1; return route.fulfill(json={'current_revision':data['current_revision']})
        page.route('**/api/mcp/secrets/**', secret_write)
        page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-value')
        page.get_by_role('button', name='저장', exact=True).click()
        secret_error = page.get_by_role('alert').first; expect(secret_error).to_be_visible()
        check(f'3 값 교체 오류 가시성 {tag}', lambda: ((rect := in_view(secret_error))['visible'], rect))
        capture(page, out, f'r1-secret-error-{tag}')
        secret_state['fail'] = False; page.get_by_role('button', name='저장', exact=True).click()
        secret_success = page.get_by_role('status').filter(has_text='값을 교체했습니다')
        expect(secret_success).to_be_visible()
        check(f'3 값 교체 성공과 입력 정리 {tag}', lambda: ((rect := in_view(secret_success))['visible'] and page.locator('input[type=password]').count() == 0, rect))
        capture(page, out, f'r1-secret-success-{tag}')
        page.get_by_role('button', name='삭제', exact=True).first.click()
        secret_dialog = page.get_by_role('dialog', name='삭제'); secret_dialog.get_by_role('button', name='삭제', exact=True).click()
        expect(secret_dialog.get_by_role('alert')).to_contain_text('서버 정의에서 이 비밀 참조를 제거')
        capture(page, out, f'r1-secret-delete-error-{tag}'); page.keyboard.press('Escape')
        page.get_by_role('tab', name='프로필', exact=True).click()
        page.get_by_role('button', name='삭제', exact=True).first.click()
        profile_dialog = page.get_by_role('dialog', name='삭제'); profile_dialog.get_by_role('button', name='삭제', exact=True).click()
        expect(profile_dialog.get_by_role('alert')).to_contain_text('에이전트의 프로필 연결을 해제')
        capture(page, out, f'r1-profile-delete-error-{tag}'); page.keyboard.press('Escape')
        page.get_by_role('tab', name='서버', exact=True).click()
        rollback_state = {'fail': True}
        def rollback_write(route):
            if rollback_state['fail']: return route.fulfill(status=409, json={'code':'MCP_REVISION_CONFLICT','message':'fake'})
            data['current_revision'] += 1; return route.fulfill(json={'current_revision':data['current_revision']})
        page.route('**/api/mcp/revisions/*/rollback', rollback_write)
        page.get_by_role('button', name='되돌리기', exact=True).click()
        history_dialog = page.get_by_role('dialog', name='되돌리기')
        history_dialog.get_by_role('button', name='이 판으로 되돌리기').click()
        expect(history_dialog.get_by_role('alert')).to_be_visible()
        check(f'3 되돌리기 오류 대화상자 유지 {tag}', lambda: (history_dialog.is_visible(), history_dialog.get_by_role('alert').inner_text()))
        capture(page, out, f'r1-rollback-error-{tag}')
        rollback_state['fail'] = False; history_dialog.get_by_role('button', name='이 판으로 되돌리기').click()
        rollback_success = page.get_by_role('status').filter(has_text='되돌렸습니다'); expect(rollback_success).to_be_visible()
        check(f'3 되돌리기 성공 가시성 {tag}', lambda: ((rect := in_view(rollback_success))['visible'], rect))
        capture(page, out, f'r1-rollback-success-{tag}')
        delete_state = {'first': True, 'versions': []}
        def delete_success(route):
            if route.request.method != 'DELETE': return route.fallback()
            parsed = urlsplit(route.request.url); server_id = unquote(parsed.path.rsplit('/', 1)[-1])
            delete_state['versions'].append(parse_qs(parsed.query).get('expected_version', [''])[0])
            if delete_state['first']:
                delete_state['first'] = False
                next(server for server in data['servers'] if server['id'] == server_id)['version'] += 1
                return route.fulfill(status=409, json={'code':'MCP_SERVER_VERSION_CONFLICT','message':'fake'})
            data['servers'] = [server for server in data['servers'] if server['id'] != server_id]
            data['current_revision'] += 1; return route.fulfill(json={'current_revision':data['current_revision']})
        page.route('**/api/mcp/servers/**', delete_success)
        page.get_by_role('button', name='삭제', exact=True).first.click()
        delete_dialog = page.get_by_role('dialog', name='삭제')
        delete_dialog.get_by_role('button', name='삭제', exact=True).click()
        expect(delete_dialog.get_by_role('alert')).to_be_visible()
        delete_dialog.get_by_role('button', name='다시 읽기').click()
        expect(delete_dialog.get_by_role('alert')).to_have_count(0)
        delete_dialog.get_by_role('button', name='삭제', exact=True).click()
        deleted = page.get_by_role('status').filter(has_text='삭제했습니다'); expect(deleted).to_be_visible()
        check(f'3 삭제 충돌 재조회와 성공 {tag}', lambda: ((rect := in_view(deleted))['visible'] and len(delete_state['versions']) == 2 and int(delete_state['versions'][1]) == int(delete_state['versions'][0]) + 1, {'rect':rect, 'versions':delete_state['versions']}))
        capture(page, out, f'r1-delete-success-{tag}')
        context.close()
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(8000); page.on('pageerror', lambda error: browser_errors.append(str(error))); data = fixture(); requests = {'index':0, 'external':[]}
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        install(page, base, data, requests, state='loading', theme=theme); open_panel(page, base)
        expect(page.get_by_text('MCP 설정을 불러오는 중…')).to_be_attached()
        check(f'12 로딩 표시 하나 {tag}', lambda: (page.get_by_text('불러오는 중', exact=False).count() == 1, page.get_by_text('불러오는 중', exact=False).count()))
        page.wait_for_timeout(400)
        status = page.locator('.mcp-tabs').locator('xpath=preceding-sibling::*[1]')
        page.wait_for_function("""el => { const dialog = el.closest('[role=dialog]'); return dialog &&
          !dialog.hasAttribute('data-starting-style') && dialog.getAnimations().every(a => a.playState !== 'running'); }""", arg=status.element_handle(), timeout=10000)
        capture(page, out, f'r1-loading-{tag}')
        loading_height = status.bounding_box()['height']
        requests['held'].fulfill(json=data); expect(page.get_by_test_id('mcp-settings')).to_be_visible(); page.wait_for_timeout(300)
        ready_height = status.bounding_box()['height']
        check(f'12 로딩 높이 {tag}', lambda: (abs(loading_height-ready_height) <= 1, {'loading':loading_height,'ready':ready_height}))
        context.close()
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(8000); page.on('pageerror', lambda error: browser_errors.append(str(error)))
        install(page, base, fixture(), {'index':0, 'external':[]}, theme=theme)
        page.goto(base + '/dialogues?sample=settings', wait_until='domcontentloaded')
        expect(page.get_by_role('navigation', name='설정 카테고리')).to_be_visible()
        for label, test_id in [('반복 작업', 'recurring-jobs-tab'), ('영구 에이전트 세션', 'persistent-sessions-tab')]:
            nav = page.get_by_role('navigation', name='설정 카테고리')
            if not nav.is_visible(): page.get_by_role('button', name='모든 설정').click()
            nav.get_by_role('button', name=label, exact=True).click()
            frame = page.get_by_test_id(test_id); row = frame.locator('aside [data-settings-list-row]').last
            row.scroll_into_view_if_needed(); row.click()
            header = frame.locator('header').first
            check(f'4 {label} 상세 가시성 {tag}', lambda: visible_after_scroll(page, header))
            capture(page, out, f'r1-shared-{test_id}-{tag}')
        context.close()
        check(f'브라우저 실행 오류 {tag}', lambda: (not browser_errors, browser_errors))
    out.joinpath('r1-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
    for result in results: print(f"{'PASS' if result['ok'] else 'FAIL'} {result['check']}: {result['detail']}", flush=True)
    failed = [result['check'] for result in results if not result['ok']]
    if failed: raise AssertionError(f'1차 검수 항목 미충족: {failed}')
    lines = ['## 1차 화면 검수 보완 조작', '', '| 항목과 화면 | 결과 |', '|---|---|']
    lines.extend(f"| {result['check']} | 통과 |" for result in results)
    lines.extend(['', '실측 좌표·상태와 선택 스타일: `r1-checks.json`.', '서버·참조·목록·충돌·각 성공/실패·공용 탭·로딩 캡처는 같은 폴더의 `r1-*.png`.', '긴 참조 이름은 입력의 실제 폭과 scrollWidth를 재고, 넘치면 전체 이름 보기로 확인했다.', ''])
    out.joinpath('r1-operations.md').write_text('\n'.join(lines), encoding='utf8')

def run_r2(browser, base, out):
    """2차 검수의 참조 입력·충돌·삭제·저장 뒤 편집을 실제 설정 창에서 조작한다."""
    results = []
    def check(label, ok, detail):
        results.append({'check': label, 'ok': bool(ok), 'detail': detail})
        out.joinpath('r2-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
        print(f"{'PASS' if ok else 'FAIL'} {label}: {detail}", flush=True)
    for width, theme in [(1440, 'dark'), (360, 'light')]:
        tag = f'{width}-{theme}'
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(10000)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); requests = {'index': 0, 'external': []}
        long_ref = 'fake-ovr-eias-linegames-hdr-authorization'
        data['servers'][0]['config']['headers']['Authorization'] = '{{secret:' + long_ref + '}}'
        data['servers'][0]['node_overrides'][NODES[1]]['config']['headers']['Authorization'] = '{{secret:' + long_ref + '}}'
        data['secrets'].append({'name': long_ref, 'updated_at': None, 'servers': ['arbor'], 'profiles': []})
        install(page, base, data, requests, theme=theme)
        state = {'server_conflict': True, 'secret_conflict': True, 'delete': set()}
        def writes(route):
            request = route.request; parsed = urlsplit(request.url); path = parsed.path
            if request.method == 'PUT' and path == '/api/mcp/servers/atom' and state['server_conflict']:
                state['server_conflict'] = False
                return route.fulfill(status=409, json={'code':'MCP_SERVER_VERSION_CONFLICT', 'message':'fake'})
            if request.method == 'PUT' and path.startswith('/api/mcp/secrets/'):
                if state['secret_conflict']:
                    state['secret_conflict'] = False
                    return route.fulfill(status=409, json={'code':'MCP_REVISION_CONFLICT', 'message':'fake'})
                data['current_revision'] += 1
                return route.fulfill(json={'current_revision':data['current_revision']})
            if request.method == 'POST' and '/rollback' in path:
                return route.fulfill(status=409, json={'code':'MCP_REVISION_CONFLICT', 'message':'fake'})
            if request.method == 'DELETE':
                kind = path.split('/')[3]; item_id = unquote(path.rsplit('/', 1)[-1])
                if kind not in state['delete']:
                    state['delete'].add(kind)
                    if kind != 'secrets': next(item for item in data[kind] if item['id'] == item_id)['version'] += 1
                    data['current_revision'] += 1
                    return route.fulfill(status=409, json={'code':'MCP_REVISION_CONFLICT' if kind == 'secrets' else 'MCP_' + kind[:-1].upper() + '_VERSION_CONFLICT', 'message':'fake'})
                data[kind] = [item for item in data[kind] if item['name' if kind == 'secrets' else 'id'] != item_id]
                data['current_revision'] += 1
                return route.fulfill(json={'current_revision':data['current_revision']})
            return route.fallback()
        page.route('**/api/mcp/**', writes)
        open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        summary = page.locator('summary', has_text='노드별 덮어쓰기')
        if not summary.locator('..').evaluate('el => el.open'): summary.click()
        refs = page.locator('input[aria-label="참조 이름"][title="' + long_ref + '"]')
        expect(refs).to_have_count(2)
        for name, slug, ref in [('기본', 'default', refs.first.element_handle()), ('덮어쓰기', 'override', refs.last.element_handle())]:
            ref.scroll_into_view_if_needed(); ref.evaluate('el => el.blur()')
            info = ref.evaluate("el => ({value:el.value, client:el.clientWidth, scroll:el.scrollWidth, overflow:getComputedStyle(el).textOverflow})")
            check(f'A {name} 말줄임 {tag}', info['scroll'] <= info['client'] + 1 or info['overflow'] == 'ellipsis', info)
            if width == 1440: check(f'A {name} 넓은 화면 표시 {tag}', info['scroll'] <= info['client'] + 1, info)
            else: check(f'A {name} 좁은 화면 넘침 {tag}', info['scroll'] > info['client'] + 1, info)
            capture(page, out, f'r2-reference-{slug}-{tag}')
            ref.focus(); ref.press('End'); ref.type('-fake'); edited = ref.input_value()
            check(f'A {name} 초점 편집 {tag}', edited == long_ref + '-fake', edited)
            ref.fill(long_ref); ref.evaluate('el => el.blur()')
        def row(text):
            return page.get_by_test_id('mcp-settings').locator('aside button', has_text=text).first
        def status(text):
            return page.get_by_role('status').filter(has_text=text)
        def saved():
            ok = status('저장했습니다'); expect(ok).to_be_visible(); return ok
        page.get_by_role('tab', name='서버', exact=True).click(); row('atom').click()
        expect(page.get_by_label('서버 ID')).to_have_value('atom')
        page.get_by_role('button', name='저장', exact=True).click()
        alert = page.get_by_role('alert').first; expect(alert).to_be_visible()
        text = alert.inner_text(); check(f'B 서버 저장 충돌 유지 {tag}', '저장' in text, text)
        capture(page, out, f'r2-save-conflict-server-{tag}')
        alert.get_by_role('button', name='다시 읽기').click(); expect(alert).to_have_count(0)
        page.get_by_role('button', name='저장', exact=True).click(); ok = saved()
        page.get_by_label('전송 이름').fill('fake-atom-edited')
        check(f'D 서버 이름 편집 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('button', name='저장', exact=True).evaluate("el => el.scrollIntoView({block:'center', behavior:'instant'})")
        capture(page, out, f'r2-server-edited-{tag}')
        page.get_by_role('button', name='저장', exact=True).click(); ok = saved()
        page.get_by_test_id('mcp-settings').get_by_role('checkbox').first.click()
        check(f'D 서버 적용 노드 편집 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('button', name='저장', exact=True).click(); ok = saved()
        page.get_by_role('button', name='줄 더하기').first.click()
        check(f'D 서버 값 줄 추가 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('tab', name='프로필', exact=True).click()
        page.get_by_role('button', name='저장', exact=True).click(); ok = saved()
        page.get_by_label('이름', exact=True).fill('가짜 프로필 수정')
        check(f'D 프로필 이름 편집 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('button', name='저장', exact=True).evaluate("el => el.scrollIntoView({block:'center', behavior:'instant'})")
        capture(page, out, f'r2-profile-edited-{tag}')
        page.get_by_role('button', name='저장', exact=True).click(); ok = saved()
        page.get_by_test_id('mcp-settings').get_by_role('checkbox').first.click()
        check(f'D 프로필 서버 선택 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('tab', name='비밀값', exact=True).click()
        page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-r2')
        page.get_by_role('button', name='저장', exact=True).click(); alert = page.get_by_role('alert').first; expect(alert).to_be_visible()
        text = alert.inner_text(); check(f'B 값 교체 저장 충돌 유지 {tag}', '저장' in text, text)
        capture(page, out, f'r2-save-conflict-secret-{tag}')
        alert.get_by_role('button', name='다시 읽기').click(); expect(alert).to_have_count(0)
        page.get_by_role('button', name='저장', exact=True).click()
        ok = status('값을 교체했습니다'); expect(ok).to_be_visible()
        page.get_by_role('button', name='값 교체').click(); page.get_by_label('새 값').fill('obviously-fake-r2-next')
        check(f'D 비밀값 재편집 {tag}', ok.count() == 0, ok.count())
        page.get_by_role('button', name='저장', exact=True).evaluate("el => el.scrollIntoView({block:'center', behavior:'instant'})")
        capture(page, out, f'r2-secret-edited-{tag}')
        page.get_by_role('button', name='취소', exact=True).click()
        for tab, kind, item in [('서버', 'servers', 'cloistermont'), ('프로필', 'profiles', 'ariella-system1'), ('비밀값', 'secrets', 'srv-atom-hdr-example')]:
            page.get_by_role('tab', name=tab, exact=True).click(); row(item).click()
            page.get_by_role('button', name='삭제', exact=True).first.click()
            dialog = page.get_by_role('dialog', name='삭제'); dialog.get_by_role('button', name='삭제', exact=True).click()
            alert = dialog.get_by_role('alert'); expect(alert).to_be_visible(); text = alert.inner_text()
            check(f'B {tab} 삭제 충돌 {tag}', '삭제' in text and '저장' not in text, text)
            capture(page, out, f'r2-delete-conflict-{kind}-{tag}')
            dialog.get_by_role('button', name='다시 읽기').click(); expect(alert).to_have_count(0)
            dialog.get_by_role('button', name='삭제', exact=True).click()
            done = status('삭제했습니다'); expect(done).to_be_visible(); text = done.inner_text()
            check(f'C {tab} 삭제 대상 {tag}', item in text, text)
            capture(page, out, f'r2-delete-success-{kind}-{tag}')
        for tab, slug, item in [('서버', 'server', 'arbor'), ('프로필', 'profile', 'ariella-system2')]:
            page.get_by_role('tab', name=tab, exact=True).click(); row(item).click()
            page.get_by_role('button', name='되돌리기', exact=True).click()
            dialog = page.get_by_role('dialog', name='되돌리기')
            dialog.get_by_role('button', name='이 판으로 되돌리기').click()
            alert = dialog.get_by_role('alert'); expect(alert).to_be_visible(); text = alert.inner_text()
            check(f'B {tab} 되돌리기 충돌 {tag}', '되돌' in text and '저장' not in text, text)
            capture(page, out, f'r2-rollback-conflict-{slug}-{tag}'); page.keyboard.press('Escape')
        check(f'브라우저 오류 {tag}', not errors, errors)
        context.close()
    failed = [result['check'] for result in results if not result['ok']]
    if failed: raise AssertionError(f'2차 검수 항목 미충족: {failed}')
    lines = ['## 2차 화면 검수 보완 조작', '', '| 항목과 화면 | 결과 |', '|---|---|']
    lines.extend(f"| {result['check']} | 통과 |" for result in results)
    lines.extend(['', '실측과 문구: `r2-checks.json`.', '각 상태의 화면은 같은 폴더의 `r2-*.png`.', ''])
    out.joinpath('r2-operations.md').write_text('\n'.join(lines), encoding='utf8')

def run_r3(browser, base, out):
    """삭제 충돌 뒤 다른 곳에서 지운 대상의 ID가 다시 읽기 결과에 남는지 확인한다."""
    results = []
    for width, theme in [(1440, 'light'), (360, 'dark')]:
        tag = f'{width}-{theme}'
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
        page = context.new_page(); page.set_default_timeout(10000)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); install(page, base, data, {'index': 0, 'external': []}, theme=theme)
        def delete_gone(route):
            request = route.request; parts = urlsplit(request.url).path.split('/')
            if request.method != 'DELETE': return route.fallback()
            kind, item_id = parts[3], unquote(parts[4])
            key = 'name' if kind == 'secrets' else 'id'
            data[kind] = [item for item in data[kind] if item[key] != item_id]
            data['current_revision'] += 1
            code = 'MCP_REVISION_CONFLICT' if kind == 'secrets' else 'MCP_' + kind[:-1].upper() + '_VERSION_CONFLICT'
            return route.fulfill(status=409, json={'code': code, 'message': 'fake'})
        page.route('**/api/mcp/**', delete_gone)
        open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        for tab, slug, item_id in [('서버', 'server', 'corksheet'), ('프로필', 'profile', 'keke'), ('비밀값', 'secret', 'srv-atom-hdr-example')]:
            page.get_by_role('tab', name=tab, exact=True).click()
            row = page.get_by_test_id('mcp-settings').locator('aside button', has_text=item_id).first
            row.scroll_into_view_if_needed(); row.click()
            page.get_by_role('button', name='삭제', exact=True).first.click()
            dialog = page.get_by_role('dialog', name='삭제')
            dialog.get_by_role('button', name='삭제', exact=True).click()
            alert = dialog.get_by_role('alert'); expect(alert).to_be_visible()
            dialog.get_by_role('button', name='다시 읽기').click(); expect(alert).to_have_count(0)
            status = page.get_by_role('status').filter(has_text='이미 삭제되었습니다')
            messages = status.all_inner_texts()
            if messages and item_id in messages[0]: expect(dialog).to_be_hidden()
            detail = {'messages': messages, 'id': item_id}
            ok = bool(messages) and item_id in messages[0] and status.first.is_visible()
            results.append({'check': f'F {tab} 이미 삭제 대상 {tag}', 'ok': ok, 'detail': detail})
            out.joinpath('r3-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
            print(f"{'PASS' if ok else 'FAIL'} F {tab} 이미 삭제 대상 {tag}: {detail}", flush=True)
            capture(page, out, f'r3-gone-{slug}-{tag}')
            if not messages and dialog.is_visible(): page.keyboard.press('Escape')
        results.append({'check': f'브라우저 오류 {tag}', 'ok': not errors, 'detail': errors})
        context.close()
    out.joinpath('r3-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
    failed = [result['check'] for result in results if not result['ok']]
    if failed: raise AssertionError(f'3차 검수 항목 미충족: {failed}')
    lines = ['## 3차 화면 검수 보완 조작', '', '| 항목과 화면 | 결과 |', '|---|---|']
    lines.extend(f"| {result['check']} | 통과 |" for result in results)
    lines.extend(['', '이미 삭제된 대상과 확인 창 상태: `r3-checks.json`.', '해당 화면은 같은 폴더의 `r3-gone-*.png`.', ''])
    out.joinpath('r3-operations.md').write_text('\n'.join(lines), encoding='utf8')

def run_r4(browser, base, out):
    """성공 안내의 글자별 줄바꿈과 대화상자의 닫힘 애니메이션을 확인한다."""
    results = []
    def check(label, ok, detail):
        results.append({'check': label, 'ok': bool(ok), 'detail': detail})
        out.joinpath('r4-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
        print(f"{'PASS' if ok else 'FAIL'} {label}: {detail}", flush=True)

    data = fixture()
    data['profiles'].append({**data['profiles'][0], 'id': 'fake-profile-with-a-very-long-name-and-node-suffix', 'name': 'fake-profile-with-a-very-long-name-and-node-suffix'})
    data['secrets'].append({'name': 'fake-arbor-ovr-eias-linegames-hdr-authorization', 'updated_at': None, 'servers': [], 'profiles': []})
    ids = sorted({s['id'] for s in data['servers']} | {p['id'] for p in data['profiles']} | {s['name'] for s in data['secrets']})
    texts = [text for item_id in ids for text in (f'“{item_id}” 항목은 이미 삭제되었습니다.', f'“{item_id}” 항목을 삭제했습니다.')]
    context = browser.new_context(viewport={'width': 360, 'height': 800}, color_scheme='dark', reduced_motion='reduce', service_workers='block')
    page = context.new_page(); page.set_default_timeout(10000)
    page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
    install(page, base, data, {'index': 0, 'external': []}, theme='dark')
    def gone(route):
        request = route.request
        if request.method != 'DELETE': return route.fallback()
        parts = urlsplit(request.url).path.split('/'); kind, item_id = parts[3], unquote(parts[4])
        key = 'name' if kind == 'secrets' else 'id'
        data[kind] = [item for item in data[kind] if item[key] != item_id]; data['current_revision'] += 1
        return route.fulfill(status=409, json={'code': 'MCP_REVISION_CONFLICT' if kind == 'secrets' else 'MCP_SERVER_VERSION_CONFLICT', 'message': 'fake'})
    page.route('**/api/mcp/**', gone)
    open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
    page.get_by_test_id('mcp-settings').locator('aside button', has_text='corksheet').first.click()
    page.get_by_role('button', name='삭제', exact=True).first.click()
    dialog = page.get_by_role('dialog', name='삭제'); dialog.get_by_role('button', name='삭제', exact=True).click()
    dialog.get_by_role('button', name='다시 읽기').click()
    status = page.get_by_role('status').filter(has_text='이미 삭제되었습니다'); expect(status).to_be_visible()
    measure = status.evaluate("""(el, texts) => {
      const original = el.textContent, out = [], style = getComputedStyle(el);
      for (const text of texts) {
        el.textContent = text; const node = el.firstChild, tops = [];
        for (let i = 0; i < text.length; i++) {
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0]; tops.push(rect ? Math.round(rect.top) : null);
        }
        const mid = [];
        for (let i = 1; i < text.length; i++)
          if (tops[i] !== null && tops[i - 1] !== null && tops[i] > tops[i - 1] && /[가-힣]/.test(text[i - 1]) && /[가-힣.]/.test(text[i]))
            mid.push(text.slice(Math.max(0, i - 4), i) + '|' + text.slice(i, i + 4));
        out.push({text, mid, overflow: el.scrollWidth > el.clientWidth + 1});
      }
      el.textContent = original;
      return {wordBreak: style.wordBreak, overflowWrap: style.overflowWrap, values: out};
    }""", texts)
    out.joinpath('r4-wrap.json').write_text(json.dumps({'ids': ids, **measure}, ensure_ascii=False, indent=2), encoding='utf8')
    for label, marker in [('이미 삭제', '이미 삭제되었습니다'), ('삭제 성공', '항목을 삭제했습니다')]:
        values = [value for value in measure['values'] if marker in value['text']]
        bad = [value for value in values if value['mid'] or value['overflow']]
        check(f'H {label} 어절·넘침 360-dark', len(values) == len(ids) and not bad,
              {'ids': len(ids), 'bad': len(bad), 'examples': bad[:3], 'wordBreak': measure['wordBreak'], 'overflowWrap': measure['overflowWrap']})
    capture(page, out, 'r4-wrap-360-dark')
    context.close()

    for width, theme in [(1440, 'light'), (360, 'dark')]:
        tag = f'{width}-{theme}'
        context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='no-preference', service_workers='block')
        page = context.new_page(); page.set_default_timeout(10000)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
        data = fixture(); install(page, base, data, {'index': 0, 'external': []}, theme=theme)
        state = {'mode': {}}
        def writes(route):
            request = route.request
            if request.method != 'DELETE': return route.fallback()
            parts = urlsplit(request.url).path.split('/'); kind, item_id = parts[3], unquote(parts[4])
            key = 'name' if kind == 'secrets' else 'id'; mode = state['mode'].pop(item_id, None)
            if mode == 'gone' or mode is None:
                data[kind] = [item for item in data[kind] if item[key] != item_id]
            if mode == 'conflict':
                for item in data[kind]:
                    if item[key] == item_id and 'version' in item: item['version'] += 1
            data['current_revision'] += 1
            if mode:
                code = 'MCP_REVISION_CONFLICT' if kind == 'secrets' else 'MCP_' + kind[:-1].upper() + '_VERSION_CONFLICT'
                return route.fulfill(status=409, json={'code': code, 'message': 'fake'})
            return route.fulfill(json={'current_revision': data['current_revision']})
        page.route('**/api/mcp/**', writes)
        open_panel(page, base); expect(page.get_by_test_id('mcp-settings')).to_be_visible()
        cdp = context.new_cdp_session(page); cdp.send('Animation.enable')
        def row(item_id): return page.get_by_test_id('mcp-settings').locator('aside button', has_text=item_id).first
        def open_delete(tab, item_id):
            page.get_by_role('tab', name=tab, exact=True).click()
            item = row(item_id); item.scroll_into_view_if_needed(); item.click()
            page.get_by_role('button', name='삭제', exact=True).first.click()
            dialog = page.get_by_role('dialog', name='삭제'); expect(dialog).to_be_visible(); page.wait_for_timeout(300)
            return dialog
        def open_history(item_id):
            page.get_by_role('tab', name='서버', exact=True).click()
            item = row(item_id); item.scroll_into_view_if_needed(); item.click()
            page.get_by_role('button', name='되돌리기', exact=True).click()
            dialog = page.get_by_role('dialog', name='되돌리기'); expect(dialog).to_be_visible(); page.wait_for_timeout(300)
            return dialog
        def closing(label, item_id, dialog, action, screenshot):
            handle = dialog.element_handle()
            page.wait_for_function("el => Number(getComputedStyle(el).opacity) > 0.99 && el.getAnimations().every(a => a.playState !== 'running')", arg=handle, timeout=10000)
            before = handle.inner_text(); before_height = handle.evaluate('el => el.offsetHeight')
            cdp.send('Animation.setPlaybackRate', {'playbackRate': 0.1})
            try:
                action()
                page.wait_for_function("el => el.hasAttribute('data-ending-style')", arg=handle, timeout=8000)
                page.wait_for_timeout(100)
                after = handle.inner_text()
                opacity = handle.evaluate('el => Number(getComputedStyle(el).opacity)')
                after_height = handle.evaluate('el => el.offsetHeight')
                ok = item_id in after and before == after and opacity > 0.05 and before_height == after_height
                check(f'I {label} 닫힘 내용 {tag}', ok, {'before': before, 'after': after, 'opacity': opacity, 'height': [before_height, after_height]})
                page.screenshot(path=str(out / f'r4-close-{screenshot}-{tag}.png'))
            finally:
                cdp.send('Animation.setPlaybackRate', {'playbackRate': 1})
            page.wait_for_function('el => !el.isConnected', arg=handle, timeout=10000)
        state['mode']['srv-atom-hdr-example'] = 'gone'
        dialog = open_delete('비밀값', 'srv-atom-hdr-example')
        dialog.get_by_role('button', name='삭제', exact=True).click(); expect(dialog.get_by_role('alert')).to_be_visible()
        closing('이미 삭제 재조회', 'srv-atom-hdr-example', dialog, lambda: dialog.get_by_role('button', name='다시 읽기').click(), 'gone')
        if width == 360:
            status = page.get_by_role('status').filter(has_text='이미 삭제되었습니다'); expect(status).to_be_visible(); capture(page, out, 'r4-gone-secret-360-dark')
        dialog = open_delete('서버', 'dorothy-memory')
        closing('삭제 성공', 'dorothy-memory', dialog, lambda: dialog.get_by_role('button', name='삭제', exact=True).click(), 'deleted')
        state['mode']['keke'] = 'conflict'
        dialog = open_delete('프로필', 'keke'); dialog.get_by_role('button', name='삭제', exact=True).click(); expect(dialog.get_by_role('alert')).to_be_visible()
        closing('오류 뒤 취소', 'keke', dialog, lambda: dialog.get_by_role('button', name='취소', exact=True).click(), 'cancel')
        dialog = open_delete('서버', 'clipper')
        closing('Escape', 'clipper', dialog, lambda: page.keyboard.press('Escape'), 'escape')
        dialog = open_delete('서버', 'exa')
        closing('바깥 누름', 'exa', dialog, lambda: page.mouse.click(5, 5), 'outside')
        dialog = open_history('arbor')
        closing('되돌리기 닫기', 'arbor', dialog, lambda: dialog.get_by_role('button', name='닫기', exact=True).last.click(), 'history')
        dialog = open_history('atom')
        closing('되돌리기 성공', 'atom', dialog, lambda: dialog.get_by_role('button', name='이 판으로 되돌리기').click(), 'rollback')
        check(f'브라우저 오류 {tag}', not errors, errors)
        context.close()
    failed = [result['check'] for result in results if not result['ok']]
    if failed: raise AssertionError(f'4차 검수 항목 미충족: {failed}')
    lines = ['## 4차 화면 검수 보완 조작', '', '| 항목과 화면 | 결과 |', '|---|---|']
    lines.extend(f"| {result['check']} | 통과 |" for result in results)
    lines.extend(['', '글자별 줄바꿈 실측: `r4-wrap.json`, 닫힘 전후 문구: `r4-checks.json`.', '관련 화면은 같은 폴더의 `r4-*.png`.', ''])
    out.joinpath('r4-operations.md').write_text('\n'.join(lines), encoding='utf8')

def check_artifact_references(out):
    checked = 0
    for document in [out / 'operations.md', out.parent / 'r1-report.md', out.parent / 'r2-report.md', out.parent / 'r3-report.md', out.parent / 'r4-report.md']:
        if not document.exists(): continue
        for reference in re.findall(r'`([^`]+)`', document.read_text(encoding='utf8')):
            if reference.startswith('shots/'):
                reference = reference.removeprefix('shots/')
                if not reference: continue
            elif document.parent != out or not reference.endswith(('.png', '.json', '.md', '.log')):
                continue
            if '*' in reference:
                assert any(out.glob(reference)), (document, reference)
            else:
                assert (out / reference).is_file(), (document, reference)
            checked += 1
    print(f'보고·조작 기록 참조 파일 확인: {checked}개', flush=True)

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
    parser = argparse.ArgumentParser(); parser.add_argument('--output', default=os.environ.get('MCP_SHOTS_DIR', str(ROOT / '.local' / 'mcp-settings-shots'))); parser.add_argument('--baseline-dist', default=os.environ.get('MCP_BASELINE_DIST')); parser.add_argument('--r1-only', action='store_true'); parser.add_argument('--r2-only', action='store_true'); parser.add_argument('--r3-only', action='store_true'); parser.add_argument('--r4-only', action='store_true'); args = parser.parse_args()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    server, base = serve()
    try:
        def run_suites(suites):
            # Playwright의 동기 API는 스레드마다 별도 인스턴스와 브라우저를 쓴다.
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                try:
                    for suite in suites: suite(browser, base, out)
                finally: browser.close()

        single = run_r4 if args.r4_only else run_r3 if args.r3_only else run_r2 if args.r2_only else run_r1 if args.r1_only else None
        if single:
            run_suites((single,))
        else:
            # 각 묶음은 독립 페이지와 별도 파일을 쓴다. 두 작업자가 끝난 뒤 결과를 합친다.
            with ThreadPoolExecutor(max_workers=2) as pool:
                workers = [pool.submit(run_suites, suites) for suites in ((run, run_r2), (run_r1, run_r3, run_r4))]
                for worker in workers: worker.result()
            with out.joinpath('operations.md').open('a', encoding='utf8') as operations:
                for stage in ('r1', 'r2', 'r3', 'r4'):
                    operations.write('\n' + out.joinpath(f'{stage}-operations.md').read_text(encoding='utf8'))

        if args.baseline_dist:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                try:
                    baseline_server, baseline = serve(Path(args.baseline_dist))
                    try: compare_existing(browser, baseline, base, out)
                    finally: baseline_server.shutdown()
                finally: browser.close()
        if not single: check_artifact_references(out)
    finally: server.shutdown()
    print(f'MCP 화면 캡처와 조작 결과: {out}')

if __name__ == '__main__': main()

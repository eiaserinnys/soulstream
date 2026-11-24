#!/usr/bin/env python3
"""빌드된 대시보드를 가짜 MCP API에 연결해 에이전트·서버 시험 화면을 검수한다."""
# 500줄 예외: 폭별 캡처와 이동·오류·변이 판정을 함께 실행하는 단일 검수 진입점이다.
from __future__ import annotations
import argparse
import copy
import importlib.util
import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('mcp_settings_panel', ROOT / 'scripts/visual-check/mcp_settings_panel.py')
assert SPEC and SPEC.loader
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)
base.NODES = ['sample-node-a', 'sample-node-b', 'sample-node-c']
base.NAMES = [f'sample-server-{i:02}' for i in range(26)]
base.PROFILES = [f'sample-profile-{i:02}' for i in range(12)]
OUT = ROOT.parent.parent / '.local/tmp/card1786/card1786-u5b-agent-mcp-pane/shots'


def fixture(agent_id='example-agent', node_id=None):
    data = base.fixture()
    node_id = node_id or base.NODES[0]
    if node_id != base.NODES[0]:
        data['managed_nodes'][0]['node_id'] = node_id
    data['profiles'][0]['mcp_servers'] = base.NAMES[:6] + [base.NAMES[-1]]
    data['bindings'] = [
        {'agent_id': agent_id, 'node_id': node_id, 'mcp_profile_id': data['profiles'][0]['id'], 'version': 1},
        {'agent_id': 'other-agent', 'node_id': base.NODES[1], 'mcp_profile_id': data['profiles'][0]['id'], 'version': 1},
    ]
    return data


def preview(state):
    names = base.NAMES
    enriched = state not in ('local', 'mismatch', 'blocked')
    icons = [{'kind': 'brand', 'slug': 'github', 'hex': '#181717'}, {'kind': 'symbol', 'name': 'plug', 'color': 'node-user'},
             {'kind': 'upload', 'ref': '11111111-1111-4111-8111-111111111111', 'content_hash': 'a' * 64}, None]
    rows = [{'server_id': name, 'name': name, 'type': 'streamable_http', 'included': True,
             **({'icon': icons[i % len(icons)]} if enriched else {}), **({'node_override': True} if i == 1 and enriched else {})} for i, name in enumerate(names[:6])]
    if enriched: rows.append({'server_id': names[-1], 'name': names[-1], 'type': 'streamable_http', 'included': False, 'excluded_reason': '이 노드 미적용', 'icon': None})
    if state == 'long': rows[0]['name'] = '아주긴서버이름' * 12
    normal = {'runnable': True, 'servers': rows}
    restricted = {'runnable': True, 'servers': [{'server_id': 'soulstream', 'name': 'soulstream', 'type': 'streamable_http', 'included': True}]}
    if state == 'blocked': normal = {'runnable': False, 'blocked_reason': '이 노드에서는 이 프로필을 실행할 수 없습니다.', 'servers': rows}
    return {'applied_mode': 'local' if state == 'local' else 'central', 'applied_revision': 12 if state == 'mismatch' else 14,
            'current_revision': 14, 'effective_backend': 'example', 'default_preset': None, 'isolation_enabled': state != 'no-isolation',
            'normal': normal, 'restricted': restricted}


def install(page, origin, data, scenario, seen, theme):
    base.install(page, origin, data, {'index': 0, 'external': []}, theme=theme)
    def route_api(route):
        path = urlsplit(route.request.url).path
        if path == '/api/agent-profiles':
            return route.fulfill(json={'profiles': [{'agent_id': 'example-agent', 'name': '예시 에이전트', 'context_bundles': [], 'atom_contexts': [], 'effective_atom_contexts': [], 'default_preset': None, 'aliases': [], 'has_portrait': False, 'portrait': None, 'version': 1, 'created_at': '', 'updated_at': ''}]})
        if path == '/api/context-bundles': return route.fulfill(json={'bundles': []})
        if path.startswith('/api/nodes/') and path.endswith('/agents'):
            if scenario.get('node_lookup') == 'slow': seen['held_node'] = route; return
            if scenario.get('node_lookup') == 'unavailable': return route.fulfill(status=503, json={'message': '연결 실패'})
            if scenario.get('node_lookup') == 'missing': return route.fulfill(json={'agents': []})
            return route.fulfill(json={'agents': [{'id': 'example-agent', 'name': '예시 에이전트', 'source': 'db', 'backend': 'example'}]})
        if path.endswith('/agents/context-preview'): return route.fulfill(json={'manifest': {'sources': []}, 'sections': [], 'assembled': ''})
        if path.endswith('/preview') and path.startswith('/api/mcp/agents/'):
            seen.setdefault('preview_calls', []).append(unquote(path.split('/')[4]))
            if scenario['preview'] == 'loading' or (scenario.get('hold_override') and parse_qs(urlsplit(route.request.url).query).get('mcp_profile_id')): seen['held_preview'] = route; return
            if scenario['preview'] == 'unavailable': return route.fulfill(status=503, json={'code': 'NODE_UNAVAILABLE', 'message': 'MCP node is unavailable for this request'})
            if scenario['preview'] == 'unmanaged': return route.fulfill(status=403, json={'code': 'MCP_NODE_UNMANAGED', 'message': '이 노드는 관리 대상이 아닙니다.'})
            return route.fulfill(json=preview(scenario['preview']))
        if path == '/api/mcp/config' and scenario['preview'] == 'unmanaged':
            return route.fulfill(json={**data, 'managed_nodes': [node for node in data['managed_nodes'] if node['node_id'] != base.NODES[0]]})
        if path.startswith('/api/mcp/agents/') and route.request.method == 'PUT':
            seen['binding'] = route.request.post_data_json
            seen['binding_agent'] = unquote(path.split('/')[4])
            if scenario.get('save_conflict'): return route.fulfill(status=409, json={'code': 'MCP_REVISION_CONFLICT', 'message': 'conflict'})
            body = seen['binding']; profile_id = body['mcp_profile_id']
            if body.get('fork') and profile_id:
                forked = copy.deepcopy(next(item for item in data['profiles'] if item['id'] == profile_id))
                forked['id'] += '-copy'; data['profiles'].append(forked); profile_id = forked['id']
            data['bindings'] = [item for item in data['bindings'] if not (item['agent_id'] == seen['binding_agent'] and item['node_id'] in body['node_ids'])]
            if profile_id:
                data['bindings'].extend({'agent_id': seen['binding_agent'], 'node_id': node, 'mcp_profile_id': profile_id, 'version': 2} for node in body['node_ids'])
            data['current_revision'] += 1
            return route.fulfill(json={'current_revision': data['current_revision'], 'bindings': data['bindings']})
        if path == '/api/mcp/servers/test' and route.request.method == 'POST':
            seen['test'] = route.request.post_data_json
            stage = scenario['test']
            if stage == 'loading': seen['held_test'] = route; return
            if stage == 'success': return route.fulfill(json={'ok': True, 'latency_ms': 42, 'server_info': {'name': '예시 서버', 'version': '1.0'}, 'tool_count': 120, 'tools': [f'example_tool_{i}' for i in range(100)]})
            return route.fulfill(json={'ok': False, 'latency_ms': 42, 'error_stage': stage, 'error_message': '시험용 오류입니다.'})
        return route.fallback()
    page.route('**/api/**', route_api)


def enter_agent(page, origin, agent_id='example-agent', node_id=None):
    base.open_panel(page, origin)
    page.get_by_role('tab', name='프로필', exact=True).click()
    page.get_by_role('button', name=f'{agent_id} ({node_id or base.NODES[0]})').click()
    expect(page.get_by_role('tab', name='MCP', exact=True)).to_have_attribute('aria-selected', 'true')


def shot(page, out, name):
    page.screenshot(path=str(out / f'{name}.png'), animations='disabled')


CHECK_NAMES = {
    'tabs': '탭 순서와 새 초안', 'controls': '프로필 선택 폭·줄·높이와 노드 체크',
    'no-node': '연결된 노드 없음', 'disconnect': '연결 안 함 미리보기와 노드 체크',
    'icons': '반응형 서버 아이콘', 'stale': '프로필 변경 중 이전 미리보기 제거',
    'save': '저장 알림과 초점', 'fork': '분리 대화상자·알림·초점',
    'navigation': '프로필 이동 대상·초점·화면 위치', 'wrong-agent': '지연·503·목록 누락의 이동 대상',
    'preview': '미리보기 상태와 행 배치', 'retry': '실패 재시도', 'unmanaged': '관리 밖 노드 한 줄과 요청 없음',
    'selectable': '결과 글 선택과 배지·탭 선택 제한', 'test': '연결 시험 상태·높이·목록',
    'conflict': '충돌 안내 간격', 'long': '긴 이름과 식별자 넘침',
}
WIDTHS = (1440, 430, 390, 360)
THEMES = ('light', 'dark')


def write_operations(out):
    lines = ['# 조작 결과', '', '각 조합의 결과는 해당 실행에서 끝까지 통과한 단언을 기록한다.', '',
             '| 폭 | 테마 | 결과 | 실행 시간 | 실행된 단언 |', '|---|---|---|---|---|']
    for width in WIDTHS:
        for theme in THEMES:
            path = out / f'agent-checks-{width}-{theme}.json'
            result = json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
            status = {'passed': '통과', 'failed': '실패', 'running': '실행 중'}.get(result.get('status'), '미실행')
            names = ', '.join(result.get('passed', [])) or '없음'
            if result.get('failed'): names += f"; 실패: {result['failed']}"
            elapsed = f"{result['seconds']}초" if 'seconds' in result else '—'
            lines.append(f'| {width} | {theme} | {status} | {elapsed} | {names} |')
    lines += ['', '## 단언 이름', '']
    lines += [f'- `{name}`: {description}' for name, description in CHECK_NAMES.items()]
    lines += ['', '## 캡처와 재현', '',
              '빌드한 대시보드에서 MCP 설정을 열고 프로필의 연결된 에이전트를 선택한다. '
              '서버 시험은 서버 상세의 연결 시험을 누른다. 각 상태는 가짜 API 응답으로 재현한다.',
              '파일명의 숫자는 폭, 마지막은 테마다. 예: `python3 -P scripts/visual-check/mcp_agent_panel.py --width 390 --theme light`.', '']
    descriptions = {'central-rows': '중앙 판 일치의 서버 행', 'central': '중앙 판 일치', 'isolation': '격리 필수 서버',
                    'local': '로컬 설정', 'mismatch': '판 불일치', 'blocked': '실행 불가', 'no-isolation': '격리 토글 없음',
                    'unmanaged': '관리 목록 밖 노드', 'unavailable': '미리보기 503', 'loading': '미리보기 로딩',
                    'shared': '공유 프로필 분리 확인', 'long': '긴 서버·에이전트·노드 이름',
                    'no-node': '연결된 노드 없음', 'disconnect': '저장 전 연결 안 함', 'success': '서버 시험 성공',
                    'config': '설정 단계 실패', 'connect': '연결 단계 실패', 'initialize': '초기화 단계 실패',
                    'list_tools': '도구 목록 단계 실패', 'timeout': '시간 초과'}
    for path in sorted(out.glob('*.png')):
        name = path.stem
        if not name.startswith(('agent-', 'test-')): continue
        state = name.rsplit('-', 2)[0].split('-', 1)[1]
        if state in descriptions:
            label = '서버 시험 진행 중' if name.startswith('test-loading-') else descriptions[state]
            lines.append(f'- `{path.name}`: {label}')
    temp = out / f'operations-{os.getpid()}.tmp'
    temp.write_text('\n'.join(lines) + '\n', encoding='utf8')
    temp.replace(out / 'operations.md')


class Checks:
    def __init__(self, out, width, theme):
        self.out, self.width, self.theme = out, width, theme
        self.started = time.monotonic()
        self.path = out / f'agent-checks-{width}-{theme}.json'
        self.result = {'status': 'running', 'passed': []}
        for prefix in ('agent', 'test'):
            for path in out.glob(f'{prefix}-*-{width}-{theme}.png'): path.unlink()
        self.path.unlink(missing_ok=True)
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.result, ensure_ascii=False, indent=2), encoding='utf8')
        write_operations(self.out)

    def run(self, name, action):
        try:
            action()
        except Exception:
            self.result.update(status='failed', failed=name)
            self.save()
            raise
        if name not in self.result['passed']: self.result['passed'].append(name)

    def finish(self):
        missing = set(CHECK_NAMES) - set(self.result['passed'])
        assert not missing, f'실행되지 않은 단언: {sorted(missing)}'
        self.result['seconds'] = round(time.monotonic() - self.started, 1)
        assert self.result['seconds'] < 300, f"실행 시간 초과: {self.result['seconds']}초"
        self.result['status'] = 'passed'
        self.save()


def new_page(browser, width, theme, origin, data, scenario, seen):
    context = browser.new_context(viewport={'width': width, 'height': 900 if width == 1440 else 800},
                                  color_scheme=theme, reduced_motion='reduce', service_workers='block')
    page = context.new_page(); page.set_default_timeout(12000)
    page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
    install(page, origin, data, scenario, seen, theme)
    return context, page


def assert_controls(page, width):
    pane = page.locator('[data-testid=agent-profile-editor]')
    select = pane.get_by_label('MCP 프로필')
    assert select.evaluate('el => el.clientWidth') >= 160
    assert select.locator('xpath=../span').evaluate('el => el.getClientRects().length') == 1
    for button in (pane.get_by_role('button', name='연결 저장'), pane.get_by_role('button', name='이 프로필 편집')):
        box, other = select.bounding_box(), button.bounding_box()
        if abs(box['y'] - other['y']) <= 1: assert abs(box['height'] - other['height']) <= 1
    first = pane.get_by_role('checkbox', name=base.NODES[0])
    expect(first).to_be_checked(); expect(first).to_be_disabled()


def assert_disconnect(page, seen, out, suffix):
    pane = page.locator('[data-testid=agent-profile-editor]')
    select = pane.get_by_label('MCP 프로필')
    before = len(seen['preview_calls'])
    select.select_option('')
    for checkbox in pane.get_by_role('checkbox').all(): expect(checkbox).to_be_disabled()
    notice = pane.get_by_text('연결을 뗀 뒤의 미리보기는 저장한 뒤에 볼 수 있습니다.', exact=False)
    expect(notice).to_be_visible(); notice.scroll_into_view_if_needed()
    assert len(seen['preview_calls']) == before
    shot(page, out, f'agent-disconnect-{suffix}')
    select.select_option(base.PROFILES[0])
    expect(pane.get_by_text('중앙 판 14 일치')).to_be_visible()


def assert_icons(page, width):
    info = page.locator('[data-testid=agent-profile-editor]').evaluate("""root => {
      const span = [...root.querySelectorAll('span')].find(el =>
        (el.className === 'sm:hidden' || el.className === 'hidden sm:block') && getComputedStyle(el).display !== 'none');
      return {tiles: span.querySelectorAll('.mcp-icon').length, text: span.innerText.trim()};
    }""")
    assert info['tiles'] == (7 if width == 1440 else 4), info
    assert ('+3' in info['text']) == (width != 1440), info


def assert_tabs(page):
    tabs = page.locator('[role=tablist][aria-label="프로필 보기"] [role=tab]')
    assert tabs.all_text_contents() == ['조립', '편집', 'MCP']
    positions = tabs.evaluate_all('els => els.map(el => el.getBoundingClientRect().top)')
    assert max(positions) - min(positions) <= 1


def assert_preview(page, width):
    pane = page.locator('[data-testid=agent-profile-editor]')
    expect(pane.get_by_text('노드 덮어쓰기 적용')).to_be_visible()
    expect(pane.get_by_text('이 노드 미적용')).to_be_visible()
    assert pane.get_by_text('포함', exact=True).count() > 0
    badge = pane.get_by_text('노드 덮어쓰기 적용')
    assert 'bg-primary' not in (badge.get_attribute('class') or '')
    if width != 1440:
        rows = pane.locator('#agent-mcp-preview > div > div').evaluate_all("""els => els.map(row => {
          const name = row.querySelector('strong').getBoundingClientRect();
          const badge = row.querySelector('[data-slot=badge]').getBoundingClientRect();
          return {nameLeft: name.left, nameTop: name.top, badgeLeft: badge.left, badgeTop: badge.top};
        })""")
        assert all(abs(row['badgeLeft'] - row['nameLeft']) <= 1 for row in rows), rows
    expect(pane.get_by_text('백엔드: example', exact=False)).to_be_visible()
    shared = pane.get_by_text('other-agent (sample-node-b)', exact=False)
    assert shared.evaluate("el => getComputedStyle(el.closest('.whitespace-nowrap')).whiteSpace") == 'nowrap'


def assert_selectable(page):
    pane = page.locator('[data-testid=agent-profile-editor]')
    selectors = ['#agent-mcp-preview strong', '#agent-mcp-preview strong + span',
                 '[data-v3-selectable-content]']
    for selector in selectors:
        assert pane.locator(selector).first.evaluate('el => getComputedStyle(el).userSelect') != 'none', selector
    assert pane.get_by_text('이 노드 미적용').evaluate('el => getComputedStyle(el).userSelect') != 'none'
    assert pane.get_by_text('포함', exact=True).first.evaluate('el => getComputedStyle(el).userSelect') == 'none'
    assert pane.get_by_role('tab', name='격리 세션').evaluate('el => getComputedStyle(el).userSelect') == 'none'


def assert_stale(page, scenario, seen):
    pane = page.locator('[data-testid=agent-profile-editor]')
    expect(pane.get_by_text(base.NAMES[0], exact=False).first).to_be_visible()
    scenario['hold_override'] = True
    pane.get_by_label('MCP 프로필').select_option(base.PROFILES[1])
    expect(pane.get_by_text('미리보기를 불러오는 중…')).to_be_visible()
    assert pane.locator('#agent-mcp-preview').count() == 0
    for _ in range(40):
        if seen.get('held_preview'): break
        page.wait_for_timeout(50)
    assert seen.get('held_preview') is not None
    scenario['hold_override'] = False
    seen.pop('held_preview').fulfill(json=preview('central'))
    expect(pane.get_by_text('중앙 판 14 일치')).to_be_visible()
    pane.get_by_label('MCP 프로필').select_option(base.PROFILES[0])
    expect(pane.get_by_text('중앙 판 14 일치')).to_be_visible()


def assert_save(page):
    pane = page.locator('[data-testid=agent-profile-editor]')
    pane.get_by_role('button', name='연결 저장').click()
    expect(pane.locator('p[role=status]')).to_contain_text('저장')
    expect(pane.get_by_role('button', name='연결 저장')).to_be_focused()
    assert page.evaluate("() => document.activeElement !== document.body && !!document.activeElement.closest('.config-dialog')")


def assert_fork(page, out, suffix):
    pane = page.locator('[data-testid=agent-profile-editor]')
    fork = pane.get_by_role('button', name='이 에이전트 전용으로 분리')
    fork.click(); dialog = page.get_by_role('dialog', name='프로필 분리')
    expect(dialog.get_by_role('button', name='취소')).to_be_focused()
    shot(page, out, f'agent-shared-{suffix}')
    page.keyboard.press('Tab'); assert dialog.evaluate('el => el.contains(document.activeElement)')
    page.keyboard.press('Escape'); expect(fork).to_be_focused()
    fork.click(); dialog.get_by_role('button', name='분리', exact=True).click()
    expect(pane.locator('p[role=status]')).to_contain_text('분리')
    expect(pane.get_by_role('button', name='연결 저장')).to_be_focused()
    options = pane.get_by_label('MCP 프로필').locator('option').all_text_contents()
    assert len(options) == len(set(options)), options
    page.keyboard.press('Tab')
    assert page.evaluate("() => document.activeElement !== document.body && !!document.activeElement.closest('.config-dialog') && document.activeElement.textContent.trim() !== '닫기'")


def assert_navigation(page):
    pane = page.locator('[data-testid=agent-profile-editor]')
    profile_id = pane.get_by_label('MCP 프로필').input_value()
    pane.get_by_role('button', name='이 프로필 편집').click()
    expect(page.get_by_role('tab', name='프로필', exact=True)).to_have_attribute('aria-selected', 'true')
    header = page.locator('.config-detail header').last
    expect(header).to_be_visible()
    expect(page.get_by_label('프로필 ID')).to_have_value(profile_id)
    expect(header).to_be_focused()
    assert header.evaluate('el => { const y = el.getBoundingClientRect().top; return y >= 0 && y < innerHeight; }')


def assert_wrong_agents(browser, width, theme, origin):
    for mode in ('slow', 'unavailable', 'missing'):
        data, seen = fixture('yaml-worker'), {}
        scenario = {'preview': 'central', 'test': 'success', 'node_lookup': mode}
        context, page = new_page(browser, width, theme, origin, data, scenario, seen)
        try:
            base.open_panel(page, origin); page.get_by_role('tab', name='프로필', exact=True).click()
            page.get_by_role('button', name=f'yaml-worker ({base.NODES[0]})').click()
            if mode == 'slow':
                expect(page.get_by_text('노드 에이전트를 불러오는 중…')).to_be_visible()
                assert not seen.get('preview_calls')
                assert page.locator('[data-testid=agent-profile-editor]').get_by_text('에이전트 MCP 연결', exact=False).count() == 0
                seen['held_node'].fulfill(json={'agents': [{'id': 'yaml-worker', 'name': 'YAML 작업자', 'source': 'yaml'}]})
            expect(page.get_by_text('중앙 판 14 일치')).to_be_visible()
            assert set(seen.get('preview_calls', [])) == {'yaml-worker'}, (mode, seen)
            assert page.locator('aside button.bg-accent-blue\\/15').filter(has_text='예시 에이전트').count() == 0
            page.get_by_role('button', name='연결 저장').click()
            expect(page.locator('[data-testid=agent-profile-editor] p[role=status]')).to_contain_text('저장')
            assert seen.get('binding_agent') == 'yaml-worker', (mode, seen)
        finally: context.close()


def assert_long(page):
    issues = page.evaluate("""() => {
      const root = document.querySelector('.config-detail'), bounds = root.getBoundingClientRect(), errors = [];
      if (root.scrollWidth > root.clientWidth + 1) errors.push('가로 스크롤');
      for (const el of root.querySelectorAll('button,select,[role=checkbox]')) {
        if (!el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.left < bounds.left - 1 || r.right > bounds.right + 1) errors.push(el.textContent || el.getAttribute('aria-label'));
      }
      return errors;
    }""")
    assert not issues, ('긴 이름 넘침', issues)


def agent_states(browser, width, theme, origin, out, checks):
    suffix = f'{width}-{theme}'
    for state in ('central', 'local', 'mismatch', 'blocked', 'no-isolation', 'unmanaged', 'unavailable', 'loading', 'long'):
        agent = 'sample-agent-' + 'long-identifier-' * 4 if state == 'long' else 'example-agent'
        node = 'sample-node-' + 'long-identifier-' * 4 if state == 'long' else base.NODES[0]
        data, seen, scenario = fixture(agent, node), {}, {'preview': state, 'test': 'success'}
        context, page = new_page(browser, width, theme, origin, data, scenario, seen)
        try:
            enter_agent(page, origin, agent, node)
            pane = page.locator('[data-testid=agent-profile-editor]')
            if state == 'central':
                expect(pane.get_by_text('중앙 판 14 일치')).to_be_visible()
                expect(pane.get_by_label('MCP 프로필')).to_be_focused()
                checks.body_font = pane.get_by_text('함께 적용할 노드').evaluate('el => getComputedStyle(el).fontSize')
                checks.run('tabs', lambda: assert_tabs(page))
                checks.run('controls', lambda: assert_controls(page, width))
                checks.run('disconnect', lambda: assert_disconnect(page, seen, out, suffix))
                checks.run('icons', lambda: assert_icons(page, width))
                checks.run('preview', lambda: assert_preview(page, width))
                checks.run('selectable', lambda: assert_selectable(page))
                pane.get_by_text('중앙 판 14 일치').scroll_into_view_if_needed(); shot(page, out, f'agent-central-{suffix}')
                pane.get_by_text('이 노드 미적용').scroll_into_view_if_needed(); shot(page, out, f'agent-central-rows-{suffix}')
                pane.get_by_role('tab', name='격리 세션').click()
                badge = pane.get_by_text('격리 필수'); expect(badge).to_be_visible()
                assert 'bg-primary' not in (badge.get_attribute('class') or '')
                shot(page, out, f'agent-isolation-{suffix}')
                pane.get_by_role('tab', name='일반 세션').click()
                checks.run('stale', lambda: assert_stale(page, scenario, seen))
                checks.run('save', lambda: assert_save(page))
                checks.run('fork', lambda: assert_fork(page, out, suffix))
                checks.run('navigation', lambda: assert_navigation(page))
            elif state == 'unavailable':
                notice = pane.get_by_text('노드에 연결할 수 없거나 노드가 이 기능을 받지 않습니다.')
                expect(notice).to_be_visible(); notice.scroll_into_view_if_needed()
                shot(page, out, f'agent-unavailable-{suffix}')
                def retry():
                    assert pane.get_by_role('button', name='다시 시도').count() == 1
                    before = len(seen['preview_calls']); scenario['preview'] = 'central'
                    pane.get_by_role('button', name='다시 시도').click()
                    expect(pane.get_by_text('중앙 판 14 일치')).to_be_visible()
                    assert len(seen['preview_calls']) == before + 1
                checks.run('retry', retry)
            elif state == 'unmanaged':
                def unmanaged():
                    text = pane.get_by_text('이 노드는 중앙 MCP 관리 목록에 없습니다.')
                    expect(text).to_be_visible(); assert text.count() == 1
                    assert pane.get_by_text('선택 노드 실행 미리보기', exact=False).count() == 0
                    assert not seen.get('preview_calls')
                    assert text.evaluate('el => getComputedStyle(el).fontSize') == checks.body_font
                    expect(pane.get_by_role('tab', name='MCP')).to_be_focused()
                checks.run('unmanaged', unmanaged); shot(page, out, f'agent-unmanaged-{suffix}')
            else:
                expected = {'loading': '미리보기를 불러오는 중…', 'blocked': '이 노드에서는 이 프로필을 실행할 수 없습니다.',
                            'local': '로컬 설정 사용 중', 'mismatch': '이 노드는 판 12 사용 중 (최신 판 14)',
                            'no-isolation': '중앙 판 14 일치', 'long': '중앙 판 14 일치'}[state]
                expect(pane.get_by_text(expected)).to_be_visible()
                if state == 'blocked': assert pane.get_by_text('노드 덮어쓰기 적용').count() == 0
                if state == 'no-isolation': assert pane.get_by_role('tab', name='격리 세션').count() == 0
                if state == 'long': checks.run('long', lambda: assert_long(page))
                pane.get_by_text(expected).scroll_into_view_if_needed(); shot(page, out, f'agent-{state}-{suffix}')
                if state == 'loading': seen['held_preview'].fulfill(json=preview('central'))
        finally: context.close()
    checks.run('wrong-agent', lambda: assert_wrong_agents(browser, width, theme, origin))


def assert_draft(browser, width, theme, origin):
    context, page = new_page(browser, width, theme, origin, fixture(), {'preview': 'central', 'test': 'success'}, {})
    try:
        enter_agent(page, origin)
        page.get_by_role('button', name='새 프로필', exact=True).click()
        expect(page.get_by_role('tab', name='MCP', exact=True)).to_be_disabled()
    finally: context.close()


def assert_no_node(browser, width, theme, origin, out):
    context, page = new_page(browser, width, theme, origin, fixture(), {'preview': 'central', 'test': 'success'}, {})
    try:
        base.open_panel(page, origin)
        back = page.locator('.config-back')
        if back.is_visible(): back.click()
        page.locator('.config-dialog').get_by_role('button', name='에이전트', exact=True).click()
        page.get_by_role('tab', name='MCP', exact=True).click()
        expect(page.get_by_text('연결된 노드가 없습니다.', exact=True)).to_be_visible()
        shot(page, out, f'agent-no-node-{width}-{theme}')
    finally: context.close()


def assert_conflict(browser, width, theme, origin):
    scenario = {'preview': 'central', 'test': 'success', 'save_conflict': True}
    context, page = new_page(browser, width, theme, origin, fixture(), scenario, {})
    try:
        enter_agent(page, origin)
        pane = page.locator('[data-testid=agent-profile-editor]')
        pane.get_by_role('button', name='연결 저장').click()
        alert = pane.get_by_role('alert'); button = alert.get_by_role('button', name='다시 읽기')
        expect(button).to_be_visible()
        gap = button.evaluate("""el => { const b = el.getBoundingClientRect(), t = el.previousElementSibling.getBoundingClientRect();
          return b.top >= t.bottom - 1 ? b.top - t.bottom : b.left - t.right; }""")
        assert gap >= 8, gap
    finally: context.close()


def server_states(browser, width, theme, origin, out, checks):
    data, seen, scenario = fixture(), {}, {'preview': 'central', 'test': 'success'}
    context, page = new_page(browser, width, theme, origin, data, scenario, seen)
    suffix = f'{width}-{theme}'
    try:
        base.open_panel(page, origin)
        select = page.get_by_label('시험 노드'); button = page.get_by_role('button', name='연결 시험', exact=True)
        box, other = select.bounding_box(), button.bounding_box()
        if abs(box['y'] - other['y']) <= 1: assert abs(box['height'] - other['height']) <= 1
        for stage in ('success', 'config', 'connect', 'initialize', 'list_tools', 'timeout', 'loading'):
            scenario['test'] = stage; button.click()
            if stage == 'loading': expect(page.get_by_role('button', name='시험 중…')).to_be_disabled()
            elif stage == 'success':
                expect(page.get_by_text('도구 120개', exact=True)).to_be_visible()
                assert page.get_by_text('도구 120개', exact=True).inner_text() == '도구 120개'
                assert page.get_by_text('예시 서버 1.0', exact=False).evaluate('el => getComputedStyle(el).userSelect') != 'none'
                page.locator('summary', has_text='도구 이름 보기').click()
                listing = page.get_by_text('example_tool_0', exact=False)
                expect(listing).to_be_visible(); assert listing.inner_text().endswith('외 20개')
                assert listing.evaluate('el => getComputedStyle(el).userSelect') != 'none'
            else:
                label = {'config': '설정', 'connect': '연결', 'initialize': '초기화', 'list_tools': '도구 목록', 'timeout': '시간 초과'}[stage]
                error = page.get_by_text(f'{label}: 시험용 오류입니다.')
                expect(error).to_be_visible(); assert error.evaluate('el => getComputedStyle(el).userSelect') != 'none'
            if stage == 'success': listing.scroll_into_view_if_needed()
            elif stage != 'loading': error.scroll_into_view_if_needed()
            shot(page, out, f'test-{stage}-{suffix}')
            if stage == 'loading': seen['held_test'].fulfill(json={'ok': True, 'latency_ms': 1, 'tool_count': 0, 'tools': []})
    finally: context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=os.environ.get('MCP_AGENT_SHOTS_DIR', str(OUT)))
    parser.add_argument('--width', type=int, choices=WIDTHS)
    parser.add_argument('--theme', choices=THEMES)
    args = parser.parse_args()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    server, origin = base.serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in ((args.width,) if args.width else WIDTHS):
                    for theme in ((args.theme,) if args.theme else THEMES):
                        checks = Checks(out, width, theme)
                        try:
                            checks.run('tabs', lambda: assert_draft(browser, width, theme, origin))
                            checks.run('no-node', lambda: assert_no_node(browser, width, theme, origin, out))
                            agent_states(browser, width, theme, origin, out, checks)
                            checks.run('conflict', lambda: assert_conflict(browser, width, theme, origin))
                            checks.run('test', lambda: server_states(browser, width, theme, origin, out, checks))
                            checks.finish()
                            print(f'{width} {theme}: {len(checks.result["passed"])}개 단언 통과', flush=True)
                        except Exception:
                            if checks.result['status'] != 'failed':
                                checks.result.update(status='failed', failed='시나리오 실행')
                                checks.save()
                            raise
            finally: browser.close()
    finally: server.shutdown()


if __name__ == '__main__': main()

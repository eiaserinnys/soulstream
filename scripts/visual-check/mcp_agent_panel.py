#!/usr/bin/env python3
"""빌드된 대시보드를 가짜 MCP API에 연결해 에이전트·서버 시험 화면을 검수한다."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit
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


def fixture():
    data = base.fixture()
    data['profiles'][0]['mcp_servers'] = base.NAMES[:6] + [base.NAMES[-1]]
    data['bindings'] = [
        {'agent_id': 'example-agent', 'node_id': base.NODES[0], 'mcp_profile_id': data['profiles'][0]['id'], 'version': 1},
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
            return route.fulfill(json={'agents': [{'id': 'example-agent', 'name': '예시 에이전트', 'source': 'db', 'backend': 'example'}]})
        if path.endswith('/agents/context-preview'): return route.fulfill(json={'manifest': {'sources': []}, 'sections': [], 'assembled': ''})
        if path.endswith('/preview') and path.startswith('/api/mcp/agents/'):
            if scenario['preview'] == 'loading': seen['held_preview'] = route; return
            if scenario['preview'] == 'unavailable': return route.fulfill(status=503, json={'code': 'NODE_UNAVAILABLE', 'message': '노드가 연결되지 않았습니다.'})
            if scenario['preview'] == 'unmanaged': return route.fulfill(status=403, json={'code': 'MCP_NODE_UNMANAGED', 'message': '이 노드는 관리 대상이 아닙니다.'})
            return route.fulfill(json=preview(scenario['preview']))
        if path == '/api/mcp/config' and scenario['preview'] == 'unmanaged':
            return route.fulfill(json={**data, 'managed_nodes': [node for node in data['managed_nodes'] if node['node_id'] != base.NODES[0]]})
        if path.startswith('/api/mcp/agents/') and route.request.method == 'PUT':
            seen['binding'] = route.request.post_data_json
            return route.fulfill(json={'current_revision': 15, 'bindings': []})
        if path == '/api/mcp/servers/test' and route.request.method == 'POST':
            seen['test'] = route.request.post_data_json
            stage = scenario['test']
            if stage == 'loading': seen['held_test'] = route; return
            if stage == 'success': return route.fulfill(json={'ok': True, 'latency_ms': 42, 'server_info': {'name': '예시 서버', 'version': '1.0'}, 'tool_count': 120, 'tools': [f'example_tool_{i}' for i in range(100)]})
            return route.fulfill(json={'ok': False, 'latency_ms': 42, 'error_stage': stage, 'error_message': '시험용 오류입니다.'})
        return route.fallback()
    page.route('**/api/**', route_api)


def enter_agent(page, origin):
    base.open_panel(page, origin)
    page.get_by_role('tab', name='프로필', exact=True).click()
    page.get_by_role('button', name=f'example-agent ({base.NODES[0]})').click()
    expect(page.get_by_role('tab', name='MCP', exact=True)).to_have_attribute('aria-selected', 'true')


def shot(page, out, name):
    page.screenshot(path=str(out / f'{name}.png'), animations='disabled')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=os.environ.get('MCP_AGENT_SHOTS_DIR', str(OUT)))
    parser.add_argument('--width', type=int, choices=(1440, 360))
    parser.add_argument('--theme', choices=('light', 'dark'))
    parser.add_argument('--area', choices=('agent', 'test'))
    args = parser.parse_args()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    server, origin = base.serve()
    captures = []
    focus_checked = False
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width in ((args.width,) if args.width else (1440, 360)):
                    for theme in ((args.theme,) if args.theme else ('light', 'dark')):
                        suffix = f'{width}-{theme}'
                        for state in (() if args.area == 'test' else ('central', 'local', 'mismatch', 'blocked', 'no-isolation', 'unmanaged', 'unavailable', 'loading', 'shared', 'long')):
                            context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
                            page = context.new_page(); page.set_default_timeout(15000)
                            page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
                            data, seen, scenario = fixture(), {}, {'preview': state, 'test': 'success'}
                            install(page, origin, data, scenario, seen, theme)
                            enter_agent(page, origin)
                            detail = page.locator('.config-detail')
                            tops = detail.locator('#agent-profile-pane-assembly, #agent-profile-pane-edit, #agent-profile-pane-mcp').evaluate_all('(els) => els.map(el => el.getBoundingClientRect().top)')
                            assert len(tops) == 3 and max(tops) - min(tops) <= 1, tops
                            if state == 'loading':
                                expect(page.get_by_text('미리보기를 불러오는 중…')).to_be_visible()
                            elif state == 'unavailable': expect(page.get_by_text('노드 연결 또는 기능을 확인해 주세요.', exact=False)).to_be_visible()
                            elif state == 'unmanaged': expect(page.get_by_text('이 노드는 중앙 MCP 관리 목록에 없습니다.')).to_be_visible()
                            elif state == 'blocked':
                                expect(page.get_by_text('이 노드에서는 이 프로필을 실행할 수 없습니다.')).to_be_visible()
                                assert detail.get_by_text('노드 덮어쓰기 적용').count() == 0
                            elif state == 'local': expect(page.get_by_text('로컬 설정 사용 중')).to_be_visible()
                            elif state == 'mismatch': expect(page.get_by_text('이 노드는 판 12 사용 중 (최신 판 14)')).to_be_visible()
                            elif state == 'no-isolation':
                                expect(page.get_by_text('중앙 판 14 일치')).to_be_visible()
                                assert detail.get_by_role('tab', name='격리 세션').count() == 0
                            else:
                                expect(page.get_by_text('중앙 판 14 일치')).to_be_visible()
                                if state == 'central':
                                    expect(detail.get_by_text('노드 덮어쓰기 적용')).to_be_visible()
                                    expect(detail.get_by_text('이 노드 미적용')).to_be_visible()
                                    assert detail.get_by_text('포함', exact=True).count() > 0
                            if state == 'shared':
                                fork = detail.get_by_role('button', name='이 에이전트 전용으로 분리')
                                fork.click(); dialog = page.get_by_role('dialog', name='프로필 분리')
                                expect(dialog).to_be_visible(); expect(dialog.get_by_role('button', name='취소')).to_be_focused()
                                page.keyboard.press('Tab'); assert dialog.evaluate('(el) => el.contains(document.activeElement)')
                                shot(page, out, f'agent-{state}-{suffix}'); captures.append(f'agent-{state}-{suffix}.png')
                                page.keyboard.press('Escape'); expect(fork).to_be_focused()
                                fork.click(); expect(dialog.get_by_role('button', name='취소')).to_be_focused()
                                page.keyboard.press('Enter'); expect(fork).to_be_focused(); focus_checked = True
                            else:
                                target = (detail.get_by_text('이 노드는 중앙 MCP 관리 목록에 없습니다.') if state == 'unmanaged'
                                          else detail.get_by_text('미리보기를 불러오는 중…') if state == 'loading'
                                          else detail.get_by_role('alert').last if state in ('blocked', 'unavailable')
                                          else detail.get_by_text('로컬 설정 사용 중') if state == 'local'
                                          else detail.get_by_text('이 노드는 판 12 사용 중 (최신 판 14)') if state == 'mismatch'
                                          else detail.get_by_text('중앙 판 14 일치'))
                                target.scroll_into_view_if_needed()
                                shot(page, out, f'agent-{state}-{suffix}'); captures.append(f'agent-{state}-{suffix}.png')
                            if state == 'central':
                                detail.get_by_text('이 노드 미적용').scroll_into_view_if_needed()
                                shot(page, out, f'agent-central-rows-{suffix}'); captures.append(f'agent-central-rows-{suffix}.png')
                                detail.get_by_role('tab', name='격리 세션').click(); expect(detail.get_by_text('격리 필수')).to_be_visible()
                                shot(page, out, f'agent-isolation-{suffix}'); captures.append(f'agent-isolation-{suffix}.png')
                                page.set_viewport_size({'width': 360 if width > 360 else 1440, 'height': 800})
                                expect(detail.get_by_text('격리 필수')).to_be_visible()
                            if state == 'long':
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
                            if state == 'loading': seen['held_preview'].fulfill(json=preview('central'))
                            context.close()
                        for stage in (() if args.area == 'agent' else ('success', 'config', 'connect', 'initialize', 'list_tools', 'timeout', 'loading')):
                            context = browser.new_context(viewport={'width': width, 'height': 900 if width > 360 else 800}, color_scheme=theme, reduced_motion='reduce', service_workers='block')
                            page = context.new_page(); page.set_default_timeout(15000)
                            page.add_init_script(f"localStorage.setItem('soul-dashboard-theme','{theme}'); localStorage.setItem('ls.webglGlass','0');")
                            data, seen, scenario = fixture(), {}, {'preview': 'central', 'test': stage}
                            install(page, origin, data, scenario, seen, theme); base.open_panel(page, origin)
                            page.get_by_role('button', name='연결 시험', exact=True).click()
                            if stage == 'loading': expect(page.get_by_role('button', name='시험 중…')).to_be_disabled()
                            elif stage == 'success':
                                expect(page.get_by_text('도구 120개 · 외 20개')).to_be_visible()
                                page.locator('summary', has_text='도구 이름 보기').click(); expect(page.get_by_text('example_tool_0', exact=False)).to_be_visible()
                            else:
                                label = {'config': '설정', 'connect': '연결', 'initialize': '초기화', 'list_tools': '도구 목록', 'timeout': '시간 초과'}[stage]
                                expect(page.get_by_text(f'{label}: 시험용 오류입니다.')).to_be_visible()
                            shot(page, out, f'test-{stage}-{suffix}'); captures.append(f'test-{stage}-{suffix}.png')
                            if stage == 'loading': seen['held_test'].fulfill(json={'ok': True, 'latency_ms': 1, 'tool_count': 0, 'tools': []})
                            context.close()
            finally: browser.close()
    finally: server.shutdown()
    if args.area != 'test': assert focus_checked
    complete = len(list(out.glob('agent-*.png'))) >= 48 and len(list(out.glob('test-*.png'))) >= 28
    outcome = '통과' if complete else '부분 확인'
    lines = ['# 조작 결과', '', '| 항목 | 결과 | 근거 |', '|---|---|---|',
             f'| 14 | {outcome} | 분리 창은 취소에 초점을 주고 Esc 뒤 연 단추로 돌아간다. |',
             f'| 15 | {outcome} | 분리 창에서 Tab은 창 안을 이동하고 Esc로 닫힌다. |',
             f'| 16 | {outcome} | 360px 긴 이름의 상세 영역 가로 넘침을 검사한다. |',
             f'| 17 | {outcome} | 503과 시험 단계별 오류를 화면에 표시한다. |',
             f'| 18 | {outcome} | 격리 미리보기를 연 채 1440↔360으로 바꿔 내용이 유지되는지 본다. |', '',
             '| 대화상자 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |', '|---|---|---|---|---|---|',
             '| 프로필 분리 | 이 에이전트 전용으로 분리 | 취소 | 취소 단추 동작 | 닫힘 | 분리 단추 |', '',
             '실행: `python3 -P scripts/visual-check/mcp_agent_panel.py --width 1440 --theme light --area agent` 및 같은 명령의 `--area test`, `--width 360 --theme light`의 agent/test, `--width 1440 --theme dark`와 `--width 360 --theme dark`(두 화면 모두). 인자 없이 실행하면 전체를 검사한다.', '', '## 캡처와 재현', '',
             '각 파일은 MCP 설정 > 프로필 > 연결된 에이전트로 들어가 해당 응답 상태를 주입한 화면이다. 서버 시험은 MCP 설정 > 서버 > 연결 시험에서 노드 응답을 바꾼 화면이다. 파일명의 숫자는 뷰포트 폭, 마지막은 테마다.', '']
    descriptions = {
        'agent-central-rows': '중앙 판 일치: 서버 행과 이 노드 미적용', 'agent-central': '중앙 판 일치와 노드 덮어쓰기',
        'agent-isolation': '격리 세션 필수 서버', 'agent-local': '로컬 설정 사용', 'agent-mismatch': '중앙 판 불일치',
        'agent-blocked': '실행 불가 사유', 'agent-no-isolation': '격리 토글 숨김', 'agent-unmanaged': '관리 목록 밖 노드',
        'agent-unavailable': '노드 연결 503', 'agent-loading': '미리보기 로딩', 'agent-shared': '공유 프로필 분리 확인',
        'agent-long': '긴 서버 이름', 'test-success': '서버 시험 성공과 긴 도구 목록', 'test-config': '설정 단계 실패',
        'test-connect': '연결 단계 실패', 'test-initialize': '초기화 단계 실패', 'test-list_tools': '도구 목록 단계 실패',
        'test-timeout': '시간 초과', 'test-loading': '서버 시험 진행 중',
    }
    for name in sorted(path.name for path in out.glob('*.png')):
        if not any(name.startswith(key + '-') for key in descriptions): continue
        key = next(key for key in sorted(descriptions, key=len, reverse=True) if name.startswith(key + '-'))
        lines.append(f'- `{name}`: {descriptions[key]}')
    out.joinpath('operations.md').write_text('\n'.join(lines) + '\n', encoding='utf8')
    print(f'에이전트 MCP 캡처 {len(captures)}개와 조작 결과: {out}')

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""접속 링크 설정 탭의 상태, 초점과 좁은 화면을 검수한다.

실행: python3 -P unified-dashboard/scripts/visual-check/access_links_tab.py \
  http://127.0.0.1:5173 .local/card1457-link-ui-tab --mode after --phase wide

wide, narrow, states를 차례로 실행하면 종합 report.json을 만든다.

검수 창에서 호출하는 API는 page.route로 가로채며, 주소에는 가짜 키만 쓴다.
서버가 필요하면 --serve를 더해 같은 프로세스의 자식으로 Vite를 띄운다.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
FAKE_URL = 'https://example.test/x/fake-review-key'
NAMES = ['✨ 서소영 관제', '🌿 로젤린 작업', '🔍 조사 세션', '📝 글쓰기', '🎨 디자인 검수', '🧭 프로젝트 안내', '📚 자료 정리', '🤖 아주 긴 영구 에이전트 세션 이름']
SESSIONS = [{'session_id': f'00000000-0000-4000-8000-{i + 1:012}', 'display_name': name, 'agent_name': '로젤린'} for i, name in enumerate(NAMES)]


def iso(offset):
    return (datetime.now(timezone.utc) + timedelta(days=offset)).isoformat()


def new_links():
    return [{'id': f'link-{i}', 'label': label, 'target_session_id': SESSIONS[i]['session_id'],
             'permissions': ['send', 'read_own'], 'created_at': iso(-3), 'expires_at': iso(-1 if i == 3 else 7),
             'revoked_at': None, 'last_used_at': None}
            for i, label in enumerate(['외부 조사 도우미', '요약 에이전트', ('긴 발신자 이름 ' * 10)[:80], '지난 연결'])]


def focus(page):
    return page.evaluate("""() => { const el = document.activeElement; return {
      tag: el?.tagName, label: el?.getAttribute('aria-label'), text: (el?.textContent || '').trim().slice(0, 40),
      dialog: Boolean(el?.closest('[role=dialog]')), visible: !!el?.getBoundingClientRect().width
    }; }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('base')
    parser.add_argument('output', type=Path)
    parser.add_argument('--mode', choices=['after'], default='after')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--phase', choices=['wide', 'narrow', 'states'], required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    server = None
    problems = []
    measurements = {}
    state = {'links': new_links(), 'list': 'normal', 'issue': 201, 'revoke': 200}
    if args.serve:
        env = {**os.environ, 'VITE_API_BASE': 'http://127.0.0.1:9'}
        server = subprocess.Popen(['corepack', 'pnpm', '--dir', str(ROOT / 'unified-dashboard'), 'exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
            context.add_init_script("""(() => {
              const original = window.fetch;
              window.fetch = async (...args) => {
                const response = await original(...args);
                if (new URLSearchParams(location.search).has('accessLinksDelay') &&
                    String(args[0]).endsWith('/api/access-links') && (!args[1]?.method || args[1].method === 'GET')) {
                  await new Promise(resolve => setTimeout(resolve, 2500));
                }
                return response;
              };
            })()""")
            context.route('**/api/**', lambda route: route.fulfill(json={}))
            context.route('**/api/auth/config', lambda route: route.fulfill(json={'authEnabled': True, 'devModeEnabled': False}))
            context.route('**/api/auth/status', lambda route: route.fulfill(json={'authenticated': True, 'user': {'email': 'qa@example.test', 'name': 'QA', 'isAdmin': True}}))
            context.route('**/api/health', lambda route: route.fulfill(json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'}))
            context.route('**/api/nodes', lambda route: route.fulfill(json={'nodes': [{'nodeId': 'eiaserinnys', 'status': 'connected', 'host': 'localhost', 'port': 3105, 'capabilities': {}, 'connectedAt': 0, 'sessionCount': 1}]}))
            context.route('**/api/nodes/stream', lambda route: route.fulfill(content_type='text/event-stream', body='event: snapshot\ndata: []\n\n'))
            page = context.new_page()
            page_errors = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            def route_api(route):
                request = route.request
                path = request.url.split('?')[0]
                if path.endswith('/api/persistent-sessions'):
                    route.fulfill(json={'sessions': SESSIONS, 'total': len(SESSIONS)})
                elif request.method == 'GET':
                    if state['list'] == 'error': route.fulfill(status=503, json={'detail': 'fixture failure'})
                    else: route.fulfill(json=[] if state['list'] == 'empty' else state['links'])
                elif request.method == 'POST':
                    if state['issue'] != 201: route.fulfill(status=state['issue'], json={'detail': 'fixture failure'})
                    else:
                        body = request.post_data_json
                        link = {'id': 'issued', **body, 'created_at': iso(0), 'expires_at': iso(1), 'revoked_at': None, 'last_used_at': None}
                        state['links'].insert(0, link)
                        route.fulfill(status=201, json={**link, 'url': FAKE_URL})
                else:
                    if state['revoke'] != 200: route.fulfill(status=state['revoke'], json={'detail': 'fixture failure'})
                    else:
                        link_id = path.rsplit('/', 1)[-1]
                        link = next(item for item in state['links'] if item['id'] == link_id)
                        link['revoked_at'] = iso(0)
                        route.fulfill(json=link)
            page.route('**/api/access-links**', route_api)
            page.route('**/api/persistent-sessions', route_api)
            def shot(name): page.screenshot(path=str(args.output / f'{name}.png'), animations='disabled')
            def open_tab(width, list_state='normal'):
                state['list'] = list_state
                page.set_viewport_size({'width': width, 'height': 800 if width == 360 else 1000})
                for attempt in range(30):
                    try:
                        delay = '&accessLinksDelay=1' if list_state == 'loading' else ''
                        page.goto(args.base.rstrip('/') + '/dialogues?sample=settings&accessLinksVisual=1' + delay, wait_until='domcontentloaded', timeout=3000)
                        break
                    except Exception:
                        if attempt == 29: raise
                        time.sleep(1)
                try:
                    page.get_by_role('button', name='접속 링크', exact=True).click(timeout=30000)
                except Exception:
                    page.screenshot(path=str(args.output / 'execution-error.png'))
                    measurements['pageText'] = page.locator('body').inner_text()[:1200]
                    measurements['pageErrors'] = page_errors
                    measurements['pageUrl'] = page.url
                    raise
                page.get_by_role('button', name='링크 만들기', exact=True).wait_for()
            def open_issue():
                page.get_by_role('button', name='링크 만들기', exact=True).first.click()
                page.get_by_role('dialog').last.get_by_text('새 접속 링크').wait_for()
                page.wait_for_function("() => !document.querySelector('[role=dialog][data-open]:last-of-type')?.hasAttribute('data-starting-style')")
                page.wait_for_timeout(250)
            def choose(label):
                page.get_by_role('combobox', name='대상 세션').click()
                page.get_by_role('option', name=label, exact=True).click()
            def overflow(name):
                result = page.evaluate("""() => ({page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
                  dialogs: [...document.querySelectorAll('[role=dialog][data-open]')].map(e => ({scroll:e.scrollWidth, client:e.clientWidth}))})""")
                measurements[name] = result
                if result['page'] > result['viewport'] + 1 or any(x['scroll'] > x['client'] + 1 for x in result['dialogs']): problems.append(name + ': 가로 넘침')
            for width in ([1440] if args.phase == 'wide' else [360] if args.phase == 'narrow' else []):
                state['links'] = new_links()
                open_tab(width)
                page.get_by_text('외부 조사 도우미').wait_for()
                shot(f'tab-{width}-closed')
                page.get_by_text('지난 링크', exact=False).first.click()
                shot(f'tab-{width}-expanded')
                overflow(f'tab-{width}')
                open_issue()
                measurements[f'issue-open-{width}'] = focus(page)
                if measurements[f'issue-open-{width}']['label'] != '대상 세션': problems.append(f'{width}: 발급 창 초점')
                shot(f'issue-{width}-empty')
                choose(SESSIONS[0]['display_name'])
                shot(f'issue-{width}-selected')
                page.get_by_label('발신자 이름').fill('검수용 발신자')
                page.get_by_role('combobox', name='대상 세션').click()
                page.get_by_role('option', name='세션 ID 직접 입력').click()
                page.wait_for_timeout(400)
                measurements[f'manual-focus-{width}'] = focus(page)
                if measurements[f'manual-focus-{width}']['label'] != '세션 ID': problems.append(f'{width}: 직접 입력 초점')
                page.get_by_label('세션 ID').fill('bad')
                page.get_by_label('세션 ID').blur()
                shot(f'issue-{width}-invalid')
                page.get_by_label('세션 ID').fill(SESSIONS[0]['session_id'])
                state['issue'] = 404
                page.get_by_role('dialog').last.get_by_role('button', name='링크 만들기').click()
                page.get_by_text('이 세션을 찾지 못했거나 열 수 없습니다.').wait_for()
                shot(f'issue-{width}-404')
                state['issue'] = 503
                page.get_by_role('dialog').last.get_by_role('button', name='링크 만들기').click()
                page.get_by_text('지금은 링크를 만들 수 없습니다. 잠시 뒤 다시 시도하세요.').wait_for()
                shot(f'issue-{width}-503')
                for box in page.get_by_role('checkbox').all():
                    if box.is_checked(): box.click()
                page.get_by_text('하나 이상 고르세요.').wait_for()
                shot(f'issue-{width}-no-permissions')
                page.get_by_role('checkbox').first.click()
                state['issue'] = 201
                page.get_by_role('dialog').last.get_by_role('button', name='링크 만들기').click()
                page.get_by_text(FAKE_URL).wait_for()
                page.wait_for_timeout(150)
                measurements[f'url-focus-{width}'] = focus(page)
                if measurements[f'url-focus-{width}']['text'] != '복사': problems.append(f'{width}: 주소 창 초점')
                shot(f'url-{width}-before-copy')
                page.get_by_role('button', name='복사', exact=True).click()
                page.get_by_role('button', name='복사됨').wait_for()
                shot(f'url-{width}-copied')
                page.evaluate("() => { navigator.clipboard.writeText = () => Promise.reject(new Error('fixture')); }")
                page.get_by_role('button', name='복사됨').click()
                page.get_by_text('복사하지 못했습니다. 주소를 직접 골라 복사하세요.').wait_for()
                shot(f'url-{width}-copy-error')
                page.get_by_role('dialog').last.get_by_role('button', name='닫기', exact=True).last.click()
                page.wait_for_timeout(400)
                measurements[f'closed-focus-{width}'] = focus(page)
                page.get_by_role('button', name='폐기', exact=True).first.click()
                page.wait_for_timeout(250)
                measurements[f'revoke-open-{width}'] = focus(page)
                if measurements[f'revoke-open-{width}']['text'] != '취소': problems.append(f'{width}: 폐기 창 초점')
                shot(f'revoke-{width}')
                state['revoke'] = 503
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.get_by_text('지금은 폐기하지 못했습니다. 다시 시도하세요.').wait_for()
                shot(f'revoke-{width}-error')
                state['revoke'] = 200
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.wait_for_timeout(250)
                measurements[f'revoked-focus-{width}'] = focus(page)
                if not page.locator('details.config-advanced').evaluate('(element) => element.open'):
                    page.get_by_text('지난 링크', exact=False).first.click()
                shot(f'revoked-{width}')
            if args.phase == 'states':
                open_tab(360, 'empty'); page.get_by_text('아직 만든 링크가 없습니다.').wait_for(); shot('list-empty')
                open_tab(360, 'error'); page.get_by_text('링크 목록을 불러오지 못했습니다.').wait_for(); shot('list-error')
                open_tab(360, 'loading')
                page.get_by_role('status', name='불러오는 중').wait_for()
                shot('list-loading')
                page.get_by_role('status', name='불러오는 중').wait_for(state='hidden')
                state['list'] = 'normal'; open_tab(1440); open_issue()
                choose(SESSIONS[0]['display_name']); page.get_by_label('발신자 이름').fill('크기 변경 확인')
                page.set_viewport_size({'width': 360, 'height': 800}); shot('resize-360'); overflow('resize-360')
                if page.get_by_label('발신자 이름').input_value() != '크기 변경 확인': problems.append('창 크기 변경 중 입력이 사라짐')
                page.set_viewport_size({'width': 1440, 'height': 1000}); shot('resize-1440'); overflow('resize-1440')
                tabs = []
                for _ in range(6): page.keyboard.press('Tab'); tabs.append(focus(page))
                measurements['tab-focus'] = tabs
                if not all(item['dialog'] for item in tabs): problems.append('Tab 초점이 열린 창 밖으로 이동')
                page.keyboard.press('Escape')
                page.get_by_text('새 접속 링크').wait_for(state='hidden')
                page.wait_for_timeout(800)
                measurements['escape-focus'] = focus(page)
                if measurements['escape-focus']['text'] != '링크 만들기': problems.append('Esc 뒤 초점 복귀')
                page.get_by_role('button', name='폐기', exact=True).first.click()
                page.wait_for_timeout(300)
                page.get_by_role('dialog').last.get_by_role('button', name='취소').click()
                page.wait_for_timeout(800)
                measurements['cancel-focus'] = focus(page)
                if measurements['cancel-focus']['text'] != '폐기': problems.append('폐기 취소 뒤 초점 복귀')
                page.get_by_role('button', name='폐기', exact=True).first.click()
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.wait_for_timeout(800)
                measurements['revoke-complete-focus'] = focus(page)
                if measurements['revoke-complete-focus']['text'] not in ['폐기', '링크 만들기']: problems.append('폐기 완료 뒤 초점 복귀')
            browser.close()
    except Exception as exc:
        problems.append(f'실행 실패: {type(exc).__name__}: {exc}')
        if 'page' in locals():
            try:
                page.screenshot(path=str(args.output / 'execution-error.png'))
                measurements['pageText'] = page.locator('body').inner_text()[:1200]
                measurements['pageErrors'] = page_errors
            except Exception:
                pass
    finally:
        if server:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
    report = {'mode': args.mode, 'phase': args.phase, 'result': 'pass' if not problems else 'fail', 'measurements': measurements, 'problems': problems}
    (args.output / f'report-{args.phase}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    phases = [args.output / f'report-{phase}.json' for phase in ['wide', 'narrow', 'states']]
    if all(path.exists() for path in phases):
        parts = [json.loads(path.read_text(encoding='utf-8')) for path in phases]
        combined = {'mode': args.mode, 'result': 'pass' if all(part['result'] == 'pass' for part in parts) else 'fail', 'phases': parts}
        (args.output / 'report.json').write_text(json.dumps(combined, ensure_ascii=False, indent=2), encoding='utf-8')
    overall = combined['result'] if all(path.exists() for path in phases) else report['result']
    print(json.dumps({'result': overall, 'problems': problems}, ensure_ascii=False))
    return 1 if overall != 'pass' else 0


if __name__ == '__main__':
    sys.exit(main())

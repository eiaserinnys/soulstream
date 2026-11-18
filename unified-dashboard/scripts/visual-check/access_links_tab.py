#!/usr/bin/env python3
"""접속 링크 설정 탭의 상태, 초점과 좁은 화면을 검수한다.

실행: python3 -P unified-dashboard/scripts/visual-check/access_links_tab.py \
  http://127.0.0.1:5173 .local/card1457-link-ui-tab --mode after --phase wide

wide, narrow, states, details-wide, details-narrow, keyboard-wide, keyboard-narrow를
차례로 실행하면 종합 report.json을 만든다.

검수 창에서 호출하는 API는 page.route로 가로채며, 주소에는 가짜 키만 쓴다.
서버가 필요하면 --serve를 더해 같은 프로세스의 자식으로 Vite를 띄운다.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
FAKE_URL = 'https://soulstream.example.test/x/sl_fakeid_' + 'A' * 43
NAMES = ['✨ 서소영 관제', '🌿 로젤린 작업', '🔍 조사 세션', '📝 글쓰기', '🎨 디자인 검수', '🧭 프로젝트 안내', '📚 자료 정리', '🤖 아주 긴 영구 에이전트 세션 이름']
SESSIONS = [{'session_id': f'00000000-0000-4000-8000-{i + 1:012}', 'display_name': name, 'agent_name': '로젤린'} for i, name in enumerate(NAMES)]


def iso(offset):
    return (datetime.now(timezone.utc) + timedelta(days=offset)).isoformat()


def new_links():
    links = [{'id': f'link-{i}', 'label': label, 'target_session_id': SESSIONS[i]['session_id'],
              'permissions': ['send', 'read_own', 'read_history', 'control'] if i == 2 else ['send', 'read_own'],
              'created_at': iso(-3), 'expires_at': iso(-1 if i == 3 else 7),
              'revoked_at': None, 'last_used_at': (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat() if i == 0 else None}
             for i, label in enumerate(['외부 조사 도우미', '요약 에이전트', ('긴 발신자 이름 ' * 10)[:80], '지난 연결'])]
    links[1]['target_session_id'] = '3f2a9c1e-77b0-4c1d-9e2a-5a0f00000000'
    return links


def focus(page):
    return page.evaluate("""() => { const el = document.activeElement; const dialog = el?.closest('[role=dialog]');
      const text = el?.tagName === 'BODY' ? '' : (el?.textContent || '').trim();
      const name = el?.getAttribute('aria-label') || (el?.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || el?.closest('label')?.textContent?.trim() || text;
      const style = el && getComputedStyle(el); const parent = el?.parentElement && getComputedStyle(el.parentElement);
      return {tag: el?.tagName, role: el?.getAttribute('role'), name, label: el?.getAttribute('aria-label'), text: text.slice(0, 80),
        dialogTitle: dialog?.querySelector('[data-slot=dialog-title], h2')?.textContent?.trim() || null,
        rowLabel: el?.closest('.access-links-row')?.querySelector('.access-links-label')?.textContent?.trim() || null,
        ring: Boolean(el?.matches(':focus-visible') && ((style?.outlineStyle !== 'none' && parseFloat(style?.outlineWidth) > 0) || style?.boxShadow !== 'none' || parent?.boxShadow !== 'none')),
        visible: !!el?.getBoundingClientRect().width, dialog: Boolean(dialog)}; }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('base')
    parser.add_argument('output', type=Path)
    parser.add_argument('--mode', choices=['after'], default='after')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--phase', choices=['wide', 'narrow', 'states', 'details-wide', 'details-narrow', 'keyboard-wide', 'keyboard-narrow'], required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    inputs = [Path(__file__), Path(__file__).with_name('access_links_keyboard.py'),
              ROOT / 'unified-dashboard/client/components/AccessLinksTab.tsx',
              ROOT / 'unified-dashboard/client/components/CatalogSelectionField.tsx',
              ROOT / 'unified-dashboard/client/components/config/access-links.css',
              ROOT / 'unified-dashboard/client/components/config/config-layout.css',
              ROOT / 'unified-dashboard/client/components/config/SettingsListDetail.tsx']
    fingerprint = hashlib.sha256(b''.join(path.read_bytes() for path in inputs)).hexdigest()
    server = None
    problems = []
    measurements = {}
    state = {'links': new_links(), 'list': 'normal', 'issue': 201, 'revoke': 200, 'pas': 'ok'}
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
                if (new URLSearchParams(location.search).has('pasDelay') && String(args[0]).endsWith('/api/persistent-sessions')) await new Promise(resolve => setTimeout(resolve, 4000));
                if (new URLSearchParams(location.search).has('slowWrite') && ['POST', 'DELETE'].includes(args[1]?.method)) await new Promise(resolve => setTimeout(resolve, 1500));
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
                    if state['pas'] == 'error': route.fulfill(status=503, json={'detail': 'fixture failure'})
                    else: route.fulfill(json={'sessions': SESSIONS, 'total': len(SESSIONS)})
                elif request.method == 'GET':
                    if state['list'] == 'error': route.fulfill(status=503, json={'detail': 'fixture failure'})
                    else: route.fulfill(json=[] if state['list'] == 'empty' else state['links'])
                elif request.method == 'POST':
                    if state['issue'] != 201: route.fulfill(status=state['issue'], json={'detail': 'fixture failure'})
                    else:
                        body = request.post_data_json
                        link = {'id': f'issued-{len(state["links"])}', **body, 'created_at': iso(0), 'expires_at': iso(1), 'revoked_at': None, 'last_used_at': None}
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
            def open_tab(width, list_state='normal', extra='', height=None):
                state['list'] = list_state
                page.set_viewport_size({'width': width, 'height': height or (800 if width == 360 else 1000)})
                for attempt in range(30):
                    try:
                        delay = '&accessLinksDelay=1' if list_state == 'loading' else ''
                        page.goto(args.base.rstrip('/') + '/dialogues?sample=settings&accessLinksVisual=1' + delay + extra, wait_until='domcontentloaded', timeout=3000)
                        break
                    except Exception:
                        if attempt == 29: raise
                        time.sleep(1)
                try:
                    page.get_by_role('button', name='접속 링크', exact=True).click(timeout=30000)
                except Exception:
                    page.screenshot(path=str(args.output / 'execution-error.png'))
                    measurements['pageErrors'] = len(page_errors)
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
                result = page.evaluate("""() => {
                  const roots = [...document.querySelectorAll('.access-links, [role=dialog][data-open]')];
                  const bounds = roots.map(root => {
                    const r = root.getBoundingClientRect();
                    const escaped = [...root.querySelectorAll('*')].filter(el => {
                      const s = getComputedStyle(el), b = el.getBoundingClientRect();
                      if (!b.width || !b.height || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
                      if (b.bottom <= r.top || b.top >= r.bottom || b.bottom <= 0 || b.top >= innerHeight) return false;
                      if (el.closest('[aria-hidden=true]') || s.position === 'fixed') return false;
                      const clipped = el.parentElement?.closest('[style*="overflow"], .truncate, .access-links-label');
                      if (clipped && clipped !== root) return false;
                      return b.left < r.left - 1 || b.right > r.right + 1;
                    }).map(el => ({tag:el.tagName, cls:String(el.className).slice(0,80), left:el.getBoundingClientRect().left, right:el.getBoundingClientRect().right}));
                    return {title:root.querySelector('[data-slot=dialog-title]')?.textContent || '접속 링크', left:r.left, right:r.right, scroll:root.scrollWidth, client:root.clientWidth, escaped:escaped.slice(0,20)};
                  });
                  return {page:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth, bounds};
                }""")
                measurements[name] = result
                if result['page'] > result['viewport'] + 1 or any(x['scroll'] > x['client'] + 1 or x['escaped'] for x in result['bounds']): problems.append(name + ': 가로 넘침')
            for width in ([1440] if args.phase == 'wide' else [360] if args.phase == 'narrow' else []):
                state['links'] = new_links()
                open_tab(width)
                page.get_by_text('외부 조사 도우미').wait_for()
                shot(f'tab-{width}-closed')
                page.get_by_text('지난 링크', exact=False).first.click()
                shot(f'tab-{width}-expanded')
                overflow(f'tab-{width}')
                open_issue()
                page.wait_for_function("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'", timeout=10000)
                measurements[f'issue-open-{width}'] = focus(page)
                if measurements[f'issue-open-{width}']['label'] != '대상 세션': problems.append(f'{width}: 발급 창 초점')
                shot(f'issue-{width}-empty')
                labels = page.evaluate("""() => {
                  const root = document.querySelector('.access-links-form');
                  const sender = root.querySelector('input[aria-label="발신자 이름"]').closest('label').querySelector('span');
                  return [root.querySelector('.access-links-field > label'), sender, root.querySelectorAll('.access-links-field > label')[1], root.querySelector('legend')].map(el => {
                    const s = getComputedStyle(el); return {text:el.textContent, fontSize:s.fontSize, lineHeight:s.lineHeight, color:s.color};
                  });
                }""")
                measurements[f'field-labels-{width}'] = labels
                if any((item['fontSize'], item['lineHeight'], item['color']) != (labels[1]['fontSize'], labels[1]['lineHeight'], labels[1]['color']) for item in labels): problems.append(f'{width}: 칸 이름 글자 불일치')
                choose(SESSIONS[0]['display_name'])
                shot(f'issue-{width}-selected')
                page.get_by_label('발신자 이름').fill('검수용 발신자')
                page.get_by_role('combobox', name='대상 세션').click()
                page.get_by_role('option', name='세션 ID 직접 입력').click()
                page.wait_for_function("() => document.activeElement?.getAttribute('aria-label') === '세션 ID'", timeout=10000)
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
                if width == 360: overflow('issue-360')
                for box in page.get_by_role('checkbox').all():
                    if box.is_checked(): box.click()
                page.get_by_text('하나 이상 고르세요.').wait_for()
                shot(f'issue-{width}-no-permissions')
                page.get_by_role('checkbox').first.click()
                state['issue'] = 201
                page.get_by_role('dialog').last.get_by_role('button', name='링크 만들기').click()
                page.locator('.owned-agents-token').wait_for()
                page.wait_for_timeout(150)
                measurements[f'url-focus-{width}'] = focus(page)
                if measurements[f'url-focus-{width}']['text'] != '복사': problems.append(f'{width}: 주소 창 초점')
                shot(f'url-{width}-before-copy')
                if width == 360: overflow('url-360')
                page.evaluate("() => { window.__reviewCopy = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = () => Promise.reject(new Error('fixture')); }")
                page.get_by_role('button', name='복사', exact=True).click()
                page.get_by_text('복사하지 못했습니다. 주소를 직접 골라 복사하세요.').wait_for()
                shot(f'url-{width}-copy-error')
                if page.get_by_role('button', name='복사', exact=True).count() != 1: problems.append(f'{width}: 복사 실패 후 단추')
                page.evaluate("() => { navigator.clipboard.writeText = window.__reviewCopy; }")
                page.get_by_role('button', name='복사', exact=True).click()
                page.get_by_role('button', name='복사됨').wait_for()
                shot(f'url-{width}-copied')
                page.get_by_role('dialog').last.get_by_role('button', name='닫기', exact=True).last.click()
                page.wait_for_function("() => document.activeElement?.textContent?.trim() === '링크 만들기' && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '설정'", timeout=10000)
                measurements[f'closed-focus-{width}'] = focus(page)
                if measurements[f'closed-focus-{width}']['text'] != '링크 만들기' or measurements[f'closed-focus-{width}']['dialogTitle'] != '설정': problems.append(f'{width}: 주소 창 닫은 뒤 초점')
                page.get_by_role('button', name='폐기', exact=True).first.click()
                page.wait_for_function("() => document.activeElement?.textContent?.trim() === '취소' && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '링크 폐기'", timeout=10000)
                measurements[f'revoke-open-{width}'] = focus(page)
                if measurements[f'revoke-open-{width}']['text'] != '취소': problems.append(f'{width}: 폐기 창 초점')
                shot(f'revoke-{width}')
                if width == 360: overflow('revoke-360')
                next_label = page.locator('.access-links-row').nth(1).locator('.access-links-label').inner_text()
                state['revoke'] = 503
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.get_by_text('지금은 폐기하지 못했습니다. 다시 시도하세요.').wait_for()
                shot(f'revoke-{width}-error')
                state['revoke'] = 200
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.wait_for_function("label => document.activeElement?.closest('.access-links-row')?.querySelector('.access-links-label')?.textContent?.trim() === label", arg=next_label, timeout=10000)
                measurements[f'revoked-focus-{width}'] = focus(page)
                if measurements[f'revoked-focus-{width}']['text'] != '폐기' or measurements[f'revoked-focus-{width}']['rowLabel'] != next_label: problems.append(f'{width}: 폐기 뒤 다음 행 초점')
                if not page.locator('details.config-advanced').evaluate('(element) => element.open'):
                    page.get_by_text('지난 링크', exact=False).first.click()
                page.get_by_text('검수용 발신자', exact=True).scroll_into_view_if_needed()
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
                for width in [360, 1440]:
                    page.get_by_role('combobox', name='대상 세션').click()
                    page.get_by_role('listbox').wait_for()
                    page.set_viewport_size({'width': width, 'height': 800 if width == 360 else 1000})
                    page.wait_for_function("""() => { const p = [...document.querySelectorAll('[role=listbox]')].find(e => e.getBoundingClientRect().width > 0); const t = document.querySelector('[aria-label="대상 세션"]'); if (!p || !t) return false; const r = p.getBoundingClientRect(), a = t.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && Math.abs(r.left - a.left) <= 2; }""", timeout=10000)
                    positions = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].at(-1).getBoundingClientRect();
                      const p = [...document.querySelectorAll('[role=listbox]')].find(e => e.getBoundingClientRect().width > 0).getBoundingClientRect(); const t = document.querySelector('[aria-label="대상 세션"]').getBoundingClientRect(); return {center: (d.left+d.right)/2, width: innerWidth, popupLeft:p.left, popupRight:p.right, triggerLeft:t.left}; }""")
                    measurements[f'resize-position-{width}'] = positions
                    if abs(positions['center'] - width / 2) > 2 or positions['popupLeft'] < -1 or positions['popupRight'] > width + 1 or abs(positions['popupLeft'] - positions['triggerLeft']) > 2: problems.append(f'{width}: 크기 변경 위치')
                    page.keyboard.press('Escape')
                    page.get_by_role('listbox').wait_for(state='hidden')
                tabs = []
                for _ in range(6): page.keyboard.press('Tab'); tabs.append(focus(page))
                measurements['tab-focus'] = tabs
                if not all(item['dialog'] for item in tabs): problems.append('Tab 초점이 열린 창 밖으로 이동')
                page.keyboard.press('Escape')
                page.get_by_text('새 접속 링크').wait_for(state='hidden')
                page.wait_for_function("() => document.activeElement?.textContent?.trim() === '링크 만들기' && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '설정'", timeout=10000)
                measurements['escape-focus'] = focus(page)
                if measurements['escape-focus']['text'] != '링크 만들기': problems.append('Esc 뒤 초점 복귀')
                page.get_by_role('button', name='폐기', exact=True).first.click()
                page.wait_for_timeout(300)
                page.get_by_role('dialog').last.get_by_role('button', name='취소').click()
                page.wait_for_function("() => document.activeElement?.textContent?.trim() === '폐기' && document.activeElement?.closest('.access-links-row')", timeout=10000)
                measurements['cancel-focus'] = focus(page)
                if measurements['cancel-focus']['text'] != '폐기': problems.append('폐기 취소 뒤 초점 복귀')
                page.get_by_role('button', name='폐기', exact=True).first.click()
                next_label = page.locator('.access-links-row').nth(1).locator('.access-links-label').inner_text()
                page.get_by_role('dialog').last.get_by_role('button', name='폐기', exact=True).click()
                page.wait_for_function("label => document.activeElement?.closest('.access-links-row')?.querySelector('.access-links-label')?.textContent?.trim() === label", arg=next_label, timeout=10000)
                measurements['revoke-complete-focus'] = focus(page)
                if measurements['revoke-complete-focus']['text'] != '폐기' or measurements['revoke-complete-focus']['rowLabel'] != next_label: problems.append('폐기 완료 뒤 다음 행 초점 복귀')
            if args.phase.startswith('details-'):
                width = 1440 if args.phase == 'details-wide' else 360
                for list_state in ['empty', 'error', 'loading']:
                    open_tab(width, list_state)
                    if list_state == 'loading': page.get_by_role('status', name='불러오는 중').wait_for()
                    elif list_state == 'empty': page.get_by_text('아직 만든 링크가 없습니다.').wait_for()
                    else: page.get_by_text('링크 목록을 불러오지 못했습니다.').wait_for()
                    shot(f'list-{list_state}-{width}')
                    measurements[f'list-{list_state}-{width}'] = 'visible'
                    if list_state == 'loading': page.get_by_role('status', name='불러오는 중').wait_for(state='hidden')
                state['links'] = [{**link, 'expires_at': iso(-1)} for link in new_links()]
                open_tab(width)
                page.get_by_text('쓸 수 있는 링크가 없습니다.').wait_for()
                page.get_by_text('지난 링크', exact=False).first.click()
                shot(f'past-only-{width}')
                measurements[f'past-only-{width}'] = 'visible'
                state['links'] = new_links()
                state['pas'] = 'error'; open_tab(width); open_issue()
                page.get_by_text('영구 세션 목록을 불러오지 못했습니다.').wait_for(); shot(f'pas-error-{width}')
                measurements[f'pas-error-{width}'] = 'visible'
                page.keyboard.press('Escape'); state['pas'] = 'ok'
                open_tab(width, extra='&pasDelay=1'); open_issue()
                page.get_by_text('불러오는 중…', exact=True).wait_for(); shot(f'pas-loading-{width}')
                measurements[f'pas-loading-{width}'] = 'visible'
                page.get_by_role('combobox', name='대상 세션').wait_for(state='visible')
                page.wait_for_timeout(4000)
                page.get_by_role('combobox', name='대상 세션').click(); page.get_by_role('listbox').wait_for(); shot(f'target-options-{width}')
                measurements[f'target-options-{width}'] = {'separators': page.locator('[role=listbox] [role=separator]').count()}
                if page.locator('[role=listbox] [role=separator]').count() < 1: problems.append(f'{width}: 대상 선택지 구분선 없음')
                if width == 360:
                    page.keyboard.press('Escape'); page.keyboard.press('Escape')
                    open_tab(360, height=640); open_issue()
                    for box in page.get_by_role('checkbox').all():
                        if not box.is_checked(): box.click()
                    page.locator('[data-slot=dialog-panel-scroll]').last.evaluate('(e) => e.scrollTop = e.scrollHeight')
                    shot('issue-360x640-bottom'); overflow('issue-360x640')
                    state['links'] = new_links(); state['links'][0]['label'] = '가' * 80
                    open_tab(360)
                    page.get_by_role('button', name='폐기', exact=True).first.click()
                    page.get_by_role('dialog').last.get_by_text('링크 폐기').wait_for()
                    page.wait_for_timeout(400)
                    shot('revoke-long-label-360'); overflow('revoke-long-label-360')
            if args.phase.startswith('keyboard-'):
                spec = importlib.util.spec_from_file_location('access_links_keyboard', Path(__file__).with_name('access_links_keyboard.py'))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                width = 1440 if args.phase == 'keyboard-wide' else 360
                module.run(page, width, state, new_links, open_tab, lambda: focus(page), shot, overflow, measurements, problems, args.output)
            browser.close()
    except Exception as exc:
        problems.append(f'실행 실패: {type(exc).__name__}')
        if 'page' in locals():
            try:
                page.screenshot(path=str(args.output / 'execution-error.png'))
                measurements['pageErrors'] = len(page_errors)
            except Exception:
                pass
    finally:
        if server:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
    keyboard_checks = sum(value.get('checks', 0) for key, value in measurements.items() if key.startswith('keyboard-') and isinstance(value, dict))
    report = {'mode': args.mode, 'phase': args.phase, 'fingerprint': fingerprint, 'result': 'pass' if not problems else 'fail', 'check_count': len(measurements) + keyboard_checks, 'measurements': measurements, 'problems': problems}
    (args.output / f'report-{args.phase}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    phases = [args.output / f'report-{phase}.json' for phase in ['wide', 'narrow', 'states', 'details-wide', 'details-narrow', 'keyboard-wide', 'keyboard-narrow']]
    parts = [json.loads(path.read_text(encoding='utf-8')) for path in phases if path.exists()]
    complete = len(parts) == len(phases) and all(part.get('fingerprint') == fingerprint for part in parts)
    combined = {'mode': args.mode, 'fingerprint': fingerprint, 'result': 'pass' if complete and all(part['result'] == 'pass' for part in parts) else 'fail',
                'check_count': sum(part.get('check_count', 0) for part in parts if part.get('fingerprint') == fingerprint), 'complete': complete, 'phases': parts}
    (args.output / 'report.json').write_text(json.dumps(combined, ensure_ascii=False, indent=2), encoding='utf-8')
    overall = combined['result']
    print(json.dumps({'result': overall, 'problems': problems}, ensure_ascii=False))
    return 1 if overall != 'pass' else 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""설정 창 「웹훅」 탭의 상태, 초점과 좁은 화면을 검수한다.

실행: python3 -P unified-dashboard/scripts/visual-check/webhooks_tab.py \
  http://127.0.0.1:5173 .local/card1458-webhooks-ui --mode after --phase wide

wide, narrow, states, details-wide, details-narrow, keyboard-wide, keyboard-narrow를
차례로 실행하면 종합 report.json을 만든다. 검수 창의 API는 page.route로 가로채며
키와 서명 비밀은 가짜 값만 쓴다. 서버가 필요하면 --serve를 더한다.
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

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = Path(__file__).resolve().parents[3]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED = load_module('webhooks_shared', 'webhooks_shared.py')
SESSIONS = SHARED.SESSIONS
LONG_LABEL = SHARED.LONG_SENDER

WORDS = '''root => { const out = []; const roots = root ? [document.querySelector(root)] : [...document.querySelectorAll('.webhooks, [role=dialog][data-open]')].slice(-1);
          for (const r of roots) { if (!r) continue; const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
            let n; while ((n = walker.nextNode())) { const el = n.parentElement; const s = getComputedStyle(el);
              if (s.whiteSpace === 'nowrap' || el.closest('.owned-agents-token, .webhooks-request-id, [aria-hidden=true]')) continue;
              const re = /\\S+/g; let m; while ((m = re.exec(n.textContent))) { if (/^https?:\\/\\//.test(m[0])) continue; const rg = document.createRange(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
                const tops = [...new Set([...rg.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top)))];
                if (tops.length > 1) out.push({word: m[0], cls: String(el.className).slice(0, 60), tag: el.tagName, text: n.textContent.slice(0, 60), wb: s.wordBreak}); } } }
          return out; }'''


def focus(page):
    return page.evaluate("""() => { const el = document.activeElement; const dialog = el?.closest('[role=dialog]');
      const text = el?.tagName === 'BODY' ? '' : (el?.textContent || '').trim();
      const name = el?.getAttribute('aria-label') || (el?.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || el?.closest('label')?.textContent?.trim() || text;
      const style = el && getComputedStyle(el); const parent = el?.parentElement && getComputedStyle(el.parentElement);
      return {tag: el?.tagName, role: el?.getAttribute('role'), name, label: el?.getAttribute('aria-label'), text: text.slice(0, 80),
        dialogTitle: dialog?.querySelector('[data-slot=dialog-title], h2')?.textContent?.trim() || null,
        rowLabel: el?.closest('.webhooks-row')?.querySelector('.access-links-label')?.textContent?.trim() || null,
        pressed: el?.getAttribute('aria-pressed') || null,
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
    inputs = [Path(__file__), Path(__file__).with_name('webhooks_keyboard.py'), Path(__file__).with_name('webhooks_shared.py'),
              ROOT / 'unified-dashboard/client/components/WebhooksTab.tsx',
              ROOT / 'unified-dashboard/client/components/InboundWebhooksSection.tsx',
              ROOT / 'unified-dashboard/client/components/OutboundWebhooksSection.tsx',
              ROOT / 'unified-dashboard/client/components/ConfigModal.tsx',
              ROOT / 'unified-dashboard/client/components/config/ConfigCategoryNav.tsx',
              ROOT / 'unified-dashboard/client/components/config/webhooks.css',
              ROOT / 'unified-dashboard/client/components/config/config-layout.css',
              ROOT / 'unified-dashboard/client/components/config/access-links.css',
              ROOT / 'unified-dashboard/client/components/config/owned-agents.css',
              ROOT / 'unified-dashboard/client/lib/webhooks-api.ts',
              ROOT / 'unified-dashboard/client/v3/webhooks-fixture.ts',
              ROOT / 'unified-dashboard/client/v3/dialogues-api.ts']
    fingerprint = hashlib.sha256(b''.join(path.read_bytes() for path in inputs)).hexdigest()
    server = None
    problems = []
    measurements = {}
    state = SHARED.initial_state()
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
                const url = String(args[0]);
                const method = args[1]?.method ?? 'GET';
                if (new URLSearchParams(location.search).has('webhooksDelay') && method === 'GET' &&
                    (url.endsWith('/api/webhooks/inbound') || url.endsWith('/api/webhooks/outbound'))) await new Promise(resolve => setTimeout(resolve, 2500));
                if (new URLSearchParams(location.search).has('pasDelay') && url.endsWith('/api/persistent-sessions')) await new Promise(resolve => setTimeout(resolve, 4000));
                if (new URLSearchParams(location.search).has('requestsDelay') && url.includes('/requests')) await new Promise(resolve => setTimeout(resolve, 2000));
                if (new URLSearchParams(location.search).has('deliveriesDelay') && url.includes('/deliveries')) await new Promise(resolve => setTimeout(resolve, 2000));
                if (new URLSearchParams(location.search).has('slowWrite') && ['POST', 'PATCH', 'DELETE'].includes(method)) await new Promise(resolve => setTimeout(resolve, 1500));
                return original(...args);
              };
            })()""")
            context.route('**/api/**', SHARED.make_route(state))
            context.route('**/api/auth/config', lambda route: route.fulfill(json={'authEnabled': True, 'devModeEnabled': False}))
            context.route('**/api/auth/status', lambda route: route.fulfill(json={'authenticated': True, 'user': {'email': 'qa@example.test', 'name': 'QA', 'isAdmin': True}}))
            context.route('**/api/health', lambda route: route.fulfill(json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'}))
            context.route('**/api/nodes', lambda route: route.fulfill(json={'nodes': [{'nodeId': 'eiaserinnys', 'status': 'connected', 'host': 'localhost', 'port': 3105, 'capabilities': {}, 'connectedAt': 0, 'sessionCount': 1}]}))
            context.route('**/api/nodes/stream', lambda route: route.fulfill(content_type='text/event-stream', body='event: snapshot\ndata: []\n\n'))
            page = context.new_page()
            page_errors = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))

            def shot(name):
                page.screenshot(path=str(args.output / f'{name}.png'), animations='disabled')

            def dialog():
                return page.get_by_role('dialog').last

            def wait_focus(expression, timeout=10000):
                page.wait_for_function(expression, timeout=timeout)
                page.wait_for_timeout(200)

            def record(name):
                value = focus(page)
                measurements[name] = value
                return value

            def expect_focus(name, *, label=None, text=None, title=None, row=None, pressed=None):
                value = record(name)
                for field, expected in [('label', label), ('text', text), ('dialogTitle', title), ('rowLabel', row), ('pressed', pressed)]:
                    if expected is not None and value[field] != expected:
                        problems.append(f'{name}: {field} 기대 {expected}, 실제 {value[field]}')
                return value

            def open_tab(width, extra='', height=None, wait='n8n 메일 요약'):
                page.set_viewport_size({'width': width, 'height': height or (800 if width == 360 else 1000)})
                for attempt in range(30):
                    try:
                        page.goto(args.base.rstrip('/') + '/dialogues?sample=settings&webhooksVisual=1' + extra, wait_until='domcontentloaded', timeout=3000)
                        break
                    except Exception:
                        if attempt == 29:
                            raise
                        time.sleep(1)
                try:
                    page.get_by_role('button', name='웹훅', exact=True).click(timeout=30000)
                except Exception:
                    page.screenshot(path=str(args.output / 'execution-error.png'))
                    measurements['pageErrors'] = len(page_errors)
                    measurements['pageUrl'] = page.url
                    raise
                page.get_by_role('button', name='웹훅 만들기', exact=True).wait_for()
                page.get_by_role('button', name='주소 등록', exact=True).wait_for()
                if wait:
                    page.get_by_text(wait, exact=False).first.wait_for()

            def overflow(name):
                result = page.evaluate("""() => {
                  const roots = [...document.querySelectorAll('.webhooks, [role=dialog][data-open]')];
                  const bounds = roots.map(root => {
                    const r = root.getBoundingClientRect();
                    const escaped = [...root.querySelectorAll('*')].filter(el => {
                      const s = getComputedStyle(el), b = el.getBoundingClientRect();
                      if (!b.width || !b.height || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
                      if (b.bottom <= r.top || b.top >= r.bottom || b.bottom <= 0 || b.top >= innerHeight) return false;
                      if (el.closest('[aria-hidden=true]') || s.position === 'fixed') return false;
                      const clipped = el.parentElement?.closest('[style*="overflow"], .truncate, .access-links-label, .webhooks-request-id');
                      if (clipped && clipped !== root) return false;
                      return b.left < r.left - 1 || b.right > r.right + 1;
                    }).map(el => ({tag:el.tagName, cls:String(el.className).slice(0,80), left:el.getBoundingClientRect().left, right:el.getBoundingClientRect().right}));
                    return {title:root.querySelector('[data-slot=dialog-title]')?.textContent || '웹훅', left:r.left, right:r.right, scroll:root.scrollWidth, client:root.clientWidth, escaped:escaped.slice(0,20)};
                  });
                  return {page:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth, bounds};
                }""")
                measurements[name] = result
                if result['page'] > result['viewport'] + 1 or any(x['scroll'] > x['client'] + 1 or x['escaped'] for x in result['bounds']):
                    problems.append(name + ': 가로 넘침')

            def check_words(name, root=None):
                split_words = page.evaluate(WORDS, root)
                measurements[name] = split_words
                if split_words:
                    problems.append(name + ': 낱말 가운데 줄바꿈')

            def choose(label, field='대상 세션'):
                page.get_by_role('combobox', name=field).click()
                page.get_by_role('option', name=label, exact=True).click()
                page.get_by_role('listbox').wait_for(state='hidden')

            def open_inbound_create():
                page.get_by_role('button', name='웹훅 만들기', exact=True).click()
                page.get_by_role('dialog').last.get_by_text('들어오는 웹훅 만들기').wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")

            def open_outbound_create():
                page.get_by_role('button', name='주소 등록', exact=True).click()
                page.get_by_role('dialog').last.get_by_text('나가는 웹훅 등록').wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")

            def fill_inbound(name='검수용 발신자', mode=None, duration=None):
                choose(SESSIONS[0]['display_name'])
                page.get_by_label('발신자 이름').fill(name)
                if mode:
                    choose(mode, '인증 방식')
                if duration:
                    choose(duration, '기간')

            def issue_inbound(submit='만들기'):
                page.get_by_role('dialog').last.get_by_role('button', name=submit, exact=True).click()

            def close_secret(next_button):
                dialog().get_by_role('button', name='닫기', exact=True).last.click()
                wait_focus(f"() => document.activeElement?.textContent?.trim() === {json.dumps(next_button)}")

            def open_row(label):
                page.locator('.webhooks-row').filter(has_text=label).first.click()
                page.get_by_role('dialog').last.wait_for()
                page.wait_for_timeout(300)

            def close_detail():
                dialog().get_by_role('button', name='닫기', exact=True).last.click()
                page.wait_for_function("""() => ![...document.querySelectorAll('[role=dialog][data-open]')].some(el => el.querySelector('[data-slot=dialog-title]')?.textContent?.trim() !== '설정')""", timeout=10000)
                page.wait_for_timeout(300)

            def fill_outbound(name='검수용 요약', url='https://push.example.net/hooks/review'):
                choose(SESSIONS[0]['display_name'])
                page.get_by_label('이름').fill(name)
                page.get_by_label('받을 주소').fill(url)

            def flow(width):
                state.update(SHARED.initial_state())
                open_tab(width)
                shot(f'tab-{width}-closed')
                if width == 360:
                    check_words(f'words-tab-{width}-closed', '.webhooks')
                page.get_by_text('지난 웹훅', exact=False).first.click()
                shot(f'tab-{width}-expanded')
                if width == 360:
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(200)
                    shot(f'tab-{width}-bottom')
                    overflow(f'tab-{width}')
                    check_words(f'words-tab-{width}-expanded', '.webhooks')

                open_inbound_create()
                expect_focus(f'inbound-create-focus-{width}', label='대상 세션', title='들어오는 웹훅 만들기')
                shot(f'inbound-create-{width}-empty')
                choose('세션 ID 직접 입력')
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '세션 ID'")
                page.get_by_label('세션 ID').fill('bad')
                page.get_by_label('세션 ID').blur()
                page.get_by_text('세션 ID 형식이 아닙니다.').wait_for()
                shot(f'inbound-create-{width}-id-invalid')
                page.get_by_label('세션 ID').fill(SESSIONS[0]['session_id'])
                page.get_by_label('발신자 이름').fill('검수용 발신자')
                choose('서명 (Standard Webhooks)', '인증 방식')
                choose('1년', '기간')
                page.get_by_text('앞에 붙일 글', exact=False).first.click()
                page.get_by_label('앞에 붙일 글').fill('외부에서 온 자료입니다.')
                shot(f'inbound-create-{width}-filled')
                if width == 360:
                    overflow(f'inbound-create-{width}')
                    check_words(f'words-inbound-create-{width}')

                state['inboundIssue'] = 404
                issue_inbound()
                page.get_by_text('이 세션을 찾지 못했거나 열 수 없습니다.').first.wait_for()
                shot(f'inbound-create-{width}-404')
                state['inboundIssue'] = 503
                issue_inbound()
                page.get_by_text('지금은 웹훅을 만들 수 없습니다.').wait_for()
                shot(f'inbound-create-{width}-503')
                state['inboundIssue'] = 201
                state['keyUrl'] = False
                issue_inbound()
                dialog().locator('.owned-agents-token').first.wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '서명 비밀 복사'")
                expect_focus(f'inbound-secret-focus-{width}', label='서명 비밀 복사', title='웹훅을 만들었습니다')
                shot(f'inbound-secret-{width}-signature')
                if width == 360:
                    overflow(f'inbound-secret-{width}')
                dialog().get_by_role('button', name='서명 비밀 복사').click()
                dialog().get_by_role('button', name='복사됨').wait_for()
                shot(f'inbound-secret-{width}-copied')
                close_secret('웹훅 만들기')
                expect_focus(f'inbound-secret-closed-{width}', text='웹훅 만들기', title='설정')

                open_inbound_create()
                fill_inbound(mode='키 (Authorization: Bearer)')
                state['keyUrl'] = True
                issue_inbound()
                dialog().locator('.owned-agents-token').first.wait_for()
                page.get_by_text('헤더 없이 보낼 주소').wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '키 복사'")
                shot(f'inbound-secret-{width}-key-url')
                if width == 360:
                    overflow(f'inbound-secret-{width}-key-url')
                close_secret('웹훅 만들기')

                open_inbound_create()
                fill_inbound()
                state['keyUrl'] = False
                issue_inbound()
                dialog().locator('.owned-agents-token').first.wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '키 복사'")
                shot(f'inbound-secret-{width}-key')
                close_secret('웹훅 만들기')

                open_row('n8n 메일 요약')
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '주소 복사'")
                expect_focus(f'inbound-detail-focus-{width}', label='주소 복사', title='n8n 메일 요약')
                for text in ['접수됨', '처리 중', '마감 없이 멈춤', '완료', '전달 실패']:
                    if not page.get_by_text(text, exact=True).first.is_visible():
                        problems.append(f'{width}: 요청 상태 {text} 없음')
                shot(f'inbound-detail-{width}')
                if width == 360:
                    overflow(f'inbound-detail-{width}')
                dialog().get_by_role('button', name='새로 고침').click()
                page.wait_for_timeout(300)
                shot(f'inbound-detail-{width}-refreshed')
                close_detail()

                open_row('지난 수집 웹훅')
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '새로 고침'")
                shot(f'inbound-detail-{width}-past')
                if width == 360:
                    overflow(f'inbound-detail-{width}-past')
                close_detail()

                open_row('n8n 메일 요약')
                dialog().get_by_role('button', name='폐기', exact=True).click()
                wait_focus("() => document.activeElement?.textContent?.trim() === '취소'")
                expect_focus(f'revoke-focus-{width}', text='취소', title='웹훅 폐기')
                shot(f'revoke-{width}')
                if width == 360:
                    overflow(f'revoke-{width}')
                dialog().get_by_role('button', name='취소').click()
                wait_focus("() => document.activeElement?.textContent?.trim() === '폐기'")
                next_label = SHARED.LONG_SENDER
                dialog().get_by_role('button', name='폐기', exact=True).click()
                wait_focus("() => document.activeElement?.textContent?.trim() === '취소'")
                dialog().get_by_role('button', name='폐기', exact=True).click()
                try:
                    page.wait_for_function("label => document.activeElement?.closest('.webhooks-row')?.querySelector('.access-links-label')?.textContent?.trim() === label", arg=next_label, timeout=15000)
                except PlaywrightTimeoutError:
                    measurements['revoke-debug'] = page.evaluate("""() => ({dialogs:[...document.querySelectorAll('[role=dialog]')].map(d => ({open:d.hasAttribute('data-open'), title:d.querySelector('[data-slot=dialog-title]')?.textContent})), focus: document.activeElement?.outerHTML?.slice(0,300), rows:[...document.querySelectorAll('.webhooks-row .access-links-label')].map(e => e.textContent)})""")
                    shot('revoke-debug')
                    raise
                expect_focus(f'revoked-focus-{width}', row=next_label)
                if not page.locator('details.config-advanced').first.evaluate('(element) => element.open'):
                    page.get_by_text('지난 웹훅', exact=False).first.click()
                shot(f'revoked-{width}')

                open_outbound_create()
                expect_focus(f'outbound-create-focus-{width}', label='대상 세션', title='나가는 웹훅 등록')
                boxes = page.get_by_role('checkbox').all()
                checked = [box.get_attribute('aria-checked') for box in boxes]
                measurements[f'outbound-create-events-{width}'] = checked
                if checked != ['true', 'true', 'true', 'false']:
                    problems.append(f'{width}: 처음 소식 선택 {checked}')
                shot(f'outbound-create-{width}-empty')
                fill_outbound()
                state['outboundCreate'] = 422
                state['challengeReason'] = 'timeout'
                dialog().get_by_role('button', name='등록', exact=True).click()
                page.get_by_text('주소가 10초 안에 답하지 않았습니다.').wait_for()
                shot(f'outbound-create-{width}-challenge')
                if width == 360:
                    overflow(f'outbound-create-{width}')
                state['outboundCreate'] = 403
                dialog().get_by_role('button', name='등록', exact=True).click()
                page.get_by_text('이 세션을 찾지 못했거나 열 수 없습니다.').first.wait_for()
                shot(f'outbound-create-{width}-403')
                state['outboundCreate'] = 201
                dialog().get_by_role('button', name='등록', exact=True).click()
                dialog().locator('.owned-agents-token').first.wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '서명 비밀 복사'")
                shot(f'outbound-secret-{width}')
                if width == 360:
                    overflow(f'outbound-secret-{width}')
                close_secret('주소 등록')
                expect_focus(f'outbound-secret-closed-{width}', text='주소 등록', title='설정')

                open_row('요약 받는 주소')
                wait_focus("() => document.activeElement?.textContent?.trim() === '전체'")
                expect_focus(f'outbound-detail-focus-{width}', text='전체', title='요약 받는 주소', pressed='true')
                shot(f'outbound-detail-{width}')
                if width == 360:
                    overflow(f'outbound-detail-{width}')
                dialog().get_by_role('button', name='실패', exact=True).click()
                page.wait_for_timeout(300)
                shot(f'outbound-detail-{width}-dead')
                state['redeliver'] = 'delivered'
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.wait_for_timeout(400)
                shot(f'outbound-detail-{width}-redelivered')
                state['patch'] = 503
                dialog().get_by_role('switch', name='소식 보내기').click()
                page.get_by_text('지금은 바꾸지 못했습니다. 다시 시도하세요.').wait_for()
                shot(f'outbound-detail-{width}-switch-error')
                state['patch'] = 200
                dialog().get_by_role('switch', name='소식 보내기').click()
                page.wait_for_function("() => document.querySelector('[role=dialog][data-open] [role=switch][aria-label=\"소식 보내기\"]')?.getAttribute('aria-checked') === 'false'", timeout=10000)
                shot(f'outbound-detail-{width}-off')
                dialog().get_by_role('switch', name='소식 보내기').click()
                page.wait_for_timeout(300)
                close_detail()

                open_row('꺼진 수집기')
                page.get_by_text('연속으로 20번 실패해 꺼졌습니다.').wait_for()
                if dialog().get_by_role('button', name='다시 보내기').count():
                    problems.append(f'{width}: 꺼진 구독에 다시 보내기 단추')
                shot(f'outbound-detail-{width}-disabled')
                close_detail()

                open_row('팀 알림')
                dialog().get_by_role('button', name='삭제', exact=True).click()
                wait_focus("() => document.activeElement?.textContent?.trim() === '취소'")
                expect_focus(f'delete-focus-{width}', text='취소', title='나가는 웹훅 삭제')
                shot(f'delete-{width}')
                if width == 360:
                    overflow(f'delete-{width}')
                dialog().get_by_role('button', name='삭제', exact=True).click()
                page.wait_for_function("() => document.activeElement?.closest('.webhooks-row')?.querySelector('.access-links-label')?.textContent?.trim() === '꺼진 수집기'", timeout=15000)
                expect_focus(f'deleted-focus-{width}', row='꺼진 수집기')
                shot(f'delete-{width}-done')

                open_row('요약 받는 주소')
                wait_focus("() => document.activeElement?.textContent?.trim() === '전체'")
                dialog().get_by_role('button', name='대기', exact=True).click()
                page.wait_for_timeout(300)
                next_width = 360 if width == 1440 else 1440
                page.set_viewport_size({'width': next_width, 'height': 800 if next_width == 360 else 1000})
                page.wait_for_timeout(300)
                pressed = page.evaluate("() => [...document.querySelectorAll('[role=dialog][data-open] [aria-pressed]')].filter(el => el.getAttribute('aria-pressed') === 'true').map(el => el.textContent.trim())")
                measurements[f'resize-{width}-to-{next_width}'] = {'pressed': pressed, 'focus': focus(page)}
                if pressed != ['대기']:
                    problems.append(f'{width}→{next_width}: 거름 유지 안 됨')
                shot(f'resize-{width}-to-{next_width}')
                overflow(f'resize-{width}-to-{next_width}')
                if next_width == 360:
                    check_words(f'words-resize-{width}-to-{next_width}')
                close_detail()

            if args.phase in ('wide', 'narrow'):
                flow(1440 if args.phase == 'wide' else 360)

            if args.phase == 'states':
                state.update(SHARED.initial_state())
                state['inboundList'] = 'error'
                open_tab(360, wait=None)
                page.get_by_text('웹훅 목록을 불러오지 못했습니다.').wait_for()
                if not page.get_by_text('요약 받는 주소').is_visible():
                    problems.append('states: 한쪽 목록 오류에 다른 쪽이 사라짐')
                shot('list-inbound-error-360')
                state['inboundList'] = 'normal'
                state['inbound'] = []
                state['outbound'] = []
                open_tab(360, wait='아직 만든 웹훅이 없습니다.')
                page.get_by_text('아직 등록한 주소가 없습니다.').wait_for()
                shot('list-empty-360')
                state.update(SHARED.initial_state())
                open_tab(360, extra='&webhooksDelay=1', wait=None)
                page.get_by_role('status', name='불러오는 중').first.wait_for()
                shot('list-loading-360')
                page.get_by_role('status', name='불러오는 중').first.wait_for(state='hidden', timeout=10000)
                state['outboundList'] = 'empty'
                open_tab(360, wait='아직 등록한 주소가 없습니다.')
                shot('list-outbound-empty-360')

            if args.phase.startswith('details-'):
                width = 1440 if args.phase == 'details-wide' else 360
                state.update(SHARED.initial_state())
                state['requestsState'] = 'empty'
                open_tab(width)
                open_row('n8n 메일 요약')
                page.get_by_text('아직 받은 요청이 없습니다.').wait_for()
                shot(f'requests-empty-{width}')
                close_detail()
                state['requestsState'] = 'error'
                open_row('n8n 메일 요약')
                page.get_by_text('요청 기록을 불러오지 못했습니다.').wait_for()
                shot(f'requests-error-{width}')
                close_detail()
                state['requestsState'] = 'normal'
                open_tab(width, extra='&requestsDelay=1')
                open_row('n8n 메일 요약')
                page.get_by_role('status', name='불러오는 중').last.wait_for()
                shot(f'requests-loading-{width}')
                page.get_by_role('status', name='불러오는 중').last.wait_for(state='hidden', timeout=10000)
                close_detail()
                state['deliveriesState'] = 'error'
                open_row('요약 받는 주소')
                page.get_by_text('전달 기록을 불러오지 못했습니다.').wait_for()
                shot(f'deliveries-error-{width}')
                close_detail()
                state['deliveriesState'] = 'normal'
                open_tab(width, extra='&deliveriesDelay=1')
                open_row('요약 받는 주소')
                page.get_by_role('status', name='불러오는 중').last.wait_for()
                shot(f'deliveries-loading-{width}')
                page.get_by_role('status', name='불러오는 중').last.wait_for(state='hidden', timeout=10000)
                close_detail()
                state['deliveries']['outbound-summary'] = []
                open_row('요약 받는 주소')
                page.get_by_text('아직 보낸 소식이 없습니다.').wait_for()
                shot(f'deliveries-empty-{width}')
                dialog().get_by_role('button', name='실패', exact=True).click()
                page.get_by_text('실패한 전달이 없습니다.').wait_for()
                shot(f'deliveries-empty-dead-{width}')
                dialog().get_by_role('button', name='대기', exact=True).click()
                page.get_by_text('기다리는 전달이 없습니다.').wait_for()
                shot(f'deliveries-empty-pending-{width}')
                close_detail()
                state['deliveries'] = SHARED.new_deliveries()
                state['redeliver'] = 'dead'
                open_row('요약 받는 주소')
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.get_by_text('다시 보냈지만 실패했습니다.').wait_for()
                shot(f'redeliver-dead-{width}')
                state['redeliver'] = 'skipped'
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.get_by_text('지금은 다시 보내지 못했습니다. 다시 시도하세요.').wait_for()
                shot(f'redeliver-skipped-{width}')
                state['redeliver'] = '409'
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.get_by_text('꺼진 상태에서는 다시 보낼 수 없습니다.').wait_for()
                shot(f'redeliver-409-{width}')
                close_detail()
                state['redeliver'] = 'retrying'
                state['deliveries'] = SHARED.new_deliveries()
                open_row('요약 받는 주소')
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.wait_for_function("() => [...document.querySelectorAll('[role=dialog][data-open] button')].every(button => button.textContent.trim() !== '보내는 중…')", timeout=15000)
                page.get_by_text('다음 시도', exact=False).first.wait_for()
                shot(f'redeliver-retrying-{width}')
                close_detail()
                state['patch'] = 503
                open_row('요약 받는 주소')
                dialog().get_by_role('switch', name='소식 보내기').click()
                try:
                    page.get_by_text('지금은 바꾸지 못했습니다. 다시 시도하세요.').wait_for(timeout=8000)
                except PlaywrightTimeoutError:
                    measurements['switch-debug'] = page.evaluate("""() => { const last=[...document.querySelectorAll('[role=dialog][data-open]')].pop();
                      return {text: last?.innerText?.slice(0, 700), switches: [...document.querySelectorAll('[role=switch]')].map(s => ({label: s.getAttribute('aria-label'), checked: s.getAttribute('aria-checked')})),
                        alerts: [...document.querySelectorAll('[role=alert]')].map(a => a.textContent), resources: performance.getEntriesByType('resource').map(r => r.name).filter(n => n.includes('/api/'))}; }""")
                    shot('switch-debug')
                    raise
                shot(f'switch-error-{width}')
                close_detail()
                state['patch'] = 200
                if width == 360:
                    open_row(LONG_LABEL)
                    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '주소 복사'")
                    shot('inbound-detail-long-360')
                    overflow('inbound-detail-long-360')
                    close_detail()

            if args.phase.startswith('keyboard-'):
                module = load_module('webhooks_keyboard', 'webhooks_keyboard.py')
                width = 1440 if args.phase == 'keyboard-wide' else 360
                module.run(page, width, state, SHARED, open_tab, lambda: focus(page), shot, overflow, measurements, problems, args.output, record, wait_focus, dialog, choose, open_row)

            measurements['pageErrors'] = len(page_errors)
            if page_errors:
                problems.append('페이지 오류: ' + page_errors[0][:120])
            browser.close()
    except Exception as exc:
        problems.append(f'실행 실패: {type(exc).__name__}: {exc}')
        if 'page' in locals():
            try:
                page.screenshot(path=str(args.output / 'execution-error.png'))
                measurements['pageErrors'] = len(page_errors)
            except Exception:
                pass
    finally:
        if server:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
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

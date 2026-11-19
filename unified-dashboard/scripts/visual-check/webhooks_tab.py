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

RECORD_TITLES = """() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
  return d ? [...d.querySelectorAll('.webhooks-record-title')].map(el => el.textContent.trim()) : []; }"""

DIALOG_TYPE = """() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop(); if (!d) return null;
  const probe = value => { const el = document.createElement('span'); el.style.color = `var(${value})`; document.body.appendChild(el); const color = getComputedStyle(el).color; el.remove(); return color; };
  const cs = el => el ? getComputedStyle(el) : null;
  const value = d.querySelector('.webhooks-value > .owned-agents-meta');
  const meta = d.querySelector('.owned-agents-block .owned-agents-meta, .owned-agents-key-row .owned-agents-meta');
  const status = d.querySelector('[role=status]');
  return {valueSize: cs(value)?.fontSize ?? null, valueColor: cs(value)?.color ?? null,
    metaSize: cs(meta)?.fontSize ?? null, metaColor: cs(meta)?.color ?? null,
    statusGap: status ? getComputedStyle(status).rowGap : null,
    muted: probe('--muted-foreground'),
    danger: probe('--destructive-foreground')}; }"""

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
                    // 행 단추는 시안 2절 1대로 좌우 8px 씩 밖으로 나가는 것이 정상이다. 그만큼만 scrollWidth 초과를 봐준다.
                    const bleed = Math.max(0, ...[...root.querySelectorAll('.webhooks-row')].map(el => el.getBoundingClientRect().right - r.right));
                    return {title:root.querySelector('[data-slot=dialog-title]')?.textContent || '웹훅', left:r.left, right:r.right, scroll:root.scrollWidth, client:root.clientWidth, bleed, overflowed:root.scrollWidth > root.clientWidth + 1 + bleed, escaped:escaped.slice(0,20)};
                  });
                  return {page:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth, bounds};
                }""")
                measurements[name] = result
                if result['page'] > result['viewport'] + 1 or any(x['overflowed'] or x['escaped'] for x in result['bounds']):
                    problems.append(name + ': 가로 넘침')

            def check_words(name, root=None):
                split_words = page.evaluate(WORDS, root)
                measurements[name] = split_words
                if split_words:
                    problems.append(name + ': 낱말 가운데 줄바꿈')

            def expect_dialog_type(name, *, value=False, meta=False, status=False):
                data = page.evaluate(DIALOG_TYPE)
                measurements[name] = data
                if value:
                    if data['valueSize'] != '14px' or data['valueColor'] != data['muted']:
                        problems.append(f'{name}: 값 행 이름이 14px 보조색이 아님')
                if meta:
                    if data['metaSize'] != '12px' or data['metaColor'] != data['muted']:
                        problems.append(f'{name}: 기록 둘째 줄이 12px 보조색이 아님')
                if status and data['statusGap'] != '16px':
                    problems.append(f'{name}: 뼈대 두 칸 사이가 16px이 아님')

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
                geom = page.evaluate("""() => {
                  const rect = el => { const b = el.getBoundingClientRect(); return {l: Math.round(b.left * 10) / 10, r: Math.round(b.right * 10) / 10}; };
                  const section = document.querySelector('.webhooks-section');
                  const block = section.querySelector('.owned-agents-block');
                  const row = block.querySelector('.webhooks-row');
                  return {block: rect(block), row: rect(row), chevron: rect(row.querySelector('.webhooks-chevron')),
                    create: rect(section.querySelector('.owned-agents-row button'))}; }""")
                measurements[f'row-geometry-{width}'] = geom
                if abs(geom['row']['l'] - (geom['block']['l'] - 8)) > 1 or abs(geom['row']['r'] - (geom['block']['r'] + 8)) > 1:
                    problems.append(f'{width}: 행 단추가 양쪽 8px 밖으로 나가지 않음')
                if abs(geom['chevron']['r'] - geom['create']['r']) > 1:
                    problems.append(f'{width}: 화살표 오른쪽 끝선이 만들기 단추 끝선과 다름')
                if width == 360:
                    check_words(f'words-tab-{width}-closed', '.webhooks')
                page.get_by_text('지난 웹훅', exact=False).first.click()
                shot(f'tab-{width}-expanded')
                if width == 360:
                    scrolled = page.evaluate("""() => {
                      const section = document.querySelectorAll('.webhooks-section')[1];
                      section.scrollIntoView({block: 'end'});
                      const moved = []; let el = section.parentElement;
                      while (el) { if (el.scrollTop) moved.push({cls: String(el.className).slice(0, 60), top: el.scrollTop}); el = el.parentElement; }
                      return moved; }""")
                    page.wait_for_timeout(300)
                    visible = page.locator('.webhooks-section').nth(1).evaluate("el => { const b = el.getBoundingClientRect(); return b.top >= -1 && b.bottom <= innerHeight + 1; }")
                    measurements[f'tab-{width}-bottom'] = {'scrolled': scrolled, 'visible': visible}
                    if not scrolled or not visible:
                        problems.append(f'{width}: 나가는 웹훅 목록까지 스크롤 칸을 내리지 못함')
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
                error_color = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const probe = value => { const el = document.createElement('span'); el.style.color = `var(${value})`; document.body.appendChild(el);
                    const color = getComputedStyle(el).color; el.remove(); return color; };
                  const alert = d.querySelector('small[role=alert]');
                  return {alert: alert ? getComputedStyle(alert).color : null, token: probe('--destructive-foreground')}; }""")
                measurements[f'inbound-error-color-{width}'] = error_color
                if error_color['alert'] != error_color['token']:
                    problems.append(f'{width}: 칸 아래 오류 색이 --destructive-foreground 와 다름')
                if width == 1440:
                    page.evaluate("() => document.documentElement.classList.add('dark')")
                    page.wait_for_timeout(150)
                    dark_color = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                      const probe = value => { const el = document.createElement('span'); el.style.color = `var(${value})`; document.body.appendChild(el);
                        const color = getComputedStyle(el).color; el.remove(); return color; };
                      const alert = d.querySelector('small[role=alert]');
                      return {alert: alert ? getComputedStyle(alert).color : null, token: probe('--destructive-foreground')}; }""")
                    measurements['inbound-error-color-dark'] = dark_color
                    if dark_color['alert'] != dark_color['token']:
                        problems.append('다크: 칸 아래 오류 색이 --destructive-foreground 와 다름')
                    shot('inbound-create-1440-id-invalid-dark')
                    page.evaluate("() => document.documentElement.classList.remove('dark')")
                    page.wait_for_timeout(150)
                page.get_by_label('세션 ID').fill(SESSIONS[0]['session_id'])
                page.get_by_label('발신자 이름').fill('검수용 발신자')
                choose('서명 (Standard Webhooks)', '인증 방식')
                choose('1년', '기간')
                page.get_by_text('앞에 붙일 글', exact=False).first.click()
                shot(f'inbound-create-{width}-preamble-empty')
                label_state = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const label = [...d.querySelectorAll('.config-advanced > label > span')].find(el => el.textContent.trim() === '앞에 붙일 글');
                  const box = label?.getBoundingClientRect();
                  return {found: Boolean(label), srOnly: Boolean(label?.classList.contains('sr-only')),
                    width: box?.width ?? null, height: box?.height ?? null,
                    textarea: Boolean(d.querySelector('textarea[aria-label="앞에 붙일 글"]'))}; }""")
                measurements[f'preamble-label-{width}'] = label_state
                if not (label_state['found'] and label_state['srOnly'] and (label_state['width'] or 0) <= 1 and label_state['textarea']):
                    problems.append(f'{width}: 앞에 붙일 글 칸 이름이 보이거나 접근 이름이 없음')
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
                expect_dialog_type(f'inbound-secret-type-{width}', value=True)
                shot(f'inbound-secret-{width}-signature')
                if width == 360:
                    overflow(f'inbound-secret-{width}')
                page.evaluate("() => { window.__reviewCopy = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = () => Promise.reject(new Error('fixture')); }")
                dialog().get_by_role('button', name='서명 비밀 복사').click()
                page.get_by_text('복사하지 못했습니다. 값을 직접 골라 복사하세요.').wait_for()
                shot(f'inbound-secret-{width}-copy-error')
                if width == 360:
                    overflow(f'inbound-secret-{width}-copy-error')
                page.evaluate("() => { navigator.clipboard.writeText = window.__reviewCopy; }")
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
                expect_dialog_type(f'inbound-detail-type-{width}', value=True, meta=True)
                detail_geom = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const rect = el => el?.getBoundingClientRect();
                  const headRow = d.querySelector('.webhooks-records-head')?.parentElement;
                  const refresh = headRow?.querySelector('button');
                  const title = d.querySelector('.webhooks-record-title');
                  const meta = title?.parentElement?.querySelector('.owned-agents-meta');
                  return {rightDiff: headRow && refresh ? rect(headRow).right - rect(refresh).right : null,
                    lineGap: title && meta ? rect(meta).top - rect(title).bottom : null}; }""")
                measurements[f'inbound-detail-geometry-{width}'] = detail_geom
                if detail_geom['rightDiff'] is None or abs(detail_geom['rightDiff']) > 1:
                    problems.append(f'{width}: 최근 요청 새로 고침이 오른쪽 끝선에 붙지 않음')
                if detail_geom['lineGap'] is None or abs(detail_geom['lineGap']) > 1:
                    problems.append(f'{width}: 요청 항목 두 줄 간격이 전달 항목과 다름')
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
                for box in page.get_by_role('checkbox').all():
                    if box.get_attribute('aria-checked') == 'true':
                        box.click()
                page.get_by_text('하나 이상 고르세요.').wait_for()
                shot(f'outbound-create-{width}-events-off')
                for box in page.get_by_role('checkbox').all()[:3]:
                    box.click()
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
                state['outboundCreate'] = 404
                dialog().get_by_role('button', name='등록', exact=True).click()
                page.wait_for_timeout(400)
                shot(f'outbound-create-{width}-404')
                state['outboundCreate'] = 201
                dialog().get_by_role('button', name='등록', exact=True).click()
                dialog().locator('.owned-agents-token').first.wait_for()
                wait_focus("() => document.activeElement?.getAttribute('aria-label') === '서명 비밀 복사'")
                expect_dialog_type(f'outbound-secret-type-{width}', value=True)
                shot(f'outbound-secret-{width}')
                if width == 360:
                    overflow(f'outbound-secret-{width}')
                close_secret('주소 등록')
                expect_focus(f'outbound-secret-closed-{width}', text='주소 등록', title='설정')

                open_row('요약 받는 주소')
                wait_focus("() => document.activeElement?.textContent?.trim() === '전체'")
                expect_focus(f'outbound-detail-focus-{width}', text='전체', title='요약 받는 주소', pressed='true')
                dialog().locator('.webhooks-record-title').first.wait_for()
                expect_dialog_type(f'outbound-detail-type-{width}', meta=True)
                outbound_geom = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const rect = el => el?.getBoundingClientRect();
                  const switchRow = d.querySelector('.webhooks-switch-name')?.parentElement;
                  const toggle = d.querySelector('[role=switch]');
                  const filterRow = d.querySelector('.webhooks-filter-row');
                  const refresh = filterRow?.querySelector('button[aria-label="새로 고침"]');
                  const title = d.querySelector('.webhooks-record-title');
                  const meta = title?.parentElement?.querySelector('.owned-agents-meta');
                  return {switchRightDiff: switchRow && toggle ? rect(switchRow).right - rect(toggle).right : null,
                    refreshRightDiff: filterRow && refresh ? rect(filterRow).right - rect(refresh).right : null,
                    lineGap: title && meta ? rect(meta).top - rect(title).bottom : null}; }""")
                measurements[f'outbound-detail-geometry-{width}'] = outbound_geom
                if outbound_geom['switchRightDiff'] is None or abs(outbound_geom['switchRightDiff']) > 1:
                    problems.append(f'{width}: 소식 보내기 스위치가 오른쪽 끝선에 붙지 않음')
                if outbound_geom['refreshRightDiff'] is None or abs(outbound_geom['refreshRightDiff']) > 1:
                    problems.append(f'{width}: 전달 기록 새로 고침이 오른쪽 끝선에 붙지 않음')
                if outbound_geom['lineGap'] is None or abs(outbound_geom['lineGap']) > 1:
                    problems.append(f'{width}: 전달 항목 두 줄 간격이 요청 항목과 다름')
                shot(f'outbound-detail-{width}')
                if width == 360:
                    overflow(f'outbound-detail-{width}')
                dialog().get_by_role('button', name='실패', exact=True).click()
                page.wait_for_function("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  return Boolean(d) && d.querySelectorAll('.webhooks-record-title').length === 2; }""", timeout=10000)
                dead_titles = page.evaluate(RECORD_TITLES)
                measurements[f'outbound-dead-rows-{width}'] = dead_titles
                if len(dead_titles) != 2 or any(not title.endswith('실패') for title in dead_titles):
                    problems.append(f'{width}: 실패 거름 목록이 2건이 아님: {dead_titles}')
                shot(f'outbound-detail-{width}-dead')
                state['redeliver'] = 'delivered'
                dialog().get_by_role('button', name='다시 보내기').first.click()
                page.wait_for_function("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  return Boolean(d) && d.querySelectorAll('.webhooks-record-title').length === 1; }""", timeout=15000)
                remaining = page.evaluate(RECORD_TITLES)
                measurements[f'outbound-redelivered-rows-{width}'] = remaining
                if remaining != ['답변실패']:
                    problems.append(f'{width}: 다시 보낸 건이 실패 거름에서 빠지지 않음: {remaining}')
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
                page.wait_for_function("() => document.querySelector('[role=dialog][data-open] [role=switch][aria-label=\"소식 보내기\"]')?.getAttribute('aria-checked') === 'true'", timeout=10000)
                page.wait_for_timeout(300)
                shot(f'outbound-detail-{width}-re-enabled')
                close_detail()

                open_row('꺼진 수집기')
                page.get_by_text('연속으로 20번 실패해 꺼졌습니다.').wait_for()
                if dialog().get_by_role('button', name='다시 보내기').count():
                    problems.append(f'{width}: 꺼진 구독에 다시 보내기 단추')
                keep = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const cs = el => el ? getComputedStyle(el) : null;
                  const reason = d.querySelector('p.webhooks-danger');
                  const hint = d.querySelector('.access-links-hint');
                  return {reasonBreak: cs(reason)?.wordBreak ?? null, hintBreak: cs(hint)?.wordBreak ?? null,
                    reasonSize: cs(reason)?.fontSize ?? null}; }""")
                measurements[f'outbound-disabled-keep-{width}'] = keep
                if keep['reasonBreak'] != 'keep-all' or keep['hintBreak'] != 'keep-all':
                    problems.append(f'{width}: 꺼진 사유와 안내 줄에 keep-all 이 걸리지 않음')
                if keep['reasonSize'] != '12px':
                    problems.append(f'{width}: 꺼진 사유 줄이 12px 메타가 아님')
                if width == 360:
                    check_words(f'words-outbound-detail-{width}-disabled')
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

                state['deliveries'] = SHARED.new_deliveries()
                open_row('요약 받는 주소')
                wait_focus("() => document.activeElement?.textContent?.trim() === '전체'")
                dialog().get_by_role('button', name='대기', exact=True).click()
                page.wait_for_function("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const rows = d ? [...d.querySelectorAll('.webhooks-record-title')] : [];
                  return rows.length === 1 && rows[0].textContent.includes('대기'); }""", timeout=10000)
                pending_rows = page.evaluate(RECORD_TITLES)
                measurements[f'pending-rows-{width}'] = pending_rows
                if len(pending_rows) != 1 or '대기' not in pending_rows[0]:
                    problems.append(f'{width}: 대기 거름 목록이 1건이 아님: {pending_rows}')
                next_width = 360 if width == 1440 else 1440
                page.set_viewport_size({'width': next_width, 'height': 800 if next_width == 360 else 1000})
                page.wait_for_timeout(300)
                pressed = page.evaluate("() => [...document.querySelectorAll('[role=dialog][data-open] [aria-pressed]')].filter(el => el.getAttribute('aria-pressed') === 'true').map(el => el.textContent.trim())")
                resized_rows = page.evaluate(RECORD_TITLES)
                measurements[f'resize-{width}-to-{next_width}'] = {'pressed': pressed, 'rows': resized_rows, 'focus': focus(page)}
                if pressed != ['대기']:
                    problems.append(f'{width}→{next_width}: 거름 유지 안 됨')
                if resized_rows != pending_rows:
                    problems.append(f'{width}→{next_width}: 거른 목록 내용이 바뀜: {resized_rows}')
                shot(f'resize-{width}-to-{next_width}')
                overflow(f'resize-{width}-to-{next_width}')
                if next_width == 360:
                    check_words(f'words-resize-{width}-to-{next_width}')
                close_detail()

            if args.phase in ('wide', 'narrow'):
                flow(1440 if args.phase == 'wide' else 360)

            if args.phase == 'states':
                for width in (1440, 360):
                    state.update(SHARED.initial_state())
                    state['inboundList'] = 'error'
                    open_tab(width, wait=None)
                    page.get_by_text('웹훅 목록을 불러오지 못했습니다.').wait_for()
                    if not page.get_by_text('요약 받는 주소').is_visible():
                        problems.append('states: 한쪽 목록 오류에 다른 쪽이 사라짐')
                    shot(f'list-inbound-error-{width}')
                    state['inboundList'] = 'normal'
                    state['inbound'] = []
                    state['outbound'] = []
                    open_tab(width, wait='아직 만든 웹훅이 없습니다.')
                    page.get_by_text('아직 등록한 주소가 없습니다.').wait_for()
                    shot(f'list-empty-{width}')
                    state.update(SHARED.initial_state())
                    open_tab(width, extra='&webhooksDelay=1', wait=None)
                    page.get_by_role('status', name='불러오는 중').first.wait_for()
                    shot(f'list-loading-{width}')
                    page.get_by_role('status', name='불러오는 중').first.wait_for(state='hidden', timeout=10000)
                    state['outboundList'] = 'empty'
                    open_tab(width, wait='아직 등록한 주소가 없습니다.')
                    shot(f'list-outbound-empty-{width}')

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
                expect_dialog_type(f'requests-loading-type-{width}', status=True)
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
                expect_dialog_type(f'deliveries-loading-type-{width}', status=True)
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
                notice = page.evaluate("""() => { const d = [...document.querySelectorAll('[role=dialog][data-open]')].pop();
                  const el = [...d.querySelectorAll('p.webhooks-danger')].find(item => item.textContent.includes('다시 보냈지만'));
                  const meta = el?.previousElementSibling; const style = el ? getComputedStyle(el) : null;
                  return {size: style?.fontSize ?? null, wordBreak: style?.wordBreak ?? null,
                    gap: el && meta ? el.getBoundingClientRect().top - meta.getBoundingClientRect().bottom : null}; }""")
                measurements[f'redeliver-dead-notice-{width}'] = notice
                if notice['size'] != '12px' or notice['wordBreak'] != 'keep-all':
                    problems.append(f'{width}: 다시 보내기 결과 줄이 12px keep-all 메타가 아님')
                if notice['gap'] is None or abs(notice['gap']) > 1:
                    problems.append(f'{width}: 다시 보내기 결과 줄이 둘째 줄 바로 아래에 붙지 않음')
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

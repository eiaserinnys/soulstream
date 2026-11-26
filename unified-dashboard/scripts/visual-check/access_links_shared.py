#!/usr/bin/env python3
"""설정 공용 부품의 변경 전후 화면을 기록한다."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
parser.add_argument('--mode', choices=['before', 'after'], required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'VITE_API_BASE': 'http://127.0.0.1:9'}
server = subprocess.Popen(['corepack', 'pnpm', '--dir', str(ROOT / 'unified-dashboard'), 'exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 360, 'height': 800})
        ctx.route('**/api/**', lambda r: r.fulfill(json={}))
        ctx.route('**/api/auth/config', lambda r: r.fulfill(json={'authEnabled': True, 'devModeEnabled': False}))
        ctx.route('**/api/auth/status', lambda r: r.fulfill(json={'authenticated': True, 'user': {'email': 'qa@example.test', 'name': 'QA', 'isAdmin': True}}))
        ctx.route('**/api/health', lambda r: r.fulfill(json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'}))
        ctx.route('**/api/nodes', lambda r: r.fulfill(json={'nodes': [{'nodeId': 'eiaserinnys', 'status': 'connected', 'host': 'localhost', 'port': 3105, 'capabilities': {}, 'connectedAt': 0, 'sessionCount': 1}]}))
        ctx.route('**/api/nodes/stream', lambda r: r.fulfill(content_type='text/event-stream', body='event: snapshot\ndata: []\n\n'))
        def slow_recurring_fixture(route):
            response = route.fetch()
            source = response.text()
            marker = 'record("반복 작업 실행");'
            assert source.count(marker) == 1, '반복 작업 검수 응답을 찾지 못했습니다'
            route.fulfill(response=response, body=source.replace(
                marker, f'await new Promise(resolve => setTimeout(resolve, 1500)); {marker}'))

        ctx.route('**/client/v3/dialogues-api.ts*', slow_recurring_fixture)
        page = ctx.new_page()
        def go(query):
            for attempt in range(30):
                try:
                    page.goto('http://127.0.0.1:5173/dialogues?sample=settings' + query, wait_until='domcontentloaded', timeout=3000)
                    return
                except Exception:
                    if attempt == 29: raise
                    time.sleep(1)
        go('')
        page.get_by_role('button', name='외부 에이전트', exact=True).click(timeout=30000)
        page.get_by_role('button', name='기존 연결 등록').click()
        page.get_by_role('button', name='새 키 발급').click()
        page.get_by_text('새 연결 키', exact=True).wait_for()
        page.wait_for_timeout(400)
        page.screenshot(path=str(args.output / f'shared-owned-key-{args.mode}.png'), animations='disabled')
        go('&persistentState=load-error')
        page.get_by_role('button', name='영구 에이전트 세션', exact=True).click(timeout=30000)
        page.get_by_role('alert').first.wait_for()
        page.screenshot(path=str(args.output / f'shared-persistent-alert-{args.mode}.png'), animations='disabled')
        go('')
        page.get_by_role('button', name='반복 작업', exact=True).click(timeout=30000)
        page.get_by_text('검수 반복 작업', exact=True).click()
        run = page.get_by_role('button', name='지금 실행', exact=True)
        run.press('Enter')
        page.wait_for_timeout(300)
        state = run.evaluate("""button => {
          const style = getComputedStyle(button);
          return {opacity: style.opacity, pointerEvents: style.pointerEvents, shadow: style.boxShadow,
                  focused: document.activeElement === button, disabled: button.getAttribute('aria-disabled')};
        }""")
        page.screenshot(path=str(args.output / f'shared-recurring-busy-{args.mode}.png'), animations='disabled')
        (args.output / f'report-shared-{args.mode}.json').write_text(json.dumps(state), encoding='utf-8')
        assert state['opacity'] == '0.64' and state['pointerEvents'] == 'none', state
        assert state['focused'] and state['disabled'] == 'true', state
        browser.close()
finally:
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired: server.kill(); server.wait()

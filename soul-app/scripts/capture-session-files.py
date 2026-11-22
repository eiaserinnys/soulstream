#!/usr/bin/env python3
"""세션 파일 검수 창의 장면과 키보드·크기 조작을 기록한다."""
import argparse
import json
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

PREFIX = '/assets/ios-components/'
BUNDLE = Path(os.environ.get('SESSION_FILES_BUNDLE', 'unified-dashboard/dist/assets/ios-components')).resolve()
TEXT = '// 노드 이벤트 아웃박스의 재전송 간격.\nexport const OUTBOX_RETRY_BASE_MS = 1_000;\n'


def server_for(root):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/api/auth/status':
                body, kind, status = b'{"authenticated":true}', 'application/json', 200
            elif path.endswith('/workspace'):
                file = {'path': 'soul-server-ts/src/upstream/event_outbox.ts', 'git_status': 'modified', 'orig_path': None,
                    'added': 42, 'deleted': 18, 'size': 1100, 'wrote': True, 'read': True, 'committed': False, 'last_activity_at': None}
                body = json.dumps({'session_id': 'public-chat-ui-flow', 'root': '/workspace/example', 'node': {'id': 'example', 'status': 'ok'},
                    'snapshot': {'state': 'ready', 'observed_at': '2026-11-22T06:12:00Z', 'refreshing': False, 'branch': 'example', 'head': None, 'upstream': None, 'ahead': 0, 'behind': 0, 'truncated': False},
                    'attribution': 'full', 'files': [file], 'read_only': [{'path': 'soul-server-ts/src/config.ts', 'size': None, 'last_read_at': None}]}).encode()
                kind, status = 'application/json', 200
            elif path.endswith('/workspace/file'):
                body, kind, status = TEXT.encode(), 'text/plain; charset=utf-8', 200
            elif path.startswith('/api/'):
                body, kind, status = b'{}', 'application/json', 200
            elif path.startswith(PREFIX):
                relative = path[len(PREFIX):] or 'index.html'
                file = (root / relative).resolve()
                if root not in file.parents or not file.is_file():
                    self.send_error(404)
                    return
                body, kind, status = file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream', 200
            else:
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def box(page, label):
    target = page.get_by_label(label, exact=True).first
    return target.bounding_box() if target.count() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    server = server_for(BUNDLE)
    baseline_path = os.environ.get('SESSION_FILES_BASELINE_BUNDLE')
    baseline = server_for(Path(baseline_path).resolve()) if baseline_path else None
    base = f'http://127.0.0.1:{server.server_port}{PREFIX}'
    result = {'scenes': {}, 'operations': {}, 'errors': []}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
            page.on('pageerror', lambda e: result['errors'].append(str(e)))
            def scene(name, query, width=390, height=844):
                page.set_viewport_size({'width': width, 'height': height})
                page.goto(base + '?' + query + '&theme=dark', wait_until='domcontentloaded')
                page.wait_for_timeout(1800)
                page.evaluate('document.fonts.ready')
                page.screenshot(path=str(out / (name + '.png')))
                result['scenes'][name] = {'width': width, 'height': height, 'overflow': page.evaluate('document.documentElement.scrollWidth > innerWidth')}
            scene('chat-header', 'section=chatUiRenderer')
            page.get_by_label('세션 파일', exact=True).first.wait_for(timeout=10000)
            result['chat_header'] = {'files': box(page, '세션 파일'), 'menu': box(page, '세션 메뉴'), 'back': box(page, '이전 패널로 돌아가기')}
            page.get_by_label('세션 파일', exact=True).first.click()
            page.get_by_label('event_outbox.ts', exact=True).first.wait_for(timeout=5000)
            result['operations']['entry_navigation'] = True
            if baseline:
                before = browser.new_page(viewport={'width': 390, 'height': 844})
                before.goto(f'http://127.0.0.1:{baseline.server_port}{PREFIX}?section=chatUiRenderer&theme=dark', wait_until='domcontentloaded')
                before.wait_for_timeout(1800)
                before.screenshot(path=str(out / 'chat-header-before.png'))
                result['chat_header_before'] = {'menu': box(before, '세션 메뉴'), 'back': box(before, '이전 패널로 돌아가기')}
                before.close()
            scene('files', 'section=sessionFiles')
            result['alignment'] = page.evaluate('''() => {
                const row = document.querySelector('[aria-label="config.ts"]');
                const text = [...document.querySelectorAll('*')].find(e => e.textContent === 'soul-server-ts/src');
                const r = row?.getBoundingClientRect(), d = text?.getBoundingClientRect();
                return {row: r && {x:r.x,y:r.y,width:r.width,height:r.height}, directory: d && {x:d.x,y:d.y,width:d.width,height:d.height}};
            }''')
            row = page.get_by_label('outbox_retry.ts', exact=True).first
            row.focus()
            row.click()
            page.get_by_text('outbox_retry.ts', exact=True).last.wait_for(timeout=5000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(out / 'preview.png'))
            result['operations']['14_open_focus'] = page.evaluate('document.activeElement?.outerHTML.slice(0,300)')
            page.keyboard.press('Tab')
            result['operations']['15_tab_focus'] = page.evaluate('document.activeElement?.outerHTML.slice(0,300)')
            page.keyboard.press('Escape')
            page.wait_for_timeout(300)
            result['operations']['15_escape_closed'] = page.locator('[data-testid="attachment-preview-modal"]').count() == 0
            result['operations']['14_return_focus'] = page.evaluate('document.activeElement?.outerHTML.slice(0,300)')
            scene('loading', 'section=sessionFiles&sample=loading')
            scene('offline', 'section=sessionFiles&sample=offline')
            scene('error', 'section=sessionFiles&sample=error')
            page.get_by_text('다시 시도', exact=True).first.click()
            page.get_by_label('config.ts', exact=True).first.wait_for(timeout=5000)
            result['operations']['17_retry'] = True
            scene('long-names', 'section=sessionFiles&sample=long', 360)
            result['operations']['16_overflow'] = page.evaluate('document.documentElement.scrollWidth > innerWidth')
            result['operations']['16_names'] = page.evaluate('''() => [...document.querySelectorAll('[aria-label*="아주-긴"]')].map(row => {
              const text = [...row.querySelectorAll('*')].find(e => e.textContent?.includes('아주-긴') && e.children.length === 0);
              const r = text?.getBoundingClientRect(); const s = text && getComputedStyle(text);
              return {width: r?.width, left: r?.left, right: r?.right, lines: text?.getClientRects().length,
                clipped: text ? text.scrollWidth > text.clientWidth : null, ellipsis: s?.textOverflow};
            })''')
            page.get_by_label('읽기만 한 파일', exact=True).first.click()
            page.get_by_label('dispatcher.ts', exact=True).first.wait_for()
            page.set_viewport_size({'width': 360, 'height': 500})
            page.locator('[data-testid="session-files-scroll"]').evaluate('(el) => { el.scrollTop = 120; }')
            scroll_before = page.locator('[data-testid="session-files-scroll"]').evaluate('(el) => el.scrollTop')
            page.set_viewport_size({'width': 900, 'height': 500})
            page.wait_for_timeout(300)
            result['operations']['18_wide_overflow'] = page.evaluate('document.documentElement.scrollWidth > innerWidth')
            scroll_after = page.locator('[data-testid="session-files-scroll"]').evaluate('(el) => el.scrollTop')
            result['operations']['18_scroll'] = {'before': scroll_before, 'after': scroll_after}
            page.set_viewport_size({'width': 360, 'height': 500})
            result['operations']['18_narrow_overflow'] = page.evaluate('document.documentElement.scrollWidth > innerWidth')
            result['operations']['18_expansion_preserved'] = page.get_by_label('dispatcher.ts', exact=True).count() == 1
            page.set_viewport_size({'width': 1024, 'height': 768})
            page.goto(base + '?section=chatUiRenderer&theme=dark', wait_until='domcontentloaded')
            page.get_by_label('세션 파일', exact=True).first.click(timeout=10000)
            page.get_by_label('event_outbox.ts', exact=True).first.wait_for(timeout=5000)
            page.screenshot(path=str(out / 'tablet.png'))
            result['scenes']['tablet'] = {'width': 1024, 'height': 768, 'overflow': page.evaluate('document.documentElement.scrollWidth > innerWidth')}
            browser.close()
    finally:
        server.shutdown()
        if baseline:
            baseline.shutdown()
        (out / 'measurements.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    if result['errors'] or any(scene['overflow'] for scene in result['scenes'].values()):
        raise SystemExit('화면 오류 또는 가로 넘침: measurements.json 확인')
    if not result['operations'].get('15_escape_closed') or not result['operations'].get('17_retry') or not result['operations'].get('18_expansion_preserved'):
        raise SystemExit('조작 검사 실패: measurements.json 확인')
    names = result['operations'].get('16_names', [])
    if not names or any(not name['width'] or name['left'] < 0 or name['right'] > 360 or name['lines'] != 1 or (name['clipped'] and name['ellipsis'] != 'ellipsis') for name in names):
        raise SystemExit('긴 이름 표시 실패: measurements.json 확인')
    scroll = result['operations']['18_scroll']
    if scroll['before'] <= 0 or abs(scroll['after'] - scroll['before']) > 1:
        raise SystemExit('창 크기 변경 후 스크롤 위치가 달라졌습니다')


if __name__ == '__main__':
    main()

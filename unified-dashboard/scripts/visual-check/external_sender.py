#!/usr/bin/env python3
"""Capture the external sender samples in the web and exported app review pages.

Run with a dashboard Vite server and a static server for unified-dashboard/dist:
  python3 -P unified-dashboard/scripts/visual-check/external_sender.py WEB APP OUTPUT
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('web')
    parser.add_argument('app')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    findings = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        page.route('**/api/**', lambda route: route.fulfill(json={}))
        page.route('**/api/auth/config', lambda route: route.fulfill(json={'authEnabled': True, 'devModeEnabled': False}))
        page.route('**/api/health', lambda route: route.fulfill(json={'healthy': True, 'ready': True, 'draining': False, 'build_id': 'dev'}))
        page.route('**/api/auth/status', lambda route: route.fulfill(json={'authenticated': True, 'user': {'email': 'review@example.invalid', 'name': '검수'}}))
        for platform, base in [('web', args.web), ('app', args.app)]:
            for presentation in ('default', 'manuscript'):
                for width in (360, 1440):
                    page.set_viewport_size({'width': width, 'height': 1000})
                    if platform == 'web':
                        url = f'{base}/components?sample=external-sender&presentation={presentation}'
                    else:
                        url = f'{base}/assets/ios-components/index.html?section=chat&sample=external-sender&presentation={presentation}'
                    page.goto(url, wait_until='load', timeout=30000)
                    sample = page.get_by_test_id(f'external-sender-{presentation}')
                    sample.wait_for(state='visible', timeout=30000)
                    page.evaluate('document.fonts.ready')
                    box = sample.bounding_box()
                    scroll = page.evaluate('() => ({x: window.scrollX, y: window.scrollY})')
                    left = max(scroll['x'], box['x'] - 16)
                    top = max(scroll['y'], box['y'] - 16)
                    right = min(scroll['x'] + width, box['x'] + box['width'] + 16)
                    bottom = min(scroll['y'] + 1000, box['y'] + box['height'] + 16)
                    page.screenshot(path=str(args.output / f'{platform}-{presentation}-{width}.png'),
                                    clip={'x': left, 'y': top, 'width': right - left, 'height': bottom - top})
                    info = sample.evaluate('el => ({width: el.clientWidth, scroll: el.scrollWidth, text: el.innerText})')
                    prefixes = sample.get_by_test_id('external-sender-prefix')
                    if prefixes.count() != 3:
                        findings.append(f'{platform} {presentation} {width}: sender prefixes missing')
                    sizes = [prefix.evaluate('el => ({height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight)})')
                             for prefix in prefixes.all()]
                    if any(size['height'] > size['line'] + 1 for size in sizes):
                        findings.append(f'{platform} {presentation} {width}: sender prefix wraps')
                    if platform == 'web' and presentation == 'manuscript':
                        icons = sample.locator('[data-testid="external-sender-caption"] svg')
                        if icons.count() != 3 or any(icon.bounding_box()['width'] < 14 for icon in icons.all()):
                            findings.append(f'{platform} {presentation} {width}: sender icon shrinks')
                    if info['scroll'] > info['width'] + 1:
                        findings.append(f'{platform} {presentation} {width}: horizontal overflow')
                    if '외부 연동' not in info['text'] or '웹훅에서' not in info['text']:
                        findings.append(f'{platform} {presentation} {width}: sample missing')
        browser.close()
    (args.output / 'report.json').write_text(json.dumps({'problems': findings}, ensure_ascii=False, indent=2), encoding='utf-8')
    if findings:
        print('\n'.join(findings))
        return 1
    print('외부 발신자 표본 8개 캡처 및 가로 넘침 검사 통과')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

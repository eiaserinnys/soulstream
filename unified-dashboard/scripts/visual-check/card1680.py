#!/usr/bin/env python3
"""카드 1680의 전후 화면과 조작을 기록한다.

저장소 루트: python3.11 -P unified-dashboard/scripts/visual-check/card1680.py
기준 커밋을 .local에 추출해 빌드하고 스크롤 전후 기록도 report.json에 합친다.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

root = Path(__file__).resolve().parents[3]
captures = root / '.local/card1680/captures'
base_dir = root / '.local/card1680/base/unified-dashboard'
review_dir = root / '.local/card1680/review-base/unified-dashboard'
env = {**os.environ, 'VITE_API_BASE': 'http://127.0.0.1:9', 'NODE_OPTIONS': '--dns-result-order=ipv4first'}
if not (base_dir / 'dist/index.html').exists():
    base_root = base_dir.parent
    base_root.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(['git', 'archive', 'fec55a862ef47073ada436f535464bba4f601c7e'], cwd=root, stdout=subprocess.PIPE)
    unpack = subprocess.run(['tar', '-x', '-C', str(base_root)], stdin=archive.stdout, check=False)
    archive.stdout.close()
    if archive.wait() or unpack.returncode:
        raise RuntimeError('기준 커밋 추출 실패')
    for source in [root / 'node_modules', root / 'unified-dashboard/node_modules', *root.glob('packages/*/node_modules')]:
        if source.exists():
            target = base_root / source.relative_to(root)
            target.symlink_to(source, target_is_directory=True)
    subprocess.run(['corepack', 'pnpm', '--dir', str(base_dir), 'build'], cwd=root, env=env, check=True)
if not (review_dir / 'dist/index.html').exists():
    review_root = review_dir.parent
    review_root.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(['git', 'archive', 'e906329e96cddec60c83b5f15360e025e9c57674'], cwd=root, stdout=subprocess.PIPE)
    unpack = subprocess.run(['tar', '-x', '-C', str(review_root)], stdin=archive.stdout, check=False)
    archive.stdout.close()
    if archive.wait() or unpack.returncode:
        raise RuntimeError('검수 반려 기준 커밋 추출 실패')
    for source in [root / 'node_modules', root / 'unified-dashboard/node_modules', *root.glob('packages/*/node_modules')]:
        if source.exists():
            (review_root / source.relative_to(root)).symlink_to(source, target_is_directory=True)
    subprocess.run(['corepack', 'pnpm', '--dir', str(review_dir), 'build'], cwd=root, env=env, check=True)
scroll_command = ['corepack', 'pnpm', '--dir', 'unified-dashboard', 'exec', 'playwright', 'test', '--config', 'playwright.card-home.config.ts', '--grep', 'card1680 실시간', '--output=../.local/card1680/scroll-results']
scroll_result = subprocess.run(scroll_command, cwd=root, env=env, check=False).returncode
server = subprocess.Popen(['corepack', 'pnpm', '--dir', str(base_dir), 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4194', '--strictPort'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for attempt in range(100):
        if server.poll() is not None:
            raise RuntimeError('기준 빌드 서버가 종료됨')
        try:
            with urllib.request.urlopen('http://127.0.0.1:4194/', timeout=1):
                break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('기준 빌드 서버 시작 시간 초과')
    results = {'scroll': scroll_result}
    for phase in ('before', 'after'):
        phase_env = {**env, 'CARD1680_VISUAL_PHASE': phase}
        if phase == 'before':
            phase_env['CARD1680_VISUAL_BASE'] = 'http://127.0.0.1:4194/'
        command = ['corepack', 'pnpm', '--dir', 'unified-dashboard', 'exec', 'playwright', 'test', '--config', 'playwright.card-home.config.ts', '--grep', 'visual1680 ', '--output=../.local/card1680/visual-results']
        results[phase] = subprocess.run(command, cwd=root, env=phase_env, check=False).returncode
    review_server = subprocess.Popen(['corepack', 'pnpm', '--dir', str(review_dir), 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4195', '--strictPort'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for attempt in range(100):
            if review_server.poll() is not None:
                raise RuntimeError('검수 반려 기준 서버가 종료됨')
            try:
                with urllib.request.urlopen('http://127.0.0.1:4195/', timeout=1):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('검수 반려 기준 서버 시작 시간 초과')
        for phase in ('review-before', 'review-after'):
            phase_env = {**env, 'CARD1680_VISUAL_PHASE': phase}
            if phase == 'review-before':
                phase_env['CARD1680_VISUAL_BASE'] = 'http://127.0.0.1:4195/'
            command = ['corepack', 'pnpm', '--dir', 'unified-dashboard', 'exec', 'playwright', 'test', '--config', 'playwright.card-home.config.ts', '--grep', 'visual1680-review', '--output=../.local/card1680/visual-review-results']
            results[phase] = subprocess.run(command, cwd=root, env=phase_env, check=False).returncode
    finally:
        review_server.terminate()
        review_server.wait(timeout=5)
    data = {}
    for phase in ('before', 'after', 'review-before', 'review-after'):
        folder = captures / phase
        data[phase] = {file.stem: json.loads(file.read_text(encoding='utf-8')) for file in sorted(folder.glob('*.json')) if file.stem not in ('report', 'measurements')}
    interaction = data['after'].get('interaction', {})
    errors = {mode: data['after'].get(f'error-{mode}', {}) for mode in ('list', 'folder', 'board')}
    report = {'commands': results, 'captures': data, 'checks': {
        '14_focus': interaction.get('openedFocus', {}).get('inside') is True and interaction.get('focusRestored') is True,
        '15_tab_escape': interaction.get('tab', {}).get('visible') is True and interaction.get('escapeClosed') is True,
        '16_minimum_width': bool(interaction.get('narrow')) and interaction['narrow']['scrollWidth'] <= interaction['narrow']['width'],
        '17_error_recovery': all(value.get('retryRecovered') is True and value.get('errorPrefix') is False for value in errors.values()),
        '18_resize': bool(interaction) and interaction.get('beforeScroll') == interaction.get('afterScroll') and interaction.get('value') == '완료',
    }}
    captures.mkdir(parents=True, exist_ok=True)
    (captures / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report['checks'], ensure_ascii=False))
    sys.exit(0 if all(code == 0 for code in results.values()) and all(report['checks'].values()) else 1)
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()

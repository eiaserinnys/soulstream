"""접속 링크를 키보드만으로 발급하고 폐기하는 검수 경로."""


def run(page, width, state, new_links, open_tab, focus, shot, overflow, measurements, problems, output):
    steps = []
    checks = 0
    measurements[f'keyboard-{width}'] = {'steps': steps, 'checks': checks}

    def key(value):
        page.keyboard.press(value)
        page.wait_for_timeout(100)

    def record(name, *, text=None, label=None, title=None, row=None, role=None, ring=True):
        nonlocal checks
        page.wait_for_timeout(150)
        value = focus()
        steps.append({'step': name, **value})
        for field, expected in [('text', text), ('label', label), ('dialogTitle', title), ('rowLabel', row), ('role', role)]:
            if expected is not None:
                checks += 1
                if value[field] != expected:
                    problems.append(f'{width} {name}: {field} 기대 {expected}, 실제 {value[field]}')
        if ring:
            checks += 1
            if not value['ring'] or not value['visible']:
                problems.append(f'{width} {name}: 초점 테두리 없음')
        measurements[f'keyboard-{width}']['checks'] = checks
        return value

    def await_focus(expression):
        page.wait_for_function(expression, timeout=10000)
        page.wait_for_timeout(200)

    def seek(text, limit=20):
        for _ in range(limit):
            if focus()['text'] == text:
                return
            key('Tab')
        raise AssertionError(f'키보드 순서에서 {text}를 찾지 못했습니다')

    def crop(index):
        box = page.locator(':focus').bounding_box()
        if not box:
            problems.append(f'{width} 목록 초점 {index}: 위치 없음')
            return
        clip = {'x': max(0, box['x'] - 5), 'y': max(0, box['y'] - 5),
                'width': min(width - max(0, box['x'] - 5), box['width'] + 10),
                'height': min(page.viewport_size['height'] - max(0, box['y'] - 5), box['height'] + 10)}
        page.screenshot(path=str(output / f'keyboard-{width}-focus-{index}.png'), clip=clip, animations='disabled')

    def timeline_start():
        page.evaluate("""() => { window.__focusTimeline = []; const start = performance.now();
          window.__focusTimer = setInterval(() => { const e = document.activeElement; window.__focusTimeline.push({ms:Math.round(performance.now()-start), tag:e?.tagName, text:(e?.textContent||'').trim()}); }, 50); }""")

    def timeline_end(name):
        nonlocal checks
        result = page.evaluate("() => { clearInterval(window.__focusTimer); return window.__focusTimeline; }")
        measurements[f'{name}-{width}'] = result
        checks += 1
        if len(result) < 3 or any(item['tag'] == 'BODY' for item in result):
            problems.append(f'{width} {name}: 대기 중 초점이 사라짐')

    state['links'] = new_links()
    state['pas'] = 'ok'
    open_tab(width, extra='&slowWrite=1')
    seek('링크 만들기')
    if width == 1440:
        labels = ['외부 조사 도우미', '요약 에이전트', new_links()[2]['label']]
        record('목록 만들기', text='링크 만들기', title='설정'); crop(0)
        for index, row in enumerate(labels, 1):
            key('Tab'); record(f'목록 폐기 {index}', text='폐기', row=row, title='설정'); crop(index)
        key('Tab'); value = record('지난 링크', title='설정'); crop(4)
        checks += 1
        if value['tag'] != 'SUMMARY': problems.append('1440: 지난 링크 초점 순서')
        key('Tab'); record('완료', text='완료', title='설정'); crop(5)
        for _ in range(5): key('Shift+Tab')
        record('목록 만들기 복귀', text='링크 만들기', title='설정')
    key('Enter')
    await_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    record('발급 열기', label='대상 세션', title='새 접속 링크', role='combobox')
    shot(f'keyboard-{width}-issue')
    page.evaluate("""() => { window.__keys = []; document.addEventListener('keydown', e => {
      if (['ArrowDown', 'Enter'].includes(e.key)) setTimeout(() => window.__keys.push({key:e.key, target:e.target?.outerHTML?.slice(0,300), active:document.activeElement?.outerHTML?.slice(0,300), prevented:e.defaultPrevented, selected:document.querySelector('[role=option][data-highlighted]')?.textContent}), 0);
    }); }""")
    key('ArrowDown'); page.get_by_role('listbox').wait_for()
    page.wait_for_function("() => document.activeElement?.getAttribute('role') === 'option'", timeout=10000)
    measurements[f'option-open-focus-{width}'] = focus()
    key('ArrowDown')
    highlighted = page.locator('[role=option][data-highlighted]')
    if not highlighted.count():
        key('ArrowDown')
    measurements[f'option-highlight-{width}'] = highlighted.first.text_content() if highlighted.count() else None
    measurements[f'option-before-enter-{width}'] = focus()
    key('Enter')
    measurements[f'option-key-events-{width}'] = page.evaluate('() => window.__keys')
    measurements[f'option-after-enter-{width}'] = focus()
    page.get_by_role('listbox').wait_for(state='hidden')
    page.wait_for_function("() => document.querySelector('[aria-label=\"대상 세션\"]')?.textContent?.trim() !== '세션을 고르세요'", timeout=10000)
    await_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    value = record('세션 선택', label='대상 세션', title='새 접속 링크', role='combobox')
    checks += 1
    if value['text'] == '세션을 고르세요': problems.append(f'{width}: 세션 선택값이 바뀌지 않음')
    key('ArrowDown'); page.get_by_role('listbox').wait_for(); page.wait_for_timeout(300); key('Escape')
    page.get_by_role('listbox').wait_for(state='hidden')
    await_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    record('목록 Esc', label='대상 세션', title='새 접속 링크', role='combobox')
    checks += 1
    if page.locator('[role=listbox]:visible').count(): problems.append(f'{width}: Esc 뒤 목록이 남음')
    key('ArrowDown'); page.get_by_role('listbox').wait_for(); page.wait_for_timeout(300)
    for _ in range(9): key('ArrowDown')
    key('Enter')
    page.get_by_role('listbox').wait_for(state='hidden')
    await_focus("() => document.activeElement?.getAttribute('aria-label') === '세션 ID'")
    record('직접 입력', label='세션 ID', title='새 접속 링크')
    page.keyboard.type('00000000-0000-4000-8000-000000000001', delay=10)
    key('Tab'); record('발신자 이름', label='발신자 이름', title='새 접속 링크')
    page.keyboard.type('keyboard-review', delay=10)
    key('Tab'); record('기간', label='기간', title='새 접속 링크', role='combobox')
    for index in range(4):
        key('Tab'); value = record(f'권한 {index+1}', title='새 접속 링크', role='checkbox')
        checks += 1
        if not value['name'].startswith(['메시지 보내기', '답 읽기', '대화 전체 읽기', '세션 멈추기'][index]):
            problems.append(f'{width}: 권한 {index+1} 이름과 순서')
        if index >= 2: key('Space')
    key('Tab'); record('발급 취소', text='취소', title='새 접속 링크')
    key('Tab'); record('발급 실행', text='링크 만들기', title='새 접속 링크')
    timeline_start(); key('Enter')
    await_focus("() => document.activeElement?.textContent?.trim() === '복사'")
    timeline_end('issue-busy')
    record('주소 복사', text='복사', title='링크를 만들었습니다')
    if width == 360: overflow('keyboard-url-360')
    shot(f'keyboard-{width}-url')
    key('Enter'); record('복사됨', text='복사됨', title='링크를 만들었습니다')
    page.evaluate("""() => { window.__closeTitles = []; window.__closeTimer = setInterval(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(e => e.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '링크를 만들었습니다');
      if (d) window.__closeTitles.push(d.querySelector('[data-slot=dialog-title]')?.textContent?.trim());
      else if ([...document.querySelectorAll('[role=dialog]')].some(e => e.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '새 접속 링크')) window.__closeTitles.push('새 접속 링크');
    }, 50); }""")
    key('Escape')
    await_focus("() => document.activeElement?.textContent?.trim() === '링크 만들기' && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '설정'")
    titles = page.evaluate('() => { clearInterval(window.__closeTimer); return window.__closeTitles; }')
    measurements[f'close-titles-{width}'] = titles
    checks += 1
    if not titles or any(title != '링크를 만들었습니다' for title in titles): problems.append(f'{width}: 닫는 동안 주소 창 제목 변경')
    record('주소 닫기', text='링크 만들기', title='설정')
    key('Tab'); first = record('첫 행 폐기', text='폐기', title='설정')
    first_row = first['rowLabel']
    key('Enter'); await_focus("() => document.activeElement?.textContent?.trim() === '취소'")
    record('폐기 열기', text='취소', title='링크 폐기')
    if width == 360: overflow('keyboard-revoke-360')
    shot(f'keyboard-{width}-revoke')
    key('Escape'); await_focus("() => document.activeElement?.textContent?.trim() === '폐기' && document.activeElement?.closest('.access-links-row')")
    record('폐기 취소', text='폐기', title='설정', row=first_row)
    if width == 1440:
        next_label = page.locator('.access-links-row').nth(1).locator('.access-links-label').inner_text()
        key('Enter'); await_focus("() => document.activeElement?.textContent?.trim() === '취소'")
        key('Tab'); record('폐기 실행', text='폐기', title='링크 폐기')
        timeline_start(); key('Enter')
        page.wait_for_function("label => document.activeElement?.closest('.access-links-row')?.querySelector('.access-links-label')?.textContent?.trim() === label", arg=next_label, timeout=15000)
        timeline_end('revoke-busy')
        record('폐기 뒤 다음 행', text='폐기', title='설정', row=next_label)
        for scenario, count in [('last', 2), ('only', 1)]:
            state['links'] = new_links()[:count]
            open_tab(width, extra='&slowWrite=1'); seek('링크 만들기')
            for _ in range(count): key('Tab')
            target = record(f'{scenario} 대상', text='폐기', title='설정')
            previous = new_links()[0]['label'] if count == 2 else None
            key('Enter'); await_focus("() => document.activeElement?.textContent?.trim() === '취소'")
            key('Tab'); key('Enter')
            expected = '폐기' if count == 2 else '링크 만들기'
            page.wait_for_function("value => document.activeElement?.textContent?.trim() === value && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '설정'", arg=expected, timeout=15000)
            record(f'{scenario} 완료', text=expected, title='설정', row=previous)
    measurements[f'keyboard-{width}'] = {'steps': steps, 'checks': checks}

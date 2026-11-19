"""웹훅 탭을 키보드만으로 만들기, 상세, 다시 보내기, 끄기, 삭제까지 도는 검수 경로."""


def run(page, width, state, shared, open_tab, focus, shot, overflow, measurements, problems, output, record_measurement, wait_focus, dialog, choose, open_row):
    steps = []
    checks = 0
    measurements[f'keyboard-{width}'] = {'steps': steps, 'checks': checks}

    def key(value):
        page.keyboard.press(value)
        page.wait_for_timeout(120)

    def record(name, *, text=None, label=None, title=None, row=None, role=None, tag=None, pressed=None, ring=True):
        nonlocal checks
        page.wait_for_timeout(150)
        value = focus()
        steps.append({'step': name, **value})
        for field, expected in [('text', text), ('label', label), ('dialogTitle', title), ('rowLabel', row), ('role', role), ('tag', tag), ('pressed', pressed)]:
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

    def seek(predicate, limit=25):
        for _ in range(limit):
            if predicate(focus()):
                return focus()
            key('Tab')
        raise AssertionError(f'키보드 순서에서 초점을 찾지 못했습니다: {focus()}')

    def submit_and_check_busy(name, title, expected):
        nonlocal checks
        page.keyboard.press('Enter')
        page.wait_for_timeout(350)
        buttons = page.get_by_role('dialog', name=title, exact=True).locator('[data-slot=dialog-footer] button')
        result = buttons.evaluate_all("""buttons => buttons.map(button => ({
          text: button.textContent.trim(), opacity: getComputedStyle(button).opacity,
          focused: document.activeElement === button,
        }))""")
        measurements[f'{name}-footer-{width}'] = result
        checks += 1
        if result != [{'text': '취소', 'opacity': '0.64', 'focused': False},
                      {'text': expected, 'opacity': '0.64', 'focused': True}]:
            problems.append(f'{width} {name}: 대기 중 단추 흐림 또는 초점 불일치')
        shot(f'{name}-footer-{width}')

    state.update(shared.initial_state())
    state['redeliver'] = 'dead'
    open_tab(width, extra='&slowWrite=1')
    start = seek(lambda value: value['text'] == '웹훅 만들기')
    record('구역 만들기', text='웹훅 만들기', title='설정')
    key('Tab'); record('들어오는 첫 행', row='n8n 메일 요약', title='설정')
    key('Tab'); record('들어오는 둘째 행', row=shared.LONG_SENDER, title='설정')
    key('Tab')
    value = record('지난 웹훅 머리', title='설정')
    if value['tag'] != 'SUMMARY':
        problems.append(f'{width}: 지난 웹훅 머리 초점 순서')
    key('Tab'); record('주소 등록', text='주소 등록', title='설정')
    key('Tab'); record('나가는 첫 행', row='요약 받는 주소', title='설정')
    key('Tab'); record('나가는 둘째 행', row='팀 알림', title='설정')
    key('Tab'); record('나가는 꺼진 행', row='꺼진 수집기', title='설정')
    key('Tab'); record('완료', text='완료', title='설정')
    for _ in range(8):
        key('Shift+Tab')
    record('만들기로 복귀', text='웹훅 만들기', title='설정')

    key('Enter')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    record('만들기 열기', label='대상 세션', title='들어오는 웹훅 만들기', role='combobox')
    key('ArrowDown')
    page.get_by_role('listbox').wait_for()
    page.wait_for_timeout(800)
    key('Escape')
    page.get_by_role('listbox').wait_for(state='hidden')
    page.wait_for_timeout(800)
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    record('선택 목록 Esc', label='대상 세션', title='들어오는 웹훅 만들기', role='combobox')
    key('ArrowDown')
    page.get_by_role('listbox').wait_for()
    page.wait_for_function("() => document.activeElement?.closest('[role=listbox]') !== null", timeout=10000)
    key('Enter')
    page.get_by_role('listbox').wait_for(state='hidden')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    page.wait_for_function("() => document.querySelector('[aria-label=\"대상 세션\"]')?.textContent?.trim() !== '세션을 고르세요'", timeout=10000)
    key('Tab'); record('발신자 이름', label='발신자 이름', title='들어오는 웹훅 만들기')
    page.keyboard.type('keyboard-review', delay=10)
    key('Tab'); record('인증 방식', label='인증 방식', title='들어오는 웹훅 만들기', role='combobox')
    key('Tab'); record('기간', label='기간', title='들어오는 웹훅 만들기', role='combobox')
    key('Tab'); record('앞에 붙일 글', title='들어오는 웹훅 만들기')
    key('Tab'); record('만들기 취소', text='취소', title='들어오는 웹훅 만들기')
    key('Tab'); record('만들기 실행', text='만들기', title='들어오는 웹훅 만들기')
    submit_and_check_busy('inbound-create-busy', '들어오는 웹훅 만들기', '만드는 중…')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '키 복사'")
    record('키 복사', label='키 복사', title='웹훅을 만들었습니다')
    shot(f'keyboard-{width}-secret')
    key('Enter'); record('복사됨', label='복사됨', title='웹훅을 만들었습니다')
    key('Escape')
    wait_focus("() => document.activeElement?.textContent?.trim() === '웹훅 만들기' && document.activeElement?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim() === '설정'")
    record('비밀 닫기', text='웹훅 만들기', title='설정')

    key('Tab'); record('만든 들어오는 행', row='keyboard-review', title='설정')
    key('Tab'); key('Enter')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '주소 복사'")
    record('상세 열기', label='주소 복사', title='n8n 메일 요약')
    key('Tab'); record('상세 새로 고침', label='새로 고침', title='n8n 메일 요약')
    key('Tab'); record('상세 폐기', text='폐기', title='n8n 메일 요약')
    key('Enter')
    wait_focus("() => document.activeElement?.textContent?.trim() === '취소'")
    record('폐기 확인', text='취소', title='웹훅 폐기')
    key('Tab'); record('폐기 실행', text='폐기', title='웹훅 폐기')
    submit_and_check_busy('inbound-revoke-busy', '웹훅 폐기', '폐기 중…')
    next_label = shared.new_inbound()[1]['label']
    page.wait_for_function("label => document.activeElement?.closest('.webhooks-row')?.querySelector('.access-links-label')?.textContent?.trim() === label", arg=next_label, timeout=15000)
    record('폐기 뒤 다음 행', row=next_label, title='설정')

    key('Tab'); key('Tab'); key('Enter')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    record('등록 열기', label='대상 세션', title='나가는 웹훅 등록', role='combobox')
    key('ArrowDown')
    page.get_by_role('listbox').wait_for()
    page.wait_for_function("() => document.activeElement?.closest('[role=listbox]') !== null", timeout=10000)
    key('Enter')
    page.get_by_role('listbox').wait_for(state='hidden')
    page.wait_for_timeout(800)
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '대상 세션'")
    page.wait_for_function("() => { const dialog = [...document.querySelectorAll('[role=dialog][data-open]')].pop(); return dialog !== undefined && dialog.querySelector('[aria-label=\"대상 세션\"]')?.textContent?.trim() !== '세션을 고르세요'; }", timeout=10000)
    key('Tab'); record('등록 이름', label='이름', title='나가는 웹훅 등록')
    page.keyboard.type('keyboard-summary', delay=10)
    key('Tab'); record('등록 주소', label='받을 주소', title='나가는 웹훅 등록')
    page.keyboard.type('https://push.example.net/hooks/keyboard', delay=5)
    measurements[f'outbound-form-{width}'] = page.evaluate("""() => ({target: document.querySelector('[aria-label="대상 세션"]')?.textContent?.trim(),
      name: document.querySelector('[aria-label="이름"]')?.value, url: document.querySelector('[aria-label="받을 주소"]')?.value,
      events: [...document.querySelectorAll('[role=checkbox]')].map(e => e.getAttribute('aria-checked')),
      submit: [...document.querySelectorAll('[role=dialog][data-open] [data-slot=dialog-footer] button')].map(b => ({text: b.textContent.trim(), disabled: b.disabled}))})""")
    for index in range(4):
        key('Tab')
        value = record(f'소식 {index + 1}', title='나가는 웹훅 등록', role='checkbox')
        if not value['name'].startswith(['답변', '질문', '세션 실패', '세션 끝남'][index]):
            problems.append(f'{width}: 소식 {index + 1} 이름과 순서')
    key('Tab'); record('등록 취소', text='취소', title='나가는 웹훅 등록')
    key('Tab'); record('등록 실행', text='등록', title='나가는 웹훅 등록')
    submit_and_check_busy('outbound-create-busy', '나가는 웹훅 등록', '확인하는 중…')
    wait_focus("() => document.activeElement?.getAttribute('aria-label') === '서명 비밀 복사'")
    record('서명 비밀 복사', label='서명 비밀 복사', title='주소를 등록했습니다')
    shot(f'keyboard-{width}-signing-secret')
    key('Escape')
    wait_focus("() => document.activeElement?.textContent?.trim() === '주소 등록'")
    record('서명 닫기', text='주소 등록', title='설정')

    key('Tab'); record('만든 나가는 행', row='keyboard-summary', title='설정')
    key('Tab'); key('Enter')
    wait_focus("() => document.activeElement?.textContent?.trim() === '전체'")
    record('거름 전체', text='전체', title='요약 받는 주소', pressed='true')
    key('Tab'); record('거름 실패', text='실패', title='요약 받는 주소')
    key('Tab'); record('거름 대기', text='대기', title='요약 받는 주소')
    key('Tab'); record('전달 새로 고침', label='새로 고침', title='요약 받는 주소')
    key('Tab'); record('다시 보내기', text='다시 보내기', title='요약 받는 주소')
    page.keyboard.press('Enter')
    page.wait_for_timeout(350)
    result = page.evaluate("""() => { const el = document.activeElement; const s = getComputedStyle(el);
      return {text: el?.textContent?.trim(), opacity: s.opacity, disabled: el?.getAttribute('aria-disabled'), focused: el?.closest('[role=dialog]')?.querySelector('[data-slot=dialog-title]')?.textContent?.trim()}; }""")
    measurements[f'redeliver-busy-{width}'] = result
    checks += 1
    if result['text'] != '보내는 중…' or result['opacity'] != '0.64' or result['disabled'] != 'true':
        problems.append(f'{width}: 다시 보내기 대기 표시 불일치 {result}')
    shot(f'keyboard-{width}-redeliver-busy')
    page.get_by_text('다시 보냈지만 실패했습니다.').wait_for(timeout=15000)
    wait_focus("() => document.activeElement?.textContent?.trim() === '다시 보내기'")
    record('다시 보내기 뒤', text='다시 보내기', title='요약 받는 주소')
    for _ in range(5):
        key('Shift+Tab')
    value = record('소식 보내기 스위치', role='switch', label='소식 보내기', title='요약 받는 주소')
    key('Space')
    page.wait_for_function("() => document.querySelector('[role=dialog][data-open] [role=switch][aria-label=\"소식 보내기\"]')?.getAttribute('aria-checked') === 'false'", timeout=10000)
    measurements[f'switch-off-{width}'] = focus()
    key('Space')
    page.wait_for_function("() => document.querySelector('[role=dialog][data-open] [role=switch][aria-label=\"소식 보내기\"]')?.getAttribute('aria-checked') === 'true'", timeout=10000)
    for _ in range(5):
        key('Tab')
    record('다시 보내기로 복귀', text='다시 보내기', title='요약 받는 주소')
    key('Tab'); record('둘째 다시 보내기', text='다시 보내기', title='요약 받는 주소')
    key('Tab'); record('셋째 다시 보내기', text='다시 보내기', title='요약 받는 주소')
    key('Tab'); record('상세 삭제', text='삭제', title='요약 받는 주소')
    key('Enter')
    wait_focus("() => document.activeElement?.textContent?.trim() === '취소'")
    record('삭제 확인', text='취소', title='나가는 웹훅 삭제')
    key('Tab'); record('삭제 실행', text='삭제', title='나가는 웹훅 삭제')
    submit_and_check_busy('outbound-delete-busy', '나가는 웹훅 삭제', '삭제 중…')
    page.wait_for_function("() => document.activeElement?.closest('.webhooks-row')?.querySelector('.access-links-label')?.textContent?.trim() === '팀 알림'", timeout=15000)
    record('삭제 뒤 다음 행', row='팀 알림', title='설정')
    shot(f'keyboard-{width}-done')
    measurements[f'keyboard-{width}'] = {'steps': steps, 'checks': checks}

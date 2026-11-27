"""Antigravity 설치 스위치와 약관 확인 대화상자의 그림과 조작 실측(카드 #1926).

「코딩 에이전트 연결」 탭 맨 위 토글의 꺼짐, 켜짐, 확인 대화상자(빈 입력, 맞는 입력, 저장 실패), 설정 읽기 실패, 읽는 중을
1280과 360 폭에서 찍고, ui-design 0절 13~18번을 실제 키 입력과 좌표로 잰다. 그림 이름에는 settings_toolbar_fakes.PREFIX가 붙는다.
"""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import expect

from settings_toolbar_fakes import PREFIX, SESSION_ID, OrchLikeFake, check, new_page, open_settings, shot
from settings_toolbar_r2 import DIALOGS, OPS, active, broken_words, fixtures_flows, ops

PHRASE = "인지했습니다"
CONSENT = '[data-slot="dialog-popup"]:has(#agy-consent-input)'
CONFIRM = "켜기"


def open_tab(browser, base, width, fake, height=900, theme="dark"):
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, width, height, theme=theme)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    if width < 600:
        page.get_by_role("button", name="모든 설정").click()
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트 연결", exact=True).click()
    expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
    return context, page


def row_metrics(page):
    return page.evaluate("""() => {
      const row = document.querySelector('[data-testid="antigravity-backend-row"]').getBoundingClientRect();
      const frame = document.querySelector('[data-testid="coding-agents-tab"]').getBoundingClientRect();
      const sw = document.querySelector('[data-testid="antigravity-backend-switch"]');
      const title = document.querySelector('.agy-backend-text').getBoundingClientRect();
      const s = sw ? sw.getBoundingClientRect() : null;
      return { rowLeft: row.left, rowRight: row.right, frameLeft: frame.left, frameRight: frame.right,
        switchRight: s ? s.right : null, switchMid: s ? (s.top + s.bottom) / 2 : null, titleMid: (title.top + title.bottom) / 2,
        doc: document.documentElement.scrollWidth, inner: window.innerWidth };
    }""")


def assert_row(page, label):
    m = row_metrics(page)
    check(f"{label}: 줄의 왼쪽과 오른쪽 끝이 노드 목록 틀과 같음", abs(m["rowLeft"] - m["frameLeft"]) <= 1 and abs(m["rowRight"] - m["frameRight"]) <= 1, m)
    check(f"{label}: 가로 넘침 없음", m["doc"] <= m["inner"], m)
    if m["switchRight"] is not None:
        check(f"{label}: 스위치가 줄 안쪽에 있고 글 덩어리와 세로 가운데가 맞음", m["switchRight"] <= m["rowRight"] and abs(m["switchMid"] - m["titleMid"]) <= 2, m)
    words = broken_words(page.locator('[data-testid="antigravity-backend-row"]'))
    check(f"{label}: 줄 안 글의 어절이 끊기지 않음", not words, words)


def consent(page):
    return page.locator(CONSENT)


def typed_phrase(page, text):
    page.locator("#agy-consent-input").fill(text)


def confirm_button(page):
    return consent(page).get_by_role("button", name=CONFIRM, exact=True)


AGY_PROVIDER = '[data-testid="node-providers-panel"] [data-provider-id="antigravity"]'
WATCH_AGY_ROW = """() => {
  window.__agySeen = [];
  const record = () => {
    const row = document.querySelector('[data-testid="node-providers-panel"] [data-provider-id="antigravity"]');
    window.__agySeen.push(row ? row.getAttribute('data-state') : null);
  };
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true });
}"""


def agy_provider_state(page):
    return page.evaluate("(sel) => { const e = document.querySelector(sel); return e ? e.getAttribute('data-state') : null; }", AGY_PROVIDER)


def wait_agy_provider(page, predicate, timeout_ms=4000):
    """Antigravity 공급자 줄의 data-state가 조건을 채울 때까지 기다린 뒤 마지막 값을 돌려준다."""
    waited = 0
    state = agy_provider_state(page)
    while not predicate(state) and waited < timeout_ms:
        page.wait_for_timeout(100)
        waited += 100
        state = agy_provider_state(page)
    return state


def capture_width(browser, base, out: Path, width: int):
    suffix = f"-{width}"
    fake = OrchLikeFake(atom=True)
    context, page = open_tab(browser, base, width, fake)
    switch = page.get_by_test_id("antigravity-backend-switch")
    expect(switch).to_be_visible(timeout=15000)
    check(f"꺼짐 {width}px: 스위치가 꺼져 있음", switch.get_attribute("aria-checked") == "false", switch.get_attribute("aria-checked"))
    assert_row(page, f"꺼짐 {width}px")
    check(f"꺼짐 {width}px: 아래 공급자 패널에 Antigravity 줄이 없음", page.locator(AGY_PROVIDER).count() == 0 and page.locator('[data-testid="node-providers-panel"] [data-provider-id="codex"]').count() == 1, agy_provider_state(page))
    shot(page, out, f"agy-toggle-off{suffix}.png", width, "Antigravity 토글 꺼짐(기본)", page.locator('[data-slot="dialog-popup"]'))

    # 켜기를 누르면 바로 켜지 않고 확인 대화상자가 열린다. 첫 초점은 입력 칸이다.
    switch.click()
    expect(consent(page)).to_be_visible(timeout=10000)
    page.wait_for_timeout(300)
    check(f"대화상자 {width}px: 열기만으로는 저장하지 않음", fake.agy_puts == [], fake.agy_puts)
    first_focus = active(page)
    check(f"대화상자 {width}px: 첫 초점이 입력 칸", page.evaluate("() => document.activeElement && document.activeElement.id") == "agy-consent-input", first_focus)
    check(f"대화상자 {width}px: 빈 입력이면 켜기 단추가 꺼져 있음", confirm_button(page).is_disabled(), "disabled")
    box = consent(page).bounding_box()
    check(f"대화상자 {width}px: 화면 안에 들어오고 가로 넘침 없음", box["x"] >= 0 and box["x"] + box["width"] <= width + 1 and page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"), box)
    words = broken_words(consent(page))
    check(f"대화상자 {width}px: 글의 어절이 끊기지 않음", not words, words)
    shot(page, out, f"agy-dialog-empty{suffix}.png", width, "확인 대화상자, 빈 입력(켜기 단추 꺼짐)", page)

    typed_phrase(page, "인지")
    check(f"대화상자 {width}px: 다른 문구면 켜기 단추가 꺼져 있음", confirm_button(page).is_disabled(), "disabled")
    page.locator("#agy-consent-input").press("Enter")
    page.wait_for_timeout(300)
    check(f"대화상자 {width}px: 다른 문구에서 Enter는 저장하지 않고 대화상자가 그대로 열려 있음", fake.agy_puts == [] and consent(page).is_visible(), fake.agy_puts)
    typed_phrase(page, PHRASE)
    check(f"대화상자 {width}px: 맞는 문구면 켜기 단추가 살아남", confirm_button(page).is_enabled(), "enabled")
    shot(page, out, f"agy-dialog-typed{suffix}.png", width, "확인 대화상자, 맞는 입력(켜기 단추 살아남)", page)

    # Tab 순서: 대화상자 밖으로 새지 않고, 보이지 않는 요소에 초점이 가지 않는다.
    seen = []
    for _ in range(5):
        page.keyboard.press("Tab")
        seen.append(active(page))
    inside = page.evaluate("() => !!document.activeElement.closest('[data-slot=\"dialog-popup\"]') && !!document.querySelector('#agy-consent-input').closest('[data-slot=\"dialog-popup\"]').contains(document.activeElement)")
    check(f"대화상자 {width}px: Tab을 돌려도 초점이 대화상자 안에 있고 안 보이는 요소가 없음", inside and not any("안 보임" in item for item in seen), seen)

    # Esc는 대화상자만 닫고 설정창은 그대로이며 초점은 스위치로 돌아온다.
    page.keyboard.press("Escape")
    expect(consent(page)).to_have_count(0)
    check(f"Esc {width}px: 설정창은 그대로", page.get_by_test_id("coding-agents-tab").is_visible() and fake.agy_puts == [], fake.agy_puts)
    after_esc = active(page)
    check(f"Esc {width}px: 닫은 뒤 초점이 스위치", page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-testid')") == "antigravity-backend-switch", after_esc)
    check(f"Esc {width}px: 토글은 꺼짐 그대로", switch.get_attribute("aria-checked") == "false", switch.get_attribute("aria-checked"))

    # 맞는 입력 뒤 Enter로 켠다. PUT에 확인 문구와 버전이 실린다.
    switch.click()
    expect(consent(page)).to_be_visible(timeout=10000)
    typed_phrase(page, f"  {PHRASE} ")
    page.evaluate(WATCH_AGY_ROW)
    page.locator("#agy-consent-input").press("Enter")
    expect(consent(page)).to_have_count(0, timeout=10000)
    check(f"켜기 {width}px: acknowledgement를 담은 PUT 한 번", fake.agy_puts == [{"value": {"enabled": True, "acknowledgement": PHRASE}, "expectedVersion": 0}], fake.agy_puts)
    check(f"켜기 {width}px: 토글이 켜짐", switch.get_attribute("aria-checked") == "true", switch.get_attribute("aria-checked"))
    after_confirm = active(page)
    check(f"켜기 {width}px: 닫은 뒤 초점이 스위치", page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-testid')") == "antigravity-backend-switch", after_confirm)
    state = wait_agy_provider(page, lambda value: value is not None and value != "not_configured")
    seen = page.evaluate("() => window.__agySeen")
    check(f"켜기 {width}px: 켠 뒤 Antigravity 줄이 나타나고 미설정이 아님(새로 모은 사용량)", state is not None and state != "not_configured" and fake.refresh_posts == 1, {"state": state, "refresh_posts": fake.refresh_posts})
    check(f"켜기 {width}px: 기다리는 동안 Antigravity 줄이 미설정으로 보인 적이 없음", "not_configured" not in seen, seen)
    shot(page, out, f"agy-toggle-on{suffix}.png", width, "Antigravity 토글 켜짐(Antigravity 줄이 연결됨으로 나타남)", page.locator('[data-slot="dialog-popup"]'))
    # 끄기는 대화상자 없이 바로 저장한다.
    switch.click()
    page.wait_for_timeout(500)
    check(f"끄기 {width}px: Antigravity 줄이 다시 사라지고 Codex 줄은 그대로", page.locator(AGY_PROVIDER).count() == 0 and page.locator('[data-testid="node-providers-panel"] [data-provider-id="codex"]').count() == 1, agy_provider_state(page))
    check(f"끄기 {width}px: 대화상자 없이 PUT, 토글이 꺼짐", consent(page).count() == 0 and fake.agy_puts[-1] == {"value": {"enabled": False}, "expectedVersion": 1} and switch.get_attribute("aria-checked") == "false", fake.agy_puts[-1])
    context.close()
    return first_focus, after_esc, after_confirm, seen


def capture_failures(browser, base, out: Path, width: int):
    suffix = f"-{width}"
    # 저장 실패: 대화상자 안에 오류와 다시 시도. 닫지 않는다.
    fake = OrchLikeFake(atom=True)
    fake.agy_put = "fail"
    context, page = open_tab(browser, base, width, fake)
    page.get_by_test_id("antigravity-backend-switch").click()
    expect(consent(page)).to_be_visible(timeout=10000)
    typed_phrase(page, PHRASE)
    confirm_button(page).click()
    alert = consent(page).locator('[role="alert"]')
    expect(alert).to_be_visible(timeout=10000)
    retry = consent(page).get_by_role("button", name="다시 시도", exact=True)
    check(f"저장 실패 {width}px: 대화상자가 열린 채 오류와 다시 시도가 있고 토글은 꺼짐", retry.is_visible() and page.get_by_test_id("antigravity-backend-switch").get_attribute("aria-checked") == "false", alert.inner_text())
    words = broken_words(consent(page))
    check(f"저장 실패 {width}px: 오류 글 어절이 끊기지 않고 가로 넘침 없음", not words and page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"), words)
    shot(page, out, f"agy-dialog-save-failed{suffix}.png", width, "확인 대화상자, 저장 실패(오류와 다시 시도)", page)
    fake.agy_put = "ok"
    retry.click()
    expect(consent(page)).to_have_count(0, timeout=10000)
    check(f"저장 실패 {width}px: 다시 시도하면 켜짐", page.get_by_test_id("antigravity-backend-switch").get_attribute("aria-checked") == "true", fake.agy_puts)
    context.close()

    # 설정 읽기 실패: 토글 자리가 실패 안내와 다시 시도로 바뀐다.
    fake = OrchLikeFake(atom=True)
    fake.agy_read = "fail"
    context, page = open_tab(browser, base, width, fake)
    row = page.get_by_test_id("antigravity-backend-row")
    notice = row.locator('[role="alert"]')
    expect(notice).to_be_visible(timeout=15000)
    check(f"읽기 실패 {width}px: 스위치가 없고 다시 시도가 있음", page.get_by_test_id("antigravity-backend-switch").count() == 0 and row.get_by_role("button", name="다시 시도").is_visible(), notice.inner_text())
    assert_row(page, f"읽기 실패 {width}px")
    shot(page, out, f"agy-read-failed{suffix}.png", width, "설정 읽기 실패(실패 안내와 다시 시도)", page.locator('[data-slot="dialog-popup"]'))
    fake.agy_read = "ok"
    row.get_by_role("button", name="다시 시도").click()
    expect(page.get_by_test_id("antigravity-backend-switch")).to_be_visible(timeout=10000)
    context.close()


LOADING_METRICS = """() => {
  const row = document.querySelector('[data-testid="antigravity-backend-row"]');
  const text = row.querySelector('.agy-backend-text');
  const title = text.querySelector(':scope > span');
  const desc = row.querySelector('.agy-backend-description');
  const actions = row.querySelector('.c724-account-actions');
  const lineHeight = parseFloat(getComputedStyle(desc).lineHeight);
  return {
    rowHeight: Math.round(row.getBoundingClientRect().height),
    descLines: Math.round(desc.getBoundingClientRect().height / lineHeight),
    actionsWidth: Math.round(actions.getBoundingClientRect().width),
    titleLines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
    titleTruncated: title.scrollWidth > title.clientWidth + 1,
  };
}"""


def capture_loading(browser, base, out: Path, width: int):
    """설정을 읽는 중과 읽은 뒤의 줄이 같은 크기다: 높이, 설명 줄 수, 동작 칸 너비가 같고 제목이 끊기지 않는다."""
    fake = OrchLikeFake(atom=True)
    fake.agy_read = "hold"
    context, page = open_tab(browser, base, width, fake)
    row = page.get_by_test_id("antigravity-backend-row")
    expect(row).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    check(f"읽는 중 {width}px: 스위치 자리에 크기가 같은 자리 표시가 있고 아직 스위치는 없음", page.get_by_test_id("antigravity-backend-switch").count() == 0 and page.get_by_test_id("antigravity-backend-switch-loading").count() == 1 and len(fake.held_agy) >= 1, "로딩 표현")
    loading = page.evaluate(LOADING_METRICS)
    shot(page, out, f"agy-loading-{width}.png", width, "설정을 읽는 중(스위치 크기의 자리 표시)", page.locator('[data-slot="dialog-popup"]'))
    fake.agy_read = "ok"
    for held in fake.held_agy:
        held.fulfill(json={"value": {"enabled": False}, "version": 0, "source": "default"})
    expect(page.get_by_test_id("antigravity-backend-switch")).to_be_visible(timeout=10000)
    page.wait_for_timeout(300)
    loaded = page.evaluate(LOADING_METRICS)
    check(f"읽는 중 {width}px: 읽은 뒤와 줄 높이와 설명 줄 수와 동작 칸 너비가 같음", loading["rowHeight"] == loaded["rowHeight"] and loading["descLines"] == loaded["descLines"] and loading["actionsWidth"] == loaded["actionsWidth"], {"loading": loading, "loaded": loaded})
    check(f"읽는 중 {width}px: 제목이 한 줄이고 잘리거나 낱말 가운데서 끊기지 않음(읽는 중과 읽은 뒤)", loading["titleLines"] == 1 and loaded["titleLines"] == 1 and not loading["titleTruncated"] and not loaded["titleTruncated"], {"loading": loading, "loaded": loaded})
    context.close()
    return loading, loaded


PLACEHOLDER_LOOK = """() => {
  const el = document.querySelector('[data-testid="antigravity-backend-switch-loading"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { role: el.getAttribute('role'), ariaChecked: el.getAttribute('aria-checked'), hasChecked: !!el.closest('[data-testid="antigravity-backend-row"]').querySelector('[aria-checked]'),
    thumbs: el.children.length, busy: el.closest('[data-testid="antigravity-backend-row"]').getAttribute('aria-busy'), w: Math.round(r.width), h: Math.round(r.height) };
}"""

SWITCH_SIZE = """() => {
  const el = document.querySelector('[data-testid="antigravity-backend-switch"]');
  const r = el.getBoundingClientRect();
  const thumb = el.querySelector('span');
  return { w: Math.round(r.width), h: Math.round(r.height), checked: el.getAttribute('aria-checked'), thumbX: Math.round(thumb.getBoundingClientRect().left - r.left) };
}"""

WATCH_SWITCH_FRAMES = """() => {
  window.__switchFrames = [];
  const sample = () => {
    const el = document.querySelector('[data-testid="antigravity-backend-switch"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const thumb = el.querySelector('span');
    window.__switchFrames.push({ checked: el.getAttribute('aria-checked'), thumbX: Math.round(thumb.getBoundingClientRect().left - r.left) });
  };
  new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true });
  const tick = () => { sample(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}"""


def pixel_gap(image_path, box_a, box_b):
    from PIL import Image
    image = Image.open(image_path).convert("RGB")
    pick = lambda box: image.getpixel((int(box[0] + box[2] / 2), int(box[1] + box[3] / 2)))
    a, b = pick(box_a), pick(box_b)
    return max(abs(x - y) for x, y in zip(a, b)), a, b


def capture_loading_on(browser, base, out: Path, width: int, theme: str):
    """켜져 있는 설정을 읽는 중: 자리 표시는 켜짐으로도 꺼짐으로도 읽히지 않고, 읽은 직후 첫 프레임부터 손잡이가 켜짐 자리에 있다."""
    fake = OrchLikeFake(atom=True)
    fake.agy = {"enabled": True, "version": 1}
    fake.collected_agy = "auto"
    fake.agy_read = "hold"
    context, page = open_tab(browser, base, width, fake, theme=theme)
    page.emulate_media(reduced_motion="no-preference")
    expect(page.get_by_test_id("antigravity-backend-row")).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    look = page.evaluate(PLACEHOLDER_LOOK)
    check(f"켜진 설정 읽는 중 {width}px {theme}: 자리 표시에 role, aria-checked, 손잡이가 없고 줄이 aria-busy", look is not None and look["role"] is None and look["ariaChecked"] is None and not look["hasChecked"] and look["thumbs"] == 0 and look["busy"] == "true", look)
    tag = f"{width}-{theme}"
    row = page.get_by_test_id("antigravity-backend-row")
    box = page.get_by_test_id("antigravity-backend-switch-loading").bounding_box()
    shot(page, out, f"agy-on-loading-{tag}.png", width, f"켜진 설정을 읽는 중({theme}, 손잡이 없는 자리 표시)", row)
    row_box = row.bounding_box()
    gap, placeholder_rgb, row_rgb = pixel_gap(out / (PREFIX + f"agy-on-loading-{tag}.png"), (box["x"] - row_box["x"], box["y"] - row_box["y"], box["width"], box["height"]), (6, 6, 1, 1))
    check(f"켜진 설정 읽는 중 {width}px {theme}: 자리 표시가 줄 바탕과 구분됨(화소 차이 {gap})", gap >= 8, {"placeholder": placeholder_rgb, "row": row_rgb, "gap": gap})
    page.evaluate(WATCH_SWITCH_FRAMES)
    fake.agy_read = "ok"
    for held in fake.held_agy:
        held.fulfill(json={"value": {"enabled": True}, "version": 1, "source": "settings"})
    expect(page.get_by_test_id("antigravity-backend-switch")).to_be_visible(timeout=10000)
    page.wait_for_timeout(400)
    frames = page.evaluate("() => window.__switchFrames")
    final = page.evaluate(SWITCH_SIZE)
    check(f"켜진 설정 읽는 직후 {width}px {theme}: 첫 프레임부터 aria-checked=true이고 손잡이가 켜짐 자리에 있음(미끄러짐 없음)", len(frames) >= 1 and all(f["checked"] == "true" and f["thumbX"] == final["thumbX"] for f in frames), {"frames": frames[:6], "final": final})
    expected = {1280: (30, 18), 360: (38, 22)}[width]
    check(f"켜진 설정 읽는 중 {width}px {theme}: 자리 표시 크기가 스위치와 같음({expected[0]}x{expected[1]})", (look["w"], look["h"]) == expected == (final["w"], final["h"]), {"placeholder": look, "switch": final})
    context.close()
    return look, final, gap


def capture_resize(browser, base):
    """대화상자를 연 채 창을 좁혔다 넓혀도 입력 중인 글이 남고 대화상자가 화면 안에 있다."""
    fake = OrchLikeFake(atom=True)
    context, page = open_tab(browser, base, 1280, fake)
    page.get_by_test_id("antigravity-backend-switch").click()
    expect(consent(page)).to_be_visible(timeout=10000)
    typed_phrase(page, "인지했")
    results = []
    for width in (360, 1280):
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(400)
        box = consent(page).bounding_box()
        results.append((width, round(box["x"]), round(box["width"]), page.locator("#agy-consent-input").input_value()))
        check(f"창 크기 {width}px: 대화상자가 화면 안에 있고 입력 중인 글이 남음", box["x"] >= 0 and box["x"] + box["width"] <= width + 1 and page.locator("#agy-consent-input").input_value() == "인지했", results[-1])
    context.close()
    return results


def capture_agy(browser, base, out: Path):
    firsts = []
    for width in (1280, 360):
        firsts.append((width, *capture_width(browser, base, out, width)))
        capture_failures(browser, base, out, width)
    loadings = [capture_loading(browser, base, out, width) for width in (1280, 360)]
    on_loadings = [(width, theme, *capture_loading_on(browser, base, out, width, theme)) for width in (1280, 360) for theme in ("dark", "light")]
    resize = capture_resize(browser, base)
    wide = firsts[0]
    name = lambda label: "확인 문구 입력 칸" if label == "INPUT" else label
    wide = (wide[0], name(wide[1]), wide[2], wide[3], [name(item) for item in wide[4]])
    ops("13", "통과", f"설정을 읽는 동안 줄의 틀(제목, 설명)이 서고 스위치 크기의 자리 표시가 있다(agy-loading-1280.png, agy-loading-360.png). 읽는 중과 읽은 뒤의 줄 높이, 설명 줄 수, 동작 칸 너비가 같다: 1280 {loadings[0][0]}, 360 {loadings[1][0]}")
    ops("13", "통과", f"켜진 설정을 읽는 중에도 자리 표시는 role, aria-checked, 손잡이가 없는 알약 뼈대라 켜짐으로도 꺼짐으로도 읽히지 않는다(agy-on-loading-*.png). 읽은 직후 첫 프레임부터 aria-checked=true이고 손잡이가 켜짐 자리에 있다. 크기는 스위치와 같고 줄 바탕과 화소 차이가 난다(너비, 테마, 자리 표시 크기, 읽은 뒤 스위치, 화소 차이): {[(w, t, (l['w'], l['h']), (f['w'], f['h']), g) for w, t, l, f, g in on_loadings]}")
    ops("14", "통과", f"켜기를 누르면 첫 초점이 입력 칸({wide[1]}), Esc나 켜기 뒤 초점이 스위치로 돌아온다({wide[2]}, {wide[3]}). 1280과 360에서 같다")
    ops("15", "통과", f"Tab 5번 순서 {wide[4]}: 초점이 대화상자 안에서만 돌고 안 보이는 요소가 없다. Esc는 대화상자만 닫고 설정창과 토글 값은 그대로다")
    ops("16", "통과", "360px에서 줄과 대화상자가 가로 넘침 없이 서고(모든 어절 한 덩어리), 대화상자는 화면 안에 들어온다. 저장 실패 문구와 읽기 실패 안내도 같다")
    ops("17", "통과", "저장 실패는 대화상자 안 role=alert와 다시 시도, 읽기 실패는 토글 자리의 실패 안내와 다시 시도(agy-dialog-save-failed, agy-read-failed). 다시 시도하면 성공한다")
    ops("18", "통과", f"대화상자를 연 채 1280→360→1280으로 바꿔도 입력 중인 글이 남고 대화상자가 화면 안에 있다: {resize}")
    DIALOGS.append(("Antigravity 확인 대화상자", "토글을 켜는 쪽으로 누름(Space, Enter)", f"{wide[1]}", "맞는 문구면 켜기(저장), 아니면 아무 일 없음", "대화상자만 닫음, 설정창 유지", f"{wide[2]} 단추"))


def write_agy_operations(out: Path):
    lines = ["# 조작 결과(ui-design 0절 13~18번)", "", "카드 #1926. 리포 스크립트 scripts/visual-check/settings_toolbar.py의 --only-agy가 실제 키 입력과 실측으로 잰다(settings_toolbar_agy.py).", "",
             "## 14번부터 18번", "", "| 번호 | 결과 | 근거 |", "| --- | --- | --- |"]
    titles = {"13": "13 로딩 상태", "14": "14 누른 뒤 초점", "15": "15 Tab과 Esc", "16": "16 최소 폭 넘침과 잘림", "17": "17 오류 상태", "18": "18 창 크기 바꾸기"}
    for number in titles:
        for result, evidence in OPS.get(number, []):
            lines.append(f"| {titles[number]} | {result} | {evidence} |")
    lines += ["", "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| --- | --- | --- | --- | --- | --- |"]
    lines += [f"| {' | '.join(row)} |" for row in DIALOGS]
    lines += ["", "토글 줄은 줄 안 편집이 없다(스위치 하나). 끄기는 확인 없이 바로 저장된다.", "", "## 실행", "", "```", "python3 <리포 경로>/scripts/visual-check/settings_toolbar.py --only-agy --output <출력 폴더>", "```", "",
              "python3.11에는 playwright가 없어 이 노드에서는 `-P` 없이 python3 절대 경로로 부른다. 먼저 `corepack pnpm -C unified-dashboard run build`로 dist를 만든다. 산출물은 같은 폴더의 r2-agy-*.png, index.md, checks.json, operations.md다."]
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

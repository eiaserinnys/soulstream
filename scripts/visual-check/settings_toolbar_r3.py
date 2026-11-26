"""3차 보강 그림과 단언(세라피엘 2차 재검수 반영, 카드 #1787 U17).

그림 이름에는 r3- 접두어가 붙는다(capture_r3가 settings_toolbar_fakes.PREFIX를 바꾼다). 1, 2차 그림은 지우지 않는다.
단언은 세라피엘의 재현 스크립트(card1787_r2_extra.py, card1787_r2_nodes.py)를 옮긴 것이다.
고치기 전 코드에서 단언이 실패하는지 볼 때는 환경변수 U17_EXPECT_FAIL=1을 주면 장면마다 실패를 모아 출력한다.
"""
from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import expect

import settings_toolbar_fakes as fakes
from settings_toolbar_fakes import SESSION_ID, Fake, check, new_page, open_settings, shot
from settings_toolbar_r2 import DIALOG, active, broken_words, fixtures_flows, ops, open_coding_tab

PENDING_JS = """(b) => {
  const s = getComputedStyle(b);
  return { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), expanded: b.getAttribute('aria-expanded'), opacity: s.opacity, pointerEvents: s.pointerEvents };
}"""
PERSISTENT_DESCRIPTION = "영구 세션의 지시와 표시, 기록을 관리합니다."
EXPECT_FAIL = os.environ.get("U17_EXPECT_FAIL") == "1"
FAILED_AS_EXPECTED: list[str] = []


def scenario(name: str, run, *args):
    """고치기 전 코드를 볼 때는 실패한 장면을 모으고 다음으로 넘어간다."""
    try:
        run(*args)
    except Exception as error:  # 고치기 전 코드에서는 요소가 아예 없어 시간 초과로 끝나는 장면도 있다
        if not EXPECT_FAIL:
            raise
        FAILED_AS_EXPECTED.append(f"{name}: {str(error).splitlines()[0]}")
        print(f"FAILED-AS-EXPECTED {name}: {str(error).splitlines()[0]}")


def pending_look(button) -> dict:
    return button.evaluate(PENDING_JS)


def is_waiting(look: dict) -> bool:
    """Claude 행의 로그인 중 단추와 같은 비활성 모양(투명도 0.64, 눌러도 반응 없음)이되 disabled 속성은 없다."""
    return look["ariaDisabled"] == "true" and look["disabled"] is False and look["opacity"] == "0.64" and look["pointerEvents"] == "none"


def is_idle(look: dict) -> bool:
    return look["ariaDisabled"] is None and look["disabled"] is False and look["opacity"] == "1" and look["pointerEvents"] != "none"


def row_buttons_while_open(browser, base, out: Path, width: int):
    """확인줄이나 시트가 열린 동안 행의 「연결」, 「다시 연결」은 비활성 모양이고, 닫으면 돌아온다."""
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, width)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page, narrow=width < 768)
    codex = page.get_by_test_id("agent-login-button-codex")
    anti = page.get_by_test_id("agent-login-button-antigravity")
    sheet = page.get_by_test_id("agent-login-sheet")
    dialog = page.locator(DIALOG)
    check(f"행 단추 {width}px: 열기 전에는 평소 모양", is_idle(pending_look(codex)) and is_idle(pending_look(anti)), [pending_look(codex), pending_look(anti)])

    codex.click()
    expect(sheet.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    page.wait_for_timeout(400)
    look = pending_look(codex)
    check(f"Codex 시트가 열린 동안 「연결」 {width}px: 비활성 모양(투명도 0.64, 눌러도 반응 없음), aria-disabled, disabled 속성은 없음", is_waiting(look), look)
    shot(page, out, f"settings-coding-agents-sheet-open-{width}.png", width, "코딩 에이전트 탭: 시트가 열린 동안 「연결」이 비활성 모양", dialog)
    posts = fake.login_posts
    codex.focus()
    codex.press("Enter")
    page.wait_for_timeout(300)
    check(f"시트가 열린 동안 「연결」을 키로 눌러도 {width}px: 새 로그인을 시작하지 않고 시트가 그대로이며 초점이 사라지지 않음", fake.login_posts == posts and sheet.count() == 1 and active(page).startswith("연결"), {"posts": fake.login_posts - posts, "focus": active(page)})
    sheet.get_by_role("button", name="취소").click()
    expect(sheet).to_have_count(0)
    look = pending_look(codex)
    check(f"시트를 닫으면 「연결」 {width}px: 원래 모양으로 돌아오고 초점이 그 단추에 있음", is_idle(look) and active(page) == "연결", {**look, "focus": active(page)})

    anti.click()
    confirm = page.get_by_test_id("agent-login-confirm-antigravity")
    expect(confirm).to_be_visible()
    page.wait_for_timeout(300)
    look = pending_look(anti)
    check(f"확인줄이 열린 동안 「다시 연결」 {width}px: 비활성 모양, aria-disabled, disabled 속성은 없음", is_waiting(look), look)
    check(f"확인줄 {width}px: 첫 초점은 그대로 「취소」", active(page) == "취소", active(page))
    shot(page, out, f"settings-coding-agents-confirm-open-{width}.png", width, "코딩 에이전트 탭: 확인줄이 열린 동안 「다시 연결」이 비활성 모양", dialog)
    confirm.get_by_role("button", name="다시 연결").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    look = pending_look(anti)
    check(f"확인줄에서 시트로 넘어가도 「다시 연결」 {width}px: 비활성 모양이 이어짐", is_waiting(look), look)
    sheet.get_by_role("button", name="취소").click()
    expect(sheet).to_have_count(0)
    look = pending_look(anti)
    check(f"시트를 닫으면 「다시 연결」 {width}px: 원래 모양으로 돌아오고 초점이 그 단추에 있음", is_idle(look) and active(page) == "다시 연결", {**look, "focus": active(page)})
    if width == 1280:
        ops("14", "통과", "시트나 확인줄이 열린 동안 「연결」, 「다시 연결」은 aria-disabled 비활성 모양(투명도 0.64)이고 disabled 속성은 없다. 키로 눌러도 아무 일이 없고 초점이 사라지지 않으며, 닫으면 평소 모양과 그 단추로 돌아온다")
    context.close()


def retry_while_creating(browser, base, out: Path, width: int):
    """기본 세션 만들기 실패 뒤 「다시 시도」: 다시 만드는 동안 회전 표시와 비활성 모양, 초점 유지, 다시 실패하면 원래대로."""
    fake = Fake(atom=True, sessions="bootstrap", bootstrap="fail")
    context, page = new_page(browser, base, fake, width)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    notice = page.get_by_test_id("persistent-empty-bootstrap-failed")
    expect(notice).to_be_visible(timeout=20000)
    retry = notice.get_by_role("button", name="다시 시도")
    check(f"다시 시도 {width}px: 실패 직후에는 평소 모양", is_idle(pending_look(retry)), pending_look(retry))
    fake.bootstrap = "hold"
    retry.focus()
    retry.press("Enter")
    for _ in range(50):
        if fake.held_bootstrap is not None:
            break
        page.wait_for_timeout(100)
    page.wait_for_timeout(300)
    look = pending_look(retry)
    spinner = notice.locator('[data-slot="frame-loading"] svg.animate-spin')
    check(f"다시 만드는 중 {width}px: 처음 만들 때와 같은 회전 표시가 그 자리에 있음", spinner.count() == 1 and spinner.is_visible(), spinner.count())
    check(f"다시 만드는 중 {width}px: 「다시 시도」는 비활성 모양과 aria-disabled", is_waiting(look), look)
    check(f"다시 만드는 중 {width}px: 초점이 body로 빠지지 않고 그 단추에 남음", active(page) == "다시 시도", active(page))
    dims = page.evaluate("() => ({doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
    check(f"다시 만드는 중 {width}px: 가로 넘침 없음", dims["doc"] <= dims["inner"], dims)
    shot(page, out, f"pas-empty-retrying-{width}.png", width, "PAS 0개, 기본 세션 다시 만드는 중: 회전 표시와 비활성 모양의 「다시 시도」", page)
    before = len([call for call in fake.calls if call == ("POST", "/api/persistent-sessions/bootstrap")])
    retry.press("Enter")
    page.wait_for_timeout(300)
    after = len([call for call in fake.calls if call == ("POST", "/api/persistent-sessions/bootstrap")])
    check(f"다시 만드는 중 {width}px: 다시 눌러도 새 요청이 없음", after == before, {"before": before, "after": after})
    fake.held_bootstrap.fulfill(status=502, json={"code": "bad_gateway", "message": "서버가 요청을 처리하지 못했습니다."})
    expect(notice.locator('[role="alert"]')).to_contain_text("기본 영구 세션을 만들지 못했습니다", timeout=10000)
    back = pending_look(retry)
    check(f"다시 실패하면 {width}px: 원래 단추와 실패 안내로 돌아오고 초점이 그 단추에 남음", is_idle(back) and notice.locator('[data-slot="frame-loading"]').count() == 0 and active(page) == "다시 시도", {**back, "focus": active(page)})
    if width == 1280:
        ops("14", "통과", "기본 세션 만들기 실패의 「다시 시도」를 눌러 다시 만드는 동안 그 자리에 회전 표시가 있고 단추는 aria-disabled 비활성 모양이며 초점이 그대로다. 다시 눌러도 새 요청이 없고, 다시 실패하면 평소 단추와 실패 안내로 돌아온다")
    context.close()


def nodes_open_selected(browser, base, out: Path, width: int):
    """코딩 에이전트 탭: 노드가 있으면 첫 연결 노드를 고른 채 열리고, 없으면 상세에 「고르세요」 글이 없다."""
    for nodes in ("many", "none"):
        fake = Fake(atom=True, nodes=nodes)
        fixtures_flows(fake)
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_settings(page)
        if width < 768:
            page.get_by_role("button", name="모든 설정").click()
        page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트 연결", exact=True).click()
        tab = page.get_by_test_id("coding-agents-tab")
        expect(tab).to_be_visible(timeout=15000)
        page.wait_for_timeout(700)
        text = tab.inner_text()
        prompt_gone = page.get_by_test_id("coding-agents-pick-node").count() == 0 and "고르세요" not in text and "왼쪽" not in text
        if nodes == "many":
            heading = tab.locator("section > div header h3, header h3").first
            check(f"코딩 에이전트 탭 {width}px 노드 여럿: 열자마자 연결된 첫 노드의 상세가 차 있음", heading.inner_text() == "eiaserinnys" and page.get_by_test_id("agent-login-button-codex").is_visible(), heading.inner_text())
            selected = tab.locator("aside [data-settings-list-row]").evaluate_all("els => els.map(e => e.className.includes('bg-accent-blue/15'))")
            check(f"코딩 에이전트 탭 {width}px 노드 여럿: 목록에서도 그 노드가 골라진 모양", selected == [True, False, False], selected)
        else:
            check(f"코딩 에이전트 탭 {width}px 노드 없음: 목록은 「연결된 노드가 없습니다.」이고 상세는 비어 있음", "연결된 노드가 없습니다." in text and page.get_by_test_id("agent-login-button-codex").count() == 0, text)
        check(f"코딩 에이전트 탭 {width}px {'노드 여럿' if nodes == 'many' else '노드 없음'}: 「고르세요」와 방향을 가리키는 글이 없음", prompt_gone, text)
        dims = page.evaluate("() => ({doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
        check(f"코딩 에이전트 탭 {width}px: 가로 넘침 없음", dims["doc"] <= dims["inner"], dims)
        shot(page, out, f"settings-coding-agents-{nodes}-{width}.png", width, f"코딩 에이전트 탭: {'노드 여럿, 첫 연결 노드가 골라진 채 열림' if nodes == 'many' else '노드 없음(상세에 안내 글 없음)'}", page.locator(DIALOG))
        context.close()


def persistent_description_360(browser, base, out: Path):
    fake = Fake(atom=True)
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    expect(page.get_by_test_id("persistent-session-settings-sections")).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    description = page.locator(".config-detail-heading p")
    check("영구 세션 탭 360px: 설명이 줄인 문구이고 어절 가운데서 줄이 바뀌지 않음", description.inner_text() == PERSISTENT_DESCRIPTION and not broken_words(description), description.inner_text())
    shot(page, out, "settings-persistent-description-360.png", 360, "설정창 영구 세션 탭 좁은 폭: 줄인 설명", page.locator(DIALOG))
    context.close()


def capture_r3(browser, base, out: Path):
    fakes.PREFIX = "r3-"
    for width in (1280, 360):
        scenario(f"행 단추 {width}", row_buttons_while_open, browser, base, out, width)
        scenario(f"다시 시도 {width}", retry_while_creating, browser, base, out, width)
        scenario(f"노드 {width}", nodes_open_selected, browser, base, out, width)
    scenario("영구 세션 설명", persistent_description_360, browser, base, out)
    if EXPECT_FAIL:
        print(f"고치기 전 코드에서 실패한 장면 {len(FAILED_AS_EXPECTED)}개")

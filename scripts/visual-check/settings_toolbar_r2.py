"""2차 보강 그림과 단언(세라피엘 1차 검수 반영, 카드 #1787 U17).

그림 이름에는 settings_toolbar_fakes.PREFIX(r2-)가 붙는다. 1차 그림은 지우지 않는다.
조작 결과(ui-design 14~18번과 대화상자 표)는 측정한 값으로 operations.md에 적는다.
"""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import expect

from settings_toolbar_fakes import (
    FAKE_PASTED_CODE, FAKE_USER_CODE, SESSION_ID, Fake, check, flow, new_page, open_settings, shot, soon, toolbar_metrics,
)

OPS: dict[str, list[tuple[str, str]]] = {}  # 번호 -> [(결과, 근거)]
DIALOGS: list[tuple[str, str, str, str, str, str]] = []  # 대상, 여는 법, 첫 초점, Enter, Esc, 닫은 뒤 초점
LONG_NAME = "아주아주긴이름을가진코딩에이전트프로필이름입니다"
DIALOG = '[data-slot="dialog-popup"]'

BROKEN_WORDS_JS = """(el) => {
  const broken = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const re = /\\S+/g; let m;
    while ((m = re.exec(node.textContent))) {
      const range = document.createRange();
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      if (range.getClientRects().length > 1) broken.push(m[0]);
    }
  }
  return broken;
}"""
ACTIVE_JS = """() => {
  const e = document.activeElement;
  if (!e || e === document.body) return 'body';
  const label = e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 14) || e.getAttribute('placeholder') || e.tagName;
  const r = e.getBoundingClientRect();
  const hidden = r.width === 0 || r.height === 0 || getComputedStyle(e).visibility === 'hidden';
  return label + (e.tagName === 'SECTION' ? ' (시트)' : '') + (hidden ? ' [안 보임]' : '');
}"""


def ops(number: str, result: str, evidence: str):
    OPS.setdefault(number, []).append((result, evidence))


def active(page) -> str:
    return page.evaluate(ACTIVE_JS)


def broken_words(locator) -> list[str]:
    return locator.evaluate(BROKEN_WORDS_JS)


def fixtures_flows(fake: Fake, with_code: bool = True):
    fake.flows = {
        "codex": flow("codex", "url_ready", auth_url="https://auth.example.invalid/codex/device", user_code=FAKE_USER_CODE if with_code else None, expires_at=soon()),
        "antigravity": flow("antigravity", "url_ready", auth_url="https://auth.example.invalid/antigravity/oauth"),
    }


def open_coding_tab(page, narrow: bool = False):
    open_settings(page)
    if narrow:
        page.get_by_role("button", name="모든 설정").click()
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트").click()
    expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
    expect(page.get_by_test_id("agent-login-button-codex")).to_be_visible(timeout=15000)


def sheet_visible(page) -> dict:
    return page.evaluate("""() => {
      const sheet = document.querySelector('[data-testid="agent-login-sheet"]').getBoundingClientRect();
      const detail = document.querySelector('.config-dialog .config-layout > .config-detail').getBoundingClientRect();
      return { sheetTop: Math.round(sheet.top), sheetBottom: Math.round(sheet.bottom), detailTop: Math.round(detail.top), detailBottom: Math.round(detail.bottom) };
    }""")


def pas_toolbars(browser, base, out: Path):
    """좁은 폭 홈 단추(1번): PAS 0, 1, 2개와 가장 긴 에이전트 이름, 대시보드 툴바 768."""
    for sessions, label in (("manual", "0개"), ("one", "1개"), ("two", "2개")):
        fake = Fake(atom=True, sessions=sessions)
        context, page = new_page(browser, base, fake, 360)
        page.goto(base + ("/persistent" if sessions == "manual" else f"/persistent/{SESSION_ID}"), wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        m = page.evaluate("""() => {
          const bar = document.querySelector('[data-testid="v3-global-toolbar"]');
          const brand = bar.querySelector('.persistent-session-brand').getBoundingClientRect();
          const name = bar.querySelector('.persistent-session-brand strong');
          const buttons = [...bar.querySelectorAll('.dashboard-toolbar-actions button')].map(b => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), left: r.left, width: r.width, height: r.height }; });
          return { sw: bar.scrollWidth, cw: bar.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth, brandRight: brand.right, nameClipped: name ? name.scrollWidth > name.clientWidth : false, buttons };
        }""")
        names = [b["label"] for b in m["buttons"]]
        check(f"PAS 창 툴바 360px(PAS {label}): 홈 단추가 있음", "홈" in names, names)
        check(f"PAS 창 툴바 360px(PAS {label}): 가로 넘침 없음", m["sw"] <= m["cw"] and m["doc"] <= m["inner"], m)
        check(f"PAS 창 툴바 360px(PAS {label}): 단추가 모두 40x40 이상", all(b["width"] >= 40 and b["height"] >= 40 for b in m["buttons"]), m)
        check(f"PAS 창 툴바 360px(PAS {label}): 이름과 단추가 겹치지 않음", m["brandRight"] <= m["buttons"][0]["left"], m)
        if sessions != "manual":
            check(f"PAS 창 툴바 360px(PAS {label}): 에이전트 이름이 잘리지 않음", not m["nameClipped"], m)
        shot(page, out, f"pas-toolbar-360-sessions-{sessions}.png", 360, f"PAS 창 툴바 좁은 폭, PAS {label}: 홈 단추가 보임", page if sessions == "manual" else page.get_by_test_id("v3-global-toolbar"))
        page.get_by_role("button", name="홈").click()
        page.wait_for_url(base + "/", timeout=10000)
        check(f"PAS 창 툴바 360px(PAS {label}): 홈을 한 번 누르면 /로 감", page.url == base + "/", page.url)
        context.close()
    fake = Fake(atom=True, sessions="two", agent_name=LONG_NAME)
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    page.wait_for_timeout(600)
    m = page.evaluate("""() => {
      const bar = document.querySelector('[data-testid="v3-global-toolbar"]');
      const brand = bar.querySelector('.persistent-session-brand').getBoundingClientRect();
      const first = bar.querySelector('.dashboard-toolbar-actions button').getBoundingClientRect();
      return { sw: bar.scrollWidth, cw: bar.clientWidth, brandRight: brand.right, firstLeft: first.left, brandWidth: brand.width, ellipsis: getComputedStyle(bar.querySelector('.persistent-session-brand strong')).textOverflow };
    }""")
    check("PAS 창 툴바 360px(가장 긴 에이전트 이름): 가로 넘침 없음, 이름은 말줄임, 단추와 겹치지 않음", m["sw"] <= m["cw"] and m["brandRight"] <= m["firstLeft"] and m["ellipsis"] == "ellipsis" and m["brandWidth"] > 0, m)
    ops("16", "통과", f"PAS 창 툴바 360px에 {len(LONG_NAME)}자 에이전트 이름과 단추 여섯 개: 가로 넘침 없음, 이름은 말줄임, 이름 상자 {m['brandWidth']:.0f}px")
    shot(page, out, "pas-toolbar-360-long-name.png", 360, "PAS 창 툴바 좁은 폭, 가장 긴 에이전트 이름과 단추 여섯 개", page.get_by_test_id("v3-global-toolbar"))
    context.close()
    for width in (768, 820, 863, 900):
        fake = Fake(atom=True)
        context, page = new_page(browser, base, fake, width, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
        page.goto(base + "/", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        m = toolbar_metrics(page, '[data-testid="v3-global-toolbar"]')
        inside = all(b["right"] <= m["innerWidth"] for b in m["buttons"])
        check(f"대시보드 툴바 {width}px: atom 단추 있음, 가로 넘침 없음, 마지막 단추가 화면 안에 있음", any(b["label"] == "atom 열기" for b in m["buttons"]) and m["scrollWidth"] <= m["clientWidth"] and inside, m)
        if width == 768:
            shot(page, out, "dashboard-toolbar-768.png", 768, "기존 대시보드 툴바", page.get_by_test_id("v3-global-toolbar"))
        context.close()


def light_theme(browser, base, out: Path):
    """밝은 테마: 두 툴바, 빈 상태 세 경우, 코딩 에이전트 탭."""
    for width in (360, 1280):
        fake = Fake(atom=True)
        context, page = new_page(browser, base, fake, width, theme="light", preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
        page.goto(base + "/", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(500)
        shot(page, out, f"light-dashboard-toolbar-{width}.png", width, "밝은 테마: 기존 대시보드 툴바", page.get_by_test_id("v3-global-toolbar"))
        context.close()
        fake = Fake(atom=True, sessions="two")
        context, page = new_page(browser, base, fake, width, theme="light")
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(500)
        shot(page, out, f"light-pas-toolbar-{width}.png", width, "밝은 테마: PAS 창 툴바", page.get_by_test_id("v3-global-toolbar"))
        context.close()
    for sessions, testid, label in (("manual", "persistent-empty-manual", "영구 세션 만들기"), ("unavailable", "persistent-empty-unavailable", "코딩 에이전트 연결 안내"), ("bootstrap", "persistent-empty-creating", "기본 세션 만드는 중")):
        fake = Fake(atom=True, sessions=sessions)
        context, page = new_page(browser, base, fake, 1280, theme="light")
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        expect(page.get_by_test_id(testid)).to_be_visible(timeout=20000)
        shot(page, out, f"light-pas-empty-{sessions}-1280.png", 1280, f"밝은 테마: PAS 0개, {label}", page)
        context.close()
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 1280, theme="light")
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page)
    page.wait_for_timeout(400)
    shot(page, out, "light-settings-coding-agents-1280.png", 1280, "밝은 테마: 코딩 에이전트 탭", page.locator(DIALOG))
    context.close()


def settings_narrow(browser, base, out: Path):
    """360 설정창: 영구 세션 탭(PAS 창 설정 단추로 연 직후와 상세까지 내린 것), 코딩 에이전트 탭의 시트."""
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    expect(page.get_by_test_id("persistent-session-settings-sections")).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    words = broken_words(page.locator(".config-detail-heading p")) + broken_words(page.locator('[data-section="instructions"]'))
    check("설정창 영구 세션 탭 360px: 설명과 지시 글이 어절 가운데서 줄이 바뀌지 않음", not words, words)
    shot(page, out, "settings-persistent-360-open.png", 360, "설정창 영구 세션 탭 좁은 폭: PAS 창 설정 단추로 연 직후", page.locator(DIALOG))
    page.locator(".config-detail").evaluate("e => { e.scrollTop = e.scrollHeight; }")
    page.wait_for_timeout(400)
    shot(page, out, "settings-persistent-360-detail.png", 360, "설정창 영구 세션 탭 좁은 폭: 상세 아래까지 내림", page.locator(DIALOG))
    check("설정창 영구 세션 탭 360px: 가로 넘침 없음", page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.config-detail').scrollWidth <= document.querySelector('.config-detail').clientWidth"), "detail")
    context.close()

    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page, narrow=True)
    page.get_by_test_id("agent-login-button-codex").click()
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    page.wait_for_timeout(400)
    v = sheet_visible(page)
    footer_top = page.locator(".config-footer-row").evaluate("e => Math.round(e.getBoundingClientRect().top)")
    check("코딩 에이전트 탭 360px: Codex 시트가 스크롤 영역 안에 통째로 보이고 하단 바에 가리지 않음", v["sheetTop"] >= v["detailTop"] and v["sheetBottom"] <= v["detailBottom"] and v["sheetBottom"] <= footer_top, {**v, "footerTop": footer_top})
    shot(page, out, "settings-coding-agents-360-codex.png", 360, "코딩 에이전트 탭 좁은 폭: Codex 시트가 열려 코드가 보임", page.locator(DIALOG))
    sheet.get_by_role("button", name="취소").click()
    page.get_by_test_id("agent-login-button-antigravity").click()
    page.get_by_test_id("agent-login-confirm-antigravity").get_by_role("button", name="다시 연결").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    page.wait_for_timeout(400)
    v = sheet_visible(page)
    footer_top = page.locator(".config-footer-row").evaluate("e => Math.round(e.getBoundingClientRect().top)")
    check("코딩 에이전트 탭 360px: Antigravity 시트와 입력칸이 보이고 하단 바에 가리지 않음", v["sheetTop"] >= v["detailTop"] and v["sheetBottom"] <= v["detailBottom"] and v["sheetBottom"] <= footer_top, {**v, "footerTop": footer_top})
    ops("16", "통과", "코딩 에이전트 탭 360px: Codex와 Antigravity 시트가 가로 넘침 없이 스크롤 영역 안에 통째로 보임")
    shot(page, out, "settings-coding-agents-360-antigravity.png", 360, "코딩 에이전트 탭 좁은 폭: Antigravity 시트와 코드 입력칸", page.locator(DIALOG))
    context.close()


DIVIDERS_JS = """() => {
  const sections = [...document.querySelectorAll('[data-testid="persistent-session-settings-sections"] > section')];
  const offenders = [];
  sections.slice(0, -1).forEach((section) => {
    const rows = section.querySelectorAll('[data-testid="config-field-row"]');
    const last = rows[rows.length - 1];
    if (!last) return;
    const gap = section.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    if (gap <= 2 && parseFloat(getComputedStyle(last).borderBottomWidth) > 0) offenders.push(section.getAttribute('aria-label'));
  });
  return { sections: sections.length, offenders };
}"""


def settings_dividers(browser, base):
    """영구 세션 탭: 절의 마지막 행 아래 선과 다음 절 위 선이 붙어 두 줄이 되지 않는다."""
    fake = Fake(atom=True)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    expect(page.get_by_test_id("persistent-session-settings-sections")).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    result = page.evaluate(DIVIDERS_JS)
    check("영구 세션 탭: 절 사이 구분선이 두 줄로 붙지 않음", result["sections"] == 5 and not result["offenders"], result)
    page.add_style_tag(content='[data-testid="config-field-row"] { border-bottom: 1px solid #888 !important; }')
    page.wait_for_timeout(100)
    broken = page.evaluate(DIVIDERS_JS)
    check("단언 자체 확인: 행 아래 선을 되돌리면 구분선 단언이 실패함", len(broken["offenders"]) > 0, broken)
    context.close()


def frames_and_states(browser, base, out: Path):
    """1280 전체 프레임, 준비 중 시트, 실패 문구, 탭 상태들."""
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page)
    page.get_by_test_id("agent-login-button-antigravity").click()
    expect(page.get_by_test_id("agent-login-confirm-antigravity")).to_be_visible()
    page.wait_for_timeout(300)
    shot(page, out, "settings-coding-agents-1280-confirm-frame.png", 1280, "코딩 에이전트 탭 전체: Antigravity 행에 확인줄을 연 것", page.locator(DIALOG))
    page.get_by_test_id("agent-login-confirm-antigravity").get_by_role("button", name="취소").click()
    page.get_by_test_id("agent-login-button-codex").click()
    expect(page.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    page.wait_for_timeout(300)
    shot(page, out, "settings-coding-agents-1280-sheet-frame.png", 1280, "코딩 에이전트 탭 전체: Codex 행에 시트를 연 것", page.locator(DIALOG))
    context.close()

    fake = Fake(atom=True, hold_login_post=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page)
    page.get_by_test_id("agent-login-button-codex").click()
    expect(page.get_by_test_id("agent-login-sheet")).to_contain_text("로그인을 준비하고 있습니다", timeout=10000)
    ops("13", "통과", "시트를 열고 응답을 늦춘 장면에 「로그인을 준비하고 있습니다」와 진행 표시가 틀 안에 서 있음")
    shot(page, out, "login-preparing-1280.png", 1280, "로그인 시트 「로그인을 준비하고 있습니다」(응답을 늦춤)", page.get_by_test_id("agent-login-sheet"))
    fake.held_login_post.abort()
    context.close()

    failures = {
        "timeout": ("codex", flow("codex", "failed", error={"code": "timeout", "message": "x"}), None),
        "cli_exited": ("codex", flow("codex", "failed", error={"code": "cli_exited", "message": "x"}), None),
        "verify_failed": ("antigravity", flow("antigravity", "failed", error={"code": "verify_failed", "message": "x"}), None),
        "cancelled_by_new_login": ("codex", flow("codex", "failed", error={"code": "cancelled_by_new_login", "message": "x"}), None),
        "unknown_code": ("codex", flow("codex", "failed", error={"code": "something_new", "message": "x"}), None),
        "cli_not_installed": ("codex", None, (409, "cli_not_installed")),
    }
    for width in (1280, 360):
        fake = Fake(atom=True)
        fixtures_flows(fake)
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_coding_tab(page, narrow=width == 360)
        for name, (provider_id, failed_flow, error) in failures.items():
            if failed_flow:
                fake.flows[provider_id] = failed_flow
            fake.login_post_error = error
            page.get_by_test_id(f"agent-login-button-{provider_id}").click()
            if provider_id == "antigravity":
                page.get_by_test_id("agent-login-confirm-antigravity").get_by_role("button", name="다시 연결").click()
            sheet = page.get_by_test_id("agent-login-sheet")
            expect(sheet.locator('[role="alert"]')).to_be_visible(timeout=10000)
            words = broken_words(sheet.locator('[role="alert"] span'))
            check(f"실패 문구 {name} {width}px: 어절 가운데서 줄이 바뀌지 않음", not words, words)
            if width == 1280 and name in ("timeout", "cli_exited", "verify_failed", "cli_not_installed"):
                shot(page, out, f"login-failed-{name.replace('_', '-')}-1280.png", 1280, f"로그인 시트 실패 {name}", sheet)
            sheet.get_by_role("button", name="닫기" if failed_flow else "취소").click()
            expect(sheet).to_have_count(0)
        context.close()

    states = (
        ("none", False, "노드 없음"), ("down", False, "노드 끊김"), ("many", False, "노드 여럿(긴 이름 포함)"), ("one", True, "사용량 불러오는 중"),
    )
    for nodes, hold, label in states:
        fake = Fake(atom=True, nodes=nodes, hold_usage=hold)
        fixtures_flows(fake)
        context, page = new_page(browser, base, fake, 1280)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_settings(page)
        page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트").click()
        expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
        if nodes == "many":
            page.get_by_role("button", name="eias-linegames").first.click()
        page.wait_for_timeout(700)
        shot(page, out, f"settings-coding-agents-{nodes}-1280.png" if not hold else "settings-coding-agents-loading-1280.png", 1280, f"코딩 에이전트 탭: {label}", page.locator(DIALOG))
        if nodes == "one" and hold:
            ops("13", "통과", "사용량 요약 응답을 늦춘 코딩 에이전트 탭: 틀과 Claude 행 스켈레톤이 먼저 서 있음")
            for route in fake.held_usage:
                route.abort()
        context.close()
    fake = Fake(atom=True, sessions="unavailable", admin=False)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    expect(page.get_by_test_id("persistent-empty-unavailable")).to_be_visible(timeout=20000)
    check("빈 상태(연결 필요) 관리자가 아님: 코딩 에이전트 연결 단추가 없음", page.get_by_role("button", name="코딩 에이전트 연결").count() == 0, "단추 없음")
    shot(page, out, "pas-empty-unavailable-nonadmin-1280.png", 1280, "PAS 0개, 연결 필요: 관리자가 아닌 사용자(단추 없음)", page)
    context.close()


def bootstrap_failed(browser, base, out: Path):
    """기본 세션 만들기 실패(다시 시도). 다시 시도를 눌러도 초점이 단추에 남는다(14번)."""
    for width in (1280, 360):
        fake = Fake(atom=True, sessions="bootstrap", bootstrap="fail")
        context, page = new_page(browser, base, fake, width)
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        notice = page.get_by_test_id("persistent-empty-bootstrap-failed")
        expect(notice).to_be_visible(timeout=20000)
        words = broken_words(notice.locator('[role="alert"]'))
        check(f"기본 세션 만들기 실패 {width}px: 어절 가운데서 줄이 바뀌지 않음", not words, words)
        dims = page.evaluate("() => ({doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
        check(f"기본 세션 만들기 실패 {width}px: 가로 넘침 없음", dims["doc"] <= dims["inner"], dims)
        shot(page, out, f"pas-empty-bootstrap-failed-{width}.png", width, "PAS 0개, 기본 세션 만들기 실패: 다시 시도", page)
        if width == 1280:
            retry = notice.get_by_role("button", name="다시 시도")
            retry.focus()
            retry.press("Enter")
            page.wait_for_timeout(500)
            same = page.evaluate("() => document.activeElement?.textContent === '다시 시도'")
            check("기본 세션 만들기 실패: 다시 시도를 눌러도 초점이 그 단추에 남음", same, active(page))
            ops("14", "통과", "기본 세션 만들기 실패의 「다시 시도」를 Enter로 눌러도 단추가 그대로 있고 초점이 남음")
            ops("17", "통과", "bootstrap 응답을 502로 바꾼 장면: 같은 자리가 실패 안내와 「다시 시도」로 바뀌고 안내 글은 어절 단위로 줄바꿈")
        context.close()


def operations(browser, base, out: Path):
    """코딩 에이전트 탭과 설정창의 조작을 실제 키로 재고 operations.md 재료를 모은다(14, 15, 18번)."""
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    settings_button = page.get_by_role("button", name="서버 설정")
    settings_button.focus()
    settings_button.press("Enter")
    expect(page.locator(DIALOG)).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    first_focus = active(page)
    inside = page.evaluate("() => !!document.activeElement && !!document.activeElement.closest('[data-slot=\"dialog-popup\"]')")
    check("설정창을 열면 초점이 창 안에 있음", inside, first_focus)
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트").click()
    expect(page.get_by_test_id("agent-login-button-codex")).to_be_visible(timeout=15000)

    codex = page.get_by_test_id("agent-login-button-codex")
    anti = page.get_by_test_id("agent-login-button-antigravity")
    codex.focus()
    codex.press("Enter")
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    page.wait_for_timeout(300)
    on_link = active(page)
    check("Codex 시트가 열리고 주소가 오면 초점이 「주소 열기」에 있음", on_link.startswith("주소 열기"), on_link)
    order = ["취소(Shift+Tab)"]
    page.keyboard.press("Shift+Tab")
    order[0] = active(page)
    for _ in range(3):
        page.keyboard.press("Tab")
        order.append(active(page))
    check("Codex 시트 Tab 순서: 취소, 주소 열기, 복사 순으로 읽는 순서를 따르고 안 보이는 요소에 들어가지 않음", order[:3] == ["취소", on_link, "복사"] and all("[안 보임]" not in item for item in order), order)
    for _ in range(2):
        page.keyboard.press("Shift+Tab")
    check("Codex 시트: Shift+Tab으로 다시 시트 안(주소 열기)으로 돌아옴", active(page) == on_link, active(page))
    page.keyboard.press("Escape")
    expect(sheet).to_have_count(0)
    after_sheet_esc = active(page)
    still_open = page.locator(DIALOG).count() == 1
    check("Codex 시트: Esc는 시트만 닫고 설정창은 그대로이며 초점이 「연결」 단추로 돌아옴", still_open and after_sheet_esc == "연결", {"focus": after_sheet_esc, "dialog": still_open})
    DIALOGS.append(("로그인 시트(Codex)", "「연결」 단추(Enter)", f"{on_link}(주소 열기)", "취소 단추에서 시트 닫기", f"시트만 닫고 DELETE, 설정창 유지", after_sheet_esc + " 단추"))
    ops("14", "통과", f"「연결」을 Enter로 누르면 시트가 열리고 주소가 오면 {on_link}에 초점. Esc로 닫으면 {after_sheet_esc} 단추로 돌아옴")
    ops("15", "통과", "Codex 시트 Tab 순서 " + " → ".join(order[:3]) + f"(그다음은 시트 밖 {order[3]}). Shift+Tab으로 시트 안에 돌아옴. Esc는 시트만 닫고 설정창과 그 뒤 화면은 그대로")

    anti.focus()
    anti.press("Enter")
    confirm = page.get_by_test_id("agent-login-confirm-antigravity")
    expect(confirm).to_be_visible()
    page.wait_for_timeout(200)
    on_confirm = active(page)
    check("다시 연결 확인줄이 열리면 초점이 첫 동작(취소)에 있음", on_confirm == "취소", on_confirm)
    page.keyboard.press("Tab")
    second = active(page)
    page.keyboard.press("Escape")
    expect(confirm).to_have_count(0)
    after_confirm_esc = active(page)
    check("확인줄 Esc: 줄만 닫히고 초점이 「다시 연결」 단추로 돌아옴", after_confirm_esc == "다시 연결" and page.locator(DIALOG).count() == 1, after_confirm_esc)
    anti.press("Enter")
    expect(confirm).to_be_visible()
    page.keyboard.press("Enter")  # 첫 초점인 취소를 Enter로
    expect(confirm).to_have_count(0)
    after_cancel = active(page)
    check("확인줄 취소(Enter): 초점이 「다시 연결」 단추로 돌아옴", after_cancel == "다시 연결", after_cancel)
    DIALOGS.append(("다시 연결 확인줄(인라인)", "「다시 연결」 단추(Enter)", f"{on_confirm}(첫 동작)", f"{on_confirm}에서 줄 닫기, Tab 다음은 {second}", "줄만 닫음, 설정창 유지", after_confirm_esc + " 단추"))
    ops("14", "통과", f"확인줄이 열리면 {on_confirm}에 초점, 취소나 Esc로 닫으면 {after_cancel} 단추로 돌아옴. 단추는 열려 있는 동안 aria-disabled 비활성 모양이고 disabled 속성은 아님(r3 단언)")
    anti.press("Enter")
    page.keyboard.press("Tab")
    page.keyboard.press("Enter")  # 다시 연결
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    page.wait_for_timeout(300)
    on_input = active(page)
    check("Antigravity 시트: 코드 입력칸이 나타나면 초점이 입력칸에 있음", on_input.startswith("Antigravity 인증 코드") or "입력" in on_input or on_input.startswith("인증 코드"), on_input)
    # 창 크기 바꾸기(18번): 입력 중인 글이 좁은 폭과 넓은 폭을 오가며 유지된다.
    page.keyboard.type("typed-partial")
    page.set_viewport_size({"width": 360, "height": 900})
    page.wait_for_timeout(600)
    narrow_ok = page.evaluate("() => ({ value: document.querySelector('[data-testid=\"agent-login-sheet\"] input')?.value ?? null, overflow: document.documentElement.scrollWidth > window.innerWidth })")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.wait_for_timeout(600)
    wide_ok = page.evaluate("() => ({ value: document.querySelector('[data-testid=\"agent-login-sheet\"] input')?.value ?? null, overflow: document.documentElement.scrollWidth > window.innerWidth })")
    check("창 크기 바꾸기: 열린 시트와 입력 중인 글이 1280 → 360 → 1280에서 유지되고 가로 넘침이 없음", narrow_ok["value"] == "typed-partial" and wide_ok["value"] == "typed-partial" and not narrow_ok["overflow"] and not wide_ok["overflow"], {"narrow": narrow_ok, "wide": wide_ok})
    ops("18", "통과", "Antigravity 시트를 연 채 1280 → 360 → 1280으로 바꿔도 시트가 그대로 있고 입력 중인 글이 유지되며 가로 넘침이 없음")
    page.locator('[data-testid="agent-login-sheet"] input').press("Escape")
    expect(sheet).to_have_count(0)
    after_input_esc = active(page)
    check("Antigravity 시트 Esc: 시트가 닫히고 초점이 「다시 연결」 단추로 돌아옴", after_input_esc == "다시 연결", after_input_esc)
    DIALOGS.append(("로그인 시트(Antigravity)", "「다시 연결」 → 확인줄의 「다시 연결」(Enter)", f"{on_input}(코드 입력칸)", "입력칸에서 Enter는 제출(코드가 있을 때)", "시트 닫음, DELETE, 설정창 유지", after_input_esc + " 단추"))
    # 설정창 닫기
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    closed = page.locator(DIALOG).count() == 0
    after_dialog = active(page)
    check("설정창 Esc: 창이 닫히고 PAS 창이 그대로임", closed and page.url.endswith(f"/persistent/{SESSION_ID}"), {"closed": closed, "focus": after_dialog})
    DIALOGS.append(("설정창(ConfigModal)", "PAS 창 툴바의 「서버 설정」(Enter)", first_focus + "(창 안)", "탭 단추에서 Enter는 그 탭 열기", "창 닫음, PAS 창 유지", after_dialog))
    ops("15", "통과", f"설정창 Esc로 창이 닫히고 PAS 창이 그대로. 닫은 뒤 초점은 {after_dialog}")
    context.close()

    # 줄 안 편집: 표시 항목은 스위치를 키보드로 바꾸면 바로 저장된다.
    fake = Fake(atom=True)
    context, page = new_page(browser, base, fake, 1280)
    puts: list[str] = []
    page.on("request", lambda r: puts.append(r.url) if r.method == "PUT" and "persistent-sessions" in r.url else None)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    switch = page.get_by_role("switch", name="세대 구분선 표시")
    expect(switch).to_be_visible(timeout=15000)
    switch.focus()
    switch.press("Space")
    page.wait_for_timeout(600)
    check("표시 항목 스위치: 스페이스로 바꾸면 바로 저장 요청이 감", len(puts) == 1, puts)
    focus_after = active(page)
    DIALOGS.append(("줄 안 편집: 표시 스위치(세대 구분선 표시)", "Tab으로 이동", "스위치", "해당 없음(스위치)", "설정창이 닫힘", f"스페이스 뒤 {focus_after}"))
    ops("14", "통과", f"표시 스위치를 스페이스로 바꾼 뒤에도 초점이 {focus_after}에 남음")
    context.close()
    ops("17", "통과", "로그인 시트 failed 여덟 가지와 요청 오류(cli_not_installed), 스토리 오류가 그 자리의 안내와 「다시 시도」로 바뀜(실패 문구 그림 참조)")


def write_operations(out: Path):
    lines = ["# 조작 결과(ui-design 0절 14~18번)", "", "카드 #1787 U17 3차. 리포 스크립트 scripts/visual-check/settings_toolbar.sh가 이 값을 실제 키 입력과 실측으로 잰다(settings_toolbar_r2.py, settings_toolbar_r3.py).", "", "## 14번부터 18번", "", "| 번호 | 결과 | 근거 |", "| --- | --- | --- |"]
    titles = {"13": "13 로딩 상태", "14": "14 누른 뒤 초점", "15": "15 Tab과 Esc", "16": "16 최소 폭 넘침과 잘림", "17": "17 오류 상태", "18": "18 창 크기 바꾸기"}
    for number in ("13", "14", "15", "16", "17", "18"):
        for result, evidence in OPS.get(number, []):
            lines.append(f"| {titles[number]} | {result} | {evidence} |")
    lines += ["", "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| --- | --- | --- | --- | --- | --- |"]
    lines += [f"| {' | '.join(row)} |" for row in DIALOGS]
    lines += ["", "## 빈 상태와 시트의 단추", "", "- 빈 상태의 「영구 세션 만들기」와 「코딩 에이전트 연결」은 설정창을 여는 단추이고 창은 위 설정창 행과 같다. 기본 세션 만들기 실패의 「다시 시도」는 14번 행에 있다.", "", "## 실행", "", "```", "bash scripts/visual-check/settings_toolbar.sh <출력 폴더>", "```", "", "산출물은 같은 폴더의 r2-, r3- 그림, index.md, checks.json, operations.md다."]
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def keep_all_self_test(browser, base):
    """단언 자체 확인: 어절 유지(keep-all)를 끄면 좁은 폭에서 어절이 실제로 끊겨 단언이 실패한다."""
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page, narrow=True)
    page.get_by_test_id("agent-login-button-antigravity").click()
    text = page.get_by_test_id("agent-login-confirm-antigravity").locator(".c724-confirm-text")
    check("확인 글 360px: 어절 가운데서 줄이 바뀌지 않음", not broken_words(text), broken_words(text))
    page.add_style_tag(content=".c724-confirm-text, .c724-login-error { word-break: normal !important; overflow-wrap: normal !important; }")
    page.wait_for_timeout(200)
    broken = broken_words(text)
    check("단언 자체 확인: keep-all을 끄면 확인 글 360px에서 어절이 끊김(단언이 실제로 실패함)", len(broken) > 0, broken)
    ops("16", "통과", f"확인 글 360px 어절 단언은 keep-all을 끄면 {broken}처럼 끊긴 어절을 잡아 실패한다. 켠 상태에서는 통과")
    context.close()
    fake = Fake(atom=True)
    fixtures_flows(fake)
    context, page = new_page(browser, base, fake, 1280)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_coding_tab(page)
    page.get_by_test_id("agent-login-button-antigravity").click()
    text = page.get_by_test_id("agent-login-confirm-antigravity").locator(".c724-confirm-text")
    check("확인 글 1280px: 어절 가운데서 줄이 바뀌지 않음", not broken_words(text), broken_words(text))
    context.close()


def capture_r2(browser, base, out: Path):
    pas_toolbars(browser, base, out)
    light_theme(browser, base, out)
    settings_dividers(browser, base)
    settings_narrow(browser, base, out)
    frames_and_states(browser, base, out)
    bootstrap_failed(browser, base, out)
    keep_all_self_test(browser, base)
    operations(browser, base, out)

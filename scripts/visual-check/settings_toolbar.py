#!/usr/bin/env python3
"""Capture the PAS first window, the merged settings window, the coding agents tab, and the toolbar with fake responses.

카드 #1787 U17. 기준선(merge-base 빌드)이 있는 화면은 같은 이름 규칙으로 baseline- 접두어를 붙여 함께 찍는다.
가짜 응답과 공용 도구는 settings_toolbar_fakes.py, 2차 보강 그림은 settings_toolbar_r2.py에 있다.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from settings_toc import capture_settings_toc, measure_direct_open, measure_operations, write_operations as write_toc_operations  # noqa: E402
from settings_toolbar_r2 import capture_r2, write_operations  # noqa: E402
from settings_toolbar_r3 import capture_r3  # noqa: E402
from settings_toolbar_fakes import CHECKS, INDEX, Fake, SESSION_ID, FAKE_PASTED_CODE, FAKE_USER_CODE, assert_no_secret_output, check, DIST, flow, listen, new_page, open_settings, serve, shot, soon, toolbar_metrics, wait_for_call  # noqa: E402

def capture_toolbars(browser, base, out: Path, prefix: str, atom_expected: bool):
    """PAS 창 툴바 360, 768, 1280과 기존 대시보드 툴바 360, 1280. atom 단추 유무와 넘침, 단추 크기를 잰다."""
    for width in (360, 768, 1280):
        # 영구 세션이 둘이면 세션 바꾸기 단추까지 보여 가장 단추가 많은 경우가 된다.
        fake = Fake(atom=True, sessions="two")
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        metrics = toolbar_metrics(page, '[data-testid="v3-global-toolbar"]')
        atom_buttons = [b for b in metrics["buttons"] if b["label"] == "atom 열기"]
        if prefix == "":
            check(f"PAS 창 툴바 {width}px atom 단추 {'있음' if atom_expected else '없음'}", bool(atom_buttons) == atom_expected, metrics)
            check(f"PAS 창 툴바 {width}px 가로 넘침 없음", metrics["scrollWidth"] <= metrics["clientWidth"] and metrics["docScrollWidth"] <= metrics["innerWidth"], metrics)
            check(f"PAS 창 툴바 {width}px 단추 40x40 이상", all(b["width"] >= 40 and b["height"] >= 40 for b in metrics["buttons"]), metrics)
        shot(page, out, f"{prefix}pas-toolbar-{width}.png", width, f"PAS 창 툴바, atom {'있음' if atom_expected else '없음'}", page.get_by_test_id("v3-global-toolbar"))
        context.close()
    for width in (360, 1280):
        fake = Fake(atom=True)
        context, page = new_page(browser, base, fake, width, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
        page.goto(base + "/", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(600)
        metrics = toolbar_metrics(page, '[data-testid="v3-global-toolbar"]')
        if prefix == "":
            check(f"대시보드 툴바 {width}px atom 단추 {'있음' if atom_expected else '없음'}", bool([b for b in metrics["buttons"] if b["label"] == "atom 열기"]) == atom_expected, metrics)
            check(f"대시보드 툴바 {width}px 가로 넘침 없음", metrics["scrollWidth"] <= metrics["clientWidth"] and metrics["docScrollWidth"] <= metrics["innerWidth"], metrics)
            check(f"대시보드 툴바 {width}px 단추 40x40 이상", all(b["width"] >= 40 and b["height"] >= 40 for b in metrics["buttons"]), metrics)
        shot(page, out, f"{prefix}dashboard-toolbar-{width}.png", width, "기존 대시보드 툴바", page.get_by_test_id("v3-global-toolbar"))
        context.close()



def capture_settings_and_logins(browser, base, out: Path):
    """설정창 persistent 탭(PAS를 고른 채), coding_agents 탭, 로그인 시트 각 상태."""
    width = 1280
    fake = Fake(atom=True)
    fake.flows = {
        "codex": flow("codex", "url_ready", auth_url="https://auth.example.invalid/codex/device", user_code=FAKE_USER_CODE, expires_at=soon()),
        "antigravity": flow("antigravity", "url_ready", auth_url="https://auth.example.invalid/antigravity/oauth"),
    }
    fake.after_code = {"antigravity": flow("antigravity", "verifying")}
    context, page = new_page(browser, base, fake, width)
    sink: list[str] = []
    listen(page, sink)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    dialog = page.locator('[data-slot="dialog-popup"]')
    tab = page.get_by_test_id("persistent-sessions-tab")
    expect(tab).to_be_visible(timeout=15000)
    sections = page.get_by_test_id("persistent-session-settings-sections")
    expect(sections).to_be_visible(timeout=15000)
    labels = sections.locator("> section").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
    check("설정창 persistent 탭: 요청한 PAS를 고른 채 다섯 절이 모두 보임", labels == ["지속 지시", "계정과 모델", "표시와 모션", "기록", "세션 스토리"], labels)
    check("설정창 persistent 탭: 새 세션 양식이 아님", tab.get_by_text("세션 추가").count() == 0, "세션 추가 단추 없음")
    page.wait_for_timeout(500)
    shot(page, out, "settings-persistent-top-1280.png", width, "설정창 영구 세션 탭, PAS를 고른 채 열림(위쪽)", dialog)
    page.locator(".config-detail").evaluate("e => { e.scrollTop = e.scrollHeight; }")
    page.wait_for_timeout(300)
    shot(page, out, "settings-persistent-bottom-1280.png", width, "설정창 영구 세션 탭(아래쪽: 기록과 세션 스토리)", dialog)
    dialog.get_by_role("button", name="완료").click()
    expect(dialog).to_have_count(0)
    check("설정창을 닫으면 PAS 창에 그대로 있음", page.url.endswith(f"/persistent/{SESSION_ID}"), page.url)

    open_settings(page)
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트 연결", exact=True).click()
    expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
    expect(page.get_by_test_id("agent-login-button-codex")).to_have_text("연결", timeout=15000)
    expect(page.get_by_test_id("agent-login-button-antigravity")).to_have_text("다시 연결")
    page.wait_for_timeout(400)
    shot(page, out, "settings-coding-agents-1280.png", width, "코딩 에이전트 탭: Codex 연결 안 됨(연결), Antigravity 연결됨(다시 연결)", dialog)

    # Codex: 주소 열기 단추, 고정폭 코드, 복사, 남은 시간
    page.get_by_test_id("agent-login-button-codex").click()
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_have_text(FAKE_USER_CODE, timeout=10000)
    link = sheet.get_by_role("link", name="주소 열기")
    check("Codex 시트: 주소 열기가 새 탭, noopener", link.get_attribute("target") == "_blank" and "noopener" in (link.get_attribute("rel") or ""), link.get_attribute("rel"))
    shot(page, out, "login-codex-url-ready-1280.png", width, "로그인 시트 Codex: 주소 열기와 코드", sheet)
    sheet.get_by_role("button", name="취소").click()
    expect(sheet).to_have_count(0)

    # Codex 실패: device_code_disabled
    fake.flows["codex"] = flow("codex", "failed", error={"code": "device_code_disabled", "message": "x"})
    page.get_by_test_id("agent-login-button-codex").click()
    expect(sheet.locator('[role="alert"]')).to_contain_text("ChatGPT 설정의 보안 항목에서 Codex 기기 코드 인증을 켠 뒤 다시 시도해 주세요.", timeout=10000)
    shot(page, out, "login-failed-device-code-1280.png", width, "로그인 시트 실패 device_code_disabled", sheet)
    sheet.get_by_role("button", name="닫기").click()
    expect(sheet).to_have_count(0)

    # Antigravity: 다시 연결은 확인을 한 번 받는다
    posts_at_confirm = fake.login_posts
    page.get_by_test_id("agent-login-button-antigravity").click()
    confirm = page.get_by_test_id("agent-login-confirm-antigravity")
    expect(confirm).to_be_visible()
    page.wait_for_timeout(300)
    check("다시 연결: 확인 전에는 로그인을 시작하지 않음", fake.login_posts == posts_at_confirm, fake.login_posts)
    shot(page, out, "login-antigravity-confirm-1280.png", width, "다시 연결 확인줄", confirm)
    confirm.get_by_role("button", name="다시 연결").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    shot(page, out, "login-antigravity-url-ready-1280.png", width, "로그인 시트 Antigravity: 주소 열기와 코드 입력칸", sheet)
    sheet.get_by_label("Antigravity 인증 코드").fill(FAKE_PASTED_CODE)
    sheet.get_by_role("button", name="제출").click()
    expect(sheet.get_by_text("사용량을 확인하고 있습니다")).to_be_visible(timeout=10000)
    check("제출한 코드는 화면에 남지 않음", FAKE_PASTED_CODE not in page.content(), "DOM에 없음")
    shot(page, out, "login-verifying-1280.png", width, "로그인 시트 확인 중", sheet)
    fake.flows["antigravity"] = flow("antigravity", "done")
    expect(sheet.get_by_text("연결되었습니다")).to_be_visible(timeout=10000)
    shot(page, out, "login-done-1280.png", width, "로그인 시트 연결되었습니다", sheet)
    sheet.get_by_role("button", name="닫기").click()

    # Antigravity 코드 거절: invalid_code
    fake.flows["antigravity"] = flow("antigravity", "url_ready", auth_url="https://auth.example.invalid/antigravity/oauth")
    fake.after_code = {"antigravity": flow("antigravity", "failed", error={"code": "invalid_code", "message": "x"})}
    page.get_by_test_id("agent-login-button-antigravity").click()
    page.get_by_test_id("agent-login-confirm-antigravity").get_by_role("button", name="다시 연결").click()
    sheet.get_by_label("Antigravity 인증 코드").fill(FAKE_PASTED_CODE)
    sheet.get_by_role("button", name="제출").click()
    expect(sheet.locator('[role="alert"]')).to_contain_text("인증 코드가 맞지 않습니다. 다시 시도하면 새 주소가 열립니다.", timeout=10000)
    shot(page, out, "login-failed-invalid-code-1280.png", width, "로그인 시트 실패 invalid_code", sheet)
    posts_before = fake.login_posts
    fake.flows["antigravity"] = flow("antigravity", "url_ready", login_id="fake-login-antigravity-2", auth_url="https://auth.example.invalid/antigravity/oauth-2")
    sheet.get_by_role("button", name="다시 시도").click()
    expect(sheet.get_by_label("Antigravity 인증 코드")).to_be_visible(timeout=10000)
    check("invalid_code 뒤 다시 시도는 새 흐름을 시작함", fake.login_posts == posts_before + 1, fake.login_posts)
    assert_no_secret_output(sink, "설정창 로그인 흐름")
    context.close()

    # 좁은 폭에서도 로그인 시트가 넘치지 않는다.
    fake = Fake(atom=True)
    fake.flows = {"codex": flow("codex", "url_ready", auth_url="https://auth.example.invalid/codex/device", user_code=FAKE_USER_CODE, expires_at=soon()), "antigravity": flow("antigravity", "url_ready")}
    context, page = new_page(browser, base, fake, 360)
    page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    open_settings(page)
    page.get_by_role("button", name="모든 설정").click()  # 좁은 폭은 한 칸씩 보인다.
    page.locator('[data-testid="config-category-nav"]').get_by_role("button", name="코딩 에이전트 연결", exact=True).click()
    page.get_by_test_id("agent-login-button-codex").click()
    sheet = page.get_by_test_id("agent-login-sheet")
    expect(sheet.get_by_test_id("agent-login-user-code")).to_be_visible(timeout=10000)
    dims = sheet.evaluate("e => ({scroll: e.scrollWidth, client: e.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
    check("로그인 시트 360px 가로 넘침 없음", dims["scroll"] <= dims["client"] and dims["doc"] <= dims["inner"], dims)
    shot(page, out, "login-codex-url-ready-360.png", 360, "로그인 시트 Codex, 좁은 폭", page.locator('[data-slot="dialog-popup"]'))
    context.close()


def capture_empty_states(browser, base, out: Path, prefix: str):
    """PAS가 0개일 때의 세 경우와 만드는 중. 기준선은 설정창이 자동으로 열리던 화면이다."""
    width = 1280
    if prefix:
        fake = Fake(atom=False, sessions="manual")
        context, page = new_page(browser, base, fake, width)
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        expect(page.locator('[data-slot="dialog-popup"]')).to_be_visible(timeout=20000)
        page.wait_for_timeout(500)
        shot(page, out, f"{prefix}pas-empty-1280.png", width, "PAS 0개: 설정창이 자동으로 열림(기준선)", page)
        context.close()
        fake = Fake(atom=False)
        context, page = new_page(browser, base, fake, width)
        page.goto(base + f"/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_settings(page)
        expect(page.locator('[data-testid="persistent-session-settings-dialog"]')).to_be_visible(timeout=15000)
        page.wait_for_timeout(800)
        shot(page, out, f"{prefix}settings-persistent-1280.png", width, "PAS 설정 대화창(기준선)", page.locator('[data-slot="dialog-popup"]'))
        context.close()
        return

    # 만들 수 없는 설정(bootstrap 꺼짐): 영구 세션 만들기
    fake = Fake(atom=True, sessions="manual")
    context, page = new_page(browser, base, fake, width)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    expect(page.get_by_test_id("persistent-empty-manual")).to_be_visible(timeout=20000)
    check("빈 상태(bootstrap 꺼짐): 설정창이 저절로 열리지 않음", page.locator('[data-slot="dialog-popup"]').count() == 0, "설정창 없음")
    check("빈 상태(bootstrap 꺼짐): bootstrap을 부르지 않음", ("POST", "/api/persistent-sessions/bootstrap") not in fake.calls, fake.calls[-5:])
    shot(page, out, "pas-empty-manual-1280.png", width, "PAS 0개, bootstrap 꺼짐: 영구 세션 만들기", page)
    page.get_by_role("button", name="영구 세션 만들기").click()
    expect(page.get_by_test_id("persistent-sessions-tab")).to_be_visible(timeout=15000)
    expect(page.get_by_text("새 영구 에이전트 세션").first).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    shot(page, out, "pas-empty-manual-create-1280.png", width, "영구 세션 만들기를 누르면 설정창의 생성 양식", page.locator('[data-slot="dialog-popup"]'))
    context.close()

    # 켜졌지만 모델이 없음: 코딩 에이전트 연결 안내
    for narrow in (1280, 360):
        fake = Fake(atom=True, sessions="unavailable")
        context, page = new_page(browser, base, fake, narrow)
        page.goto(base + "/persistent", wait_until="domcontentloaded")
        expect(page.get_by_test_id("persistent-empty-unavailable")).to_be_visible(timeout=20000)
        check(f"빈 상태(연결 필요) {narrow}px: bootstrap을 부르지 않음", ("POST", "/api/persistent-sessions/bootstrap") not in fake.calls, fake.calls[-5:])
        dims = page.evaluate("() => ({doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
        check(f"빈 상태(연결 필요) {narrow}px: 가로 넘침 없음", dims["doc"] <= dims["inner"], dims)
        shot(page, out, f"pas-empty-unavailable-{narrow}.png", narrow, "PAS 0개, 연결 필요: 코딩 에이전트 연결 안내(관리자)", page)
        if narrow == 1280:
            page.get_by_role("button", name="코딩 에이전트 연결").click()
            expect(page.get_by_test_id("coding-agents-tab")).to_be_visible(timeout=15000)
            page.wait_for_timeout(400)
            shot(page, out, "pas-empty-unavailable-connect-1280.png", narrow, "코딩 에이전트 연결을 누르면 설정창의 코딩 에이전트 탭", page.locator('[data-slot="dialog-popup"]'))
            fake.sessions = "bootstrap"
            page.locator('[data-slot="dialog-popup"]').get_by_role("button", name="완료").click()
            expect(page.get_by_test_id("persistent-empty-creating")).to_be_visible(timeout=15000)
            check("설정창을 닫은 뒤 목록을 다시 읽고 기본 세션 만들기로 이어짐", wait_for_call(page, fake, ("POST", "/api/persistent-sessions/bootstrap")), fake.calls[-6:])
            fake.held_bootstrap.abort()  # 붙잡아 둔 요청을 놓아야 닫을 때 정리 오류가 나지 않는다.
        context.close()

    # 기본 세션 만드는 중, 그리고 성공하면 그 세션으로 이동
    fake = Fake(atom=True, sessions="bootstrap")
    context, page = new_page(browser, base, fake, width)
    page.goto(base + "/persistent", wait_until="domcontentloaded")
    creating = page.get_by_test_id("persistent-empty-creating")
    expect(creating).to_contain_text("기본 영구 세션을 만드는 중입니다", timeout=20000)
    wait_for_call(page, fake, ("POST", "/api/persistent-sessions/bootstrap"))
    page.wait_for_timeout(300)  # 두 번째 요청이 뒤따르는지 잠시 더 본다.
    posts = [call for call in fake.calls if call == ("POST", "/api/persistent-sessions/bootstrap")]
    check("빈 상태(기본 세션): bootstrap을 한 번만 부름", len(posts) == 1, len(posts))
    shot(page, out, "pas-empty-creating-1280.png", width, "PAS 0개, bootstrap 켜짐: 기본 영구 세션을 만드는 중", page)
    fake.sessions = "one"
    fake.held_bootstrap.fulfill(status=201, json={"created": True, "session_id": SESSION_ID})
    page.wait_for_url(f"**/persistent/{SESSION_ID}", timeout=15000)
    check("기본 세션을 만들면 그 세션으로 옮김", page.url.endswith(f"/persistent/{SESSION_ID}"), page.url)
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline-dist", required=True)
    parser.add_argument("--only-r2", action="store_true", help="2차와 3차 보강 그림과 조작 결과만 찍는다(반복 확인용)")
    parser.add_argument("--only-r3", action="store_true", help="3차 보강 그림만 찍는다(조작 결과 파일은 쓰지 않는다)")
    parser.add_argument("--only-toc", action="store_true", help="카드 #1883 설정창 목차만 이전 빌드(baseline-)와 이번 빌드로 찍고 조작 결과(operations.md)를 쓴다")
    parser.add_argument("--dist", default=None, help="찍을 빌드 폴더. 고치기 전 코드의 빌드를 줘서 3차 단언이 실패하는지 볼 때 쓴다")
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not args.only_toc:
        keep_first_round(out)
    server, base = serve(Path(args.dist) if args.dist else DIST)
    baseline_server, baseline_base = serve(Path(args.baseline_dist))
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            if args.only_toc:
                capture_settings_toc(browser, baseline_base, out, "baseline-")
                capture_settings_toc(browser, base, out, "")
                measure_operations(browser, base)
                measure_direct_open(browser, base, out)
                browser.close()
                write_toc_operations(out)
                (out / "checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")
                return
            if args.only_r3:
                capture_r3(browser, base, out)
                browser.close()
                return
            if not args.only_r2:
                capture_toolbars(browser, baseline_base, out, "baseline-", atom_expected=False)
                capture_empty_states(browser, baseline_base, out, "baseline-")
                capture_toolbars(browser, base, out, "", atom_expected=True)
                capture_settings_and_logins(browser, base, out)
                capture_empty_states(browser, base, out, "")
            capture_r2(browser, base, out)
            capture_r3(browser, base, out)
            write_operations(out)
            browser.close()
    finally:
        server.shutdown()
        baseline_server.shutdown()
    write_index(out)


def keep_first_round(out: Path):
    """1차 index.md와 checks.json은 이름을 바꿔 남기고, 1차 그림 파일은 그대로 둔다."""
    for name, kept in (("index.md", "index-r1.md"), ("checks.json", "checks-r1.json")):
        path = out / name
        if path.exists() and not (out / kept).exists():
            path.rename(out / kept)


def write_index(out: Path):
    lines = ["# 카드 #1787 U17 화면 캡처(3차)", "", "r3- 접두어가 3차, r2- 접두어가 2차 그림이다. 1차 그림은 접두어 없이 같은 폴더에 남아 있고 목록은 index-r1.md, 1차 단언은 checks-r1.json에 있다.",
             "조작 결과(ui-design 14~18번, 대화상자 표)는 operations.md에 있다.", "", "| 파일 | 폭(px) | 상태 |", "| --- | ---: | --- |"]
    lines += [f"| {name} | {width} | {state} |" for name, width, state in INDEX]
    lines += ["", "## 실측 단언", ""]
    lines += [f"- {'통과' if item['ok'] else '실패'}: {item['check']}" for item in CHECKS]
    (out / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

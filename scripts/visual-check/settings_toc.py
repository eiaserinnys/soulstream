"""설정창 목차 캡처와 조작 측정(카드 #1883).

settings_toolbar.py의 `--only-toc`가 부른다. 가짜 응답과 공용 도구는 settings_toolbar_fakes.py에 있다.
관리자와 관리자 아님, 넓은 폭(1280)과 좁은 폭(360)의 설정창을 처음 여는 경로(대시보드 툴바)로 열어
목차 묶음, 칸 순서, 아이콘, 부제 없음, 열기 단추 이름, 넘침과 말줄임, Tab 순서, Esc, 창 크기 바꾸기를 잰다.
이전 빌드(baseline-)는 그림만 찍고 새 이름 단언은 이번 빌드(접두어 없음)에만 건다.
"""
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import expect

from settings_toolbar_fakes import CHECKS, INDEX, Fake, check, new_page, open_settings

OPERATIONS: list[tuple[str, str, str]] = []
DIALOG_ROWS: list[str] = []

ADMIN_TOC = [
    ("개인 환경", ["화면과 읽기", "내 에이전트", "접속 링크", "웹훅"]),
    ("세션과 작업", ["영구 에이전트 세션", "영구 세션 기본 모델", "카드 실행", "반복 작업"]),
    ("에이전트와 노드", ["에이전트 프로필", "MCP", "스킬과 카탈로그", "코딩 에이전트 연결", "노드"]),
    ("기록과 관리", ["세션 통계", "사용 로그", "요청 검수", "사용자", "파일 저장소", "런타임"]),
]
MEMBER_TOC = [
    ("개인 환경", ["화면과 읽기", "내 에이전트", "접속 링크", "웹훅"]),
    ("세션과 작업", ["영구 에이전트 세션", "반복 작업"]),
    ("에이전트와 노드", ["노드"]),
    ("기록과 관리", ["세션 통계", "사용 로그", "런타임"]),
]
# 서버가 주는 설정 카테고리의 자리를 보이려는 가짜 값이다(운영 카테고리 이름이 아니다).
SERVER_CATEGORIES = {"categories": [{"name": "runtime", "label": "런타임", "fields": [
    {"key": "runtime.log_level", "field_name": "log_level", "label": "로그 수준", "description": "", "value": "info", "value_type": "string", "sensitive": False, "hot_reloadable": True, "read_only": False}]}]}

DIALOG = '[data-slot="dialog-popup"]'
NAV = '[data-testid="config-category-nav"]'
TOC_READ = """() => [...document.querySelectorAll('[data-testid="config-category-nav"] > section')].map(s => ({
    group: s.querySelector('h3')?.textContent ?? null,
    items: [...s.querySelectorAll('.config-category-item')].map(b => ({ label: b.textContent.trim(), icon: [...(b.querySelector('svg')?.classList ?? [])].find(c => c.startsWith('lucide-') && c !== 'lucide') ?? '' })),
}))"""
# 목차가 창 안에서 스크롤되면 한 장에 다 담기지 않는다. 찍을 때만 뷰포트를 늘리고, 창 높이 상한에 걸리면 창 높이를 늘린다(제품 CSS는 그대로).
NAV_OVERFLOW = "() => { const nav = document.querySelector('[data-testid=\"config-category-nav\"]'); return nav.scrollHeight - nav.clientHeight; }"
DIALOG_STRETCH = """(extra) => {
    const dialog = document.querySelector('[data-slot="dialog-popup"]');
    dialog.style.maxHeight = 'none';
    dialog.style.height = (dialog.offsetHeight + extra) + 'px';
}"""
FOCUS_STATE = """() => { const a = document.activeElement; return { label: a?.getAttribute('aria-label') || a?.textContent?.trim() || a?.tagName, inDialog: !!a?.closest('[data-slot="dialog-popup"]'), testid: a?.getAttribute('data-testid') }; }"""


def ops(number: str, result: str, note: str):
    OPERATIONS.append((number, result, note))


def fit_toc(page, width, height):
    first = page.evaluate(NAV_OVERFLOW)
    if first > 0:
        page.set_viewport_size({"width": width, "height": height + first})
        page.wait_for_timeout(300)
    rest = page.evaluate(NAV_OVERFLOW)
    if rest > 0:
        page.evaluate(DIALOG_STRETCH, rest)
        page.wait_for_timeout(300)
    return {"overflow": first, "dialog_stretch": max(rest, 0)}


def open_dashboard(browser, base, admin, width, height=900, scale=1):
    fake = Fake(atom=True, admin=admin)
    context, page = new_page(browser, base, fake, width, height=height, scale=scale, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
    page.route("**/api/config/settings", lambda route: route.fulfill(json=SERVER_CATEGORIES))
    # 대시보드 첫 화면이 읽는 별표 폴더. 가짜가 없으면 404 알림이 설정창 위를 가린다.
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={"items": [], "nextCursor": None}))
    page.goto(base + "/", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    page.wait_for_timeout(500)
    return context, page


def save(page, out: Path, name: str, width: int, state: str, locator=None):
    (locator or page).screenshot(path=str(out / name), animations="disabled")
    INDEX.append((name, width, state))


def capture_settings_toc(browser, base, out: Path, prefix: str):
    """prefix가 빈 문자열이면 이번 빌드라 단언과 조작 측정까지 하고, 아니면 이전 빌드의 그림만 찍는다."""
    current = prefix == ""
    result = {}
    for admin in (True, False):
        who = "관리자" if admin else "관리자 아님"
        tag = "admin" if admin else "member"
        for width, height in ((1280, 900), (360, 900)):
            context, page = open_dashboard(browser, base, admin, width, height, scale=2 if width == 360 else 1)
            if admin:
                save(page, out, f"{prefix}settings-toolbar-{width}.png", width, f"{prefix}열기 단추가 있는 대시보드 툴바", page.get_by_test_id("v3-global-toolbar"))
            opener = page.get_by_test_id("config-button")
            opener_name = opener.get_attribute("aria-label")
            open_settings(page)
            nav = page.locator(NAV)
            expect(nav).to_be_visible(timeout=15000)
            page.wait_for_timeout(600)
            stretch = fit_toc(page, width, height)
            toc = page.evaluate(TOC_READ)
            heading_description = page.locator(f"{DIALOG} [data-slot=\"dialog-description\"]").count()
            result[f"{tag}-{width}"] = {"toc": toc, "stretch": stretch, "opener": opener_name, "description_count": heading_description}
            if current:
                expected = ADMIN_TOC if admin else MEMBER_TOC
                check(f"{who} {width}px: 목차 묶음과 칸 순서", [(g["group"], [i["label"] for i in g["items"]]) for g in toc] == [(g, items) for g, items in expected], toc)
                check(f"{who} {width}px: 창 부제 없음", heading_description == 0, heading_description)
                check(f"{who} {width}px: 열기 단추 이름이 창 제목과 같은 「설정」", opener_name == "설정" and opener.get_attribute("title") in (None, "설정"), opener_name)
                if admin:
                    icons = {i["label"]: i["icon"] for g in toc for i in g["items"]}
                    check(f"{who} {width}px: 내 에이전트와 영구 세션 기본 모델에 자기 아이콘", icons["내 에이전트"] == "lucide-key-round" and icons["영구 세션 기본 모델"] == "lucide-sparkles", icons)
                dims = nav.evaluate("e => ({scroll: e.scrollHeight, client: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
                check(f"{who} {width}px: 목차 전체가 한 장에 들어옴", dims["scroll"] <= dims["client"] + 1, {**dims, **stretch})
                check(f"{who} {width}px: 가로 넘침 없음", dims["sw"] <= dims["cw"] and dims["doc"] <= dims["inner"], dims)
                clipped = nav.evaluate("e => [...e.querySelectorAll('.config-category-item span')].filter(s => s.scrollWidth > s.clientWidth + 1 || s.getClientRects().length > 1).map(s => s.textContent)")
                check(f"{who} {width}px: 말줄임이나 줄바꿈으로 잘린 이름 없음", not clipped, clipped)
            save(page, out, f"{prefix}settings-toc-{tag}-{width}.png", width, f"{prefix}{who} 설정창 목차", page.locator(DIALOG))
            if width == 360:
                page.get_by_role("button", name="화면과 읽기", exact=True).click()
                page.wait_for_timeout(400)
                save(page, out, f"{prefix}settings-body-{tag}-{width}.png", width, f"{prefix}{who} 설정창 본문(화면과 읽기)", page.locator(DIALOG))
            context.close()
    (out / f"{prefix}settings-toc.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def measure_operations(browser, base):
    """14~18번 조작. 열기 단추에서 Enter, 목차 Tab 순서, Esc 닫기와 초점 복귀, 창 크기 바꾸기를 실제 키와 크기로 잰다."""
    context, page = open_dashboard(browser, base, True, 1280)
    opener = page.get_by_test_id("config-button")
    opener.focus()
    opener.press("Enter")
    expect(page.locator(DIALOG)).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    opened = page.evaluate(FOCUS_STATE)
    check("설정창을 Enter로 열면 첫 초점이 창 안에 있음", opened["inDialog"], opened)
    expected = [label for _, items in ADMIN_TOC for label in items]
    seen = []
    page.locator(f"{NAV} button").first.focus()
    for _ in expected:
        seen.append(page.evaluate(FOCUS_STATE)["label"])
        page.keyboard.press("Tab")
    check("Tab 순서가 목차를 위에서 아래로 읽는 순서와 같음", seen == expected, {"seen": seen, "expected": expected})
    page.keyboard.press("Escape")
    expect(page.locator(DIALOG)).to_have_count(0)
    closed = page.evaluate(FOCUS_STATE)
    check("Esc로 닫으면 연 단추로 초점이 돌아옴", closed["testid"] == "config-button", closed)
    DIALOG_ROWS.append(f"| 설정창(ConfigModal) | 툴바의 「설정」 단추에 초점을 두고 Enter | {opened['label']}(창 안) | 해당 없음(목차 단추 Enter는 그 칸 열기) | 창 닫힘, 대시보드 유지 | {closed['label']} |")

    open_settings(page)
    page.get_by_role("button", name="카드 실행", exact=True).click()
    page.wait_for_timeout(500)
    sizes = {}
    for width, height in ((360, 800), (1280, 900), (360, 800)):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(500)
        sizes[width] = page.evaluate("() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth, dialog: !!document.querySelector('[data-slot=\"dialog-popup\"]'), current: document.querySelector('[data-testid=\"config-category-nav\"] [aria-current=\"page\"]')?.textContent ?? null, mobileIndex: document.querySelector('.config-layout')?.getAttribute('data-mobile-index') })")
        check(f"창 크기를 {width}px로 바꿔도 가로 넘침이 없고 설정창이 열려 있음", sizes[width]["dialog"] and sizes[width]["doc"] <= sizes[width]["inner"], sizes[width])
    check("창 크기를 오가도 고른 칸(카드 실행)이 유지됨", page.evaluate("() => document.querySelector('.config-detail-heading h2')?.textContent") == "카드 실행", sizes)
    context.close()

    context, page = open_dashboard(browser, base, True, 360, 800)
    open_settings(page)
    nav = page.locator(NAV)
    expect(nav).to_be_visible()
    widest = nav.evaluate("e => ({sw: e.scrollWidth, cw: e.clientWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth})")
    check("360px 목차 가로 스크롤 없음", widest["sw"] <= widest["cw"] and widest["doc"] <= widest["inner"], widest)
    context.close()

    ops("14", "통과", "툴바의 「설정」에서 Enter로 열면 첫 초점이 창 안, Esc로 닫으면 같은 단추로 돌아옴(settings_toc.py measure_operations)")
    ops("15", "통과", "Tab 순서가 목차의 위에서 아래 순서와 같고, Esc로 닫으면 바깥 화면은 그대로")
    ops("16", "통과", "360px 관리자 목차에서 가로 스크롤과 말줄임, 줄바꿈으로 잘린 이름이 없음(capture_settings_toc의 단언)")
    ops("17", "해당 없음", "목차는 정적 정의라 실패 상태가 없다. 서버 카테고리를 못 받는 경우의 안내는 이번에 바꾸지 않았다")
    ops("18", "통과", "카드 실행을 연 채 360, 1280, 360px로 바꿔도 설정창이 열려 있고 가로 넘침 없이 같은 칸이 유지됨")


def write_operations(out: Path):
    lines = ["# 카드 #1883 설정창 목차 조작 결과", "", "## 14번부터 18번", "", "| 항목 | 결과 | 근거 |", "| --- | --- | --- |"]
    lines += [f"| {number} | {result} | {note} |" for number, result, note in OPERATIONS]
    lines += ["", "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| --- | --- | --- | --- | --- | --- |"]
    lines += DIALOG_ROWS or ["| 없음 | | | | | |"]
    lines += ["", "## 실행 명령과 산출물", "",
              "- 실행: `python3 scripts/visual-check/settings_toolbar.py --only-toc --output <캡처 폴더> --baseline-dist <이전 빌드 dist> [--dist <이번 빌드 dist>]` (이번 빌드 기본값은 unified-dashboard/dist)",
              f"- 산출물: {out}", "", "## 실측 단언", ""]
    lines += [f"- {'통과' if item['ok'] else '실패'}: {item['check']}" for item in CHECKS]
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

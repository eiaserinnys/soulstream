#!/usr/bin/env python3
"""설정 창 「화면과 읽기」 탭의 배경 격자 캡처와 조작 측정(카드 #1911).

settings_toc.py처럼 정적 dist를 띄우고 Playwright가 가짜 /api 응답(settings_toolbar_fakes.py)으로 설정 창을 연다.
넓은 폭(1440x900)과 좁은 폭(390x844), 올린 그림 없음과 있음(「내 사진」 타일)의 격자를 찍고, 타일 순서, 썸네일 로딩, 정렬,
넘침, 고르기와 새로고침 뒤 유지, Tab 순서, Esc, 창 크기 바꾸기를 잰다. 기본 그림을 고른 뒤의 앱 전체 화면(어두운 테마, 밝은 테마)도 찍는다.
이전 빌드(--baseline-dist)가 있으면 변경 전 격자 한 장을 baseline- 접두어로 찍는다.
2차: 올린 사진 보존, 예전 저장값, 타일 초점과 마우스 올림을 재고, README 데모 표본(wallpaper_contrast.spec.mts)으로 사진 배경 위 글 대비를
캡처 화소로 단언한다(wallpaper_contrast.py). 단계는 --steps로 나눠 돌릴 수 있고(무거워서 한 호출에 다 돌리지 않는다), 결과는 단계별로
<캡처 폴더>/.wallpaper-state.json에 쌓여 operations.md가 모든 단계를 합쳐 다시 쓰인다.

사용법: python3 -P scripts/visual-check/settings_wallpaper.py --output <캡처 폴더> [--dist <이번 빌드 dist>] [--baseline-dist <이전 빌드 dist>]
        [--steps grid,persist,focus,ops,contrast,contrast-before] [--before-dist <고치기 전 빌드 dist>]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

import wallpaper_contrast  # noqa: E402
from settings_toolbar_fakes import CHECKS, DIST, INDEX, Fake, check, new_page, open_settings, serve  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

DIALOG = '[data-slot="dialog-popup"]'
GRID = ".config-wallpaper-options"
STYLE_LABELS = ["보케", "메탈", "단색"]
PRESETS = [
    ("dawn-ridge", "새벽 능선"), ("aurora", "오로라"), ("silk-curves", "비단 곡선"), ("lake-horizon", "호수 수평선"),
    ("desert-dunes", "사막 언덕"), ("misty-forest", "안개 숲"), ("moonlit-sea", "달빛 바다"), ("milky-way", "은하수"),
]
PRESET_LABELS = [name for _, name in PRESETS]
OPERATIONS: list[tuple[str, str, str]] = []
DIALOG_ROWS: list[str] = []

GRID_READ = """() => {
  const grid = document.querySelector('.config-wallpaper-options');
  const section = document.querySelector('.config-wallpaper');
  const rect = (e) => e.getBoundingClientRect();
  const g = rect(grid), s = rect(section);
  const tiles = [...grid.querySelectorAll('button')].map((b) => {
    const swatch = b.querySelector('.wallpaper-swatch');
    const img = swatch.querySelector('img');
    const label = b.querySelector(':scope > span:last-child');
    const range = document.createRange();
    range.selectNodeContents(label);
    const r = rect(b), w = rect(swatch), l = rect(label);
    return { label: label.textContent, pressed: b.getAttribute('aria-pressed'), left: r.left, right: r.right, top: r.top, height: r.height,
      swatchW: w.width, swatchH: w.height, swatchTop: w.top, imgOk: img ? img.complete && img.naturalWidth > 0 : null, imgNaturalW: img ? img.naturalWidth : null,
      imgSrc: img ? img.getAttribute('src') : null, lines: range.getClientRects().length, labelLeft: l.left, labelRight: l.right, clipped: label.scrollWidth > label.clientWidth };
  });
  return { restoreButton: section.textContent.includes('기본값 복원'), cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length, gridLeft: g.left, gridRight: g.right, sectionLeft: s.left, sectionRight: s.right,
    docW: document.documentElement.scrollWidth, innerW: innerWidth, gridScrollW: grid.scrollWidth, gridClientW: grid.clientWidth, tiles };
}"""
FOCUS = """() => { const a = document.activeElement; return { label: a?.textContent?.trim() || a?.getAttribute('aria-label') || a?.tagName, inDialog: !!a?.closest('[data-slot="dialog-popup"]'), testid: a?.getAttribute('data-testid') }; }"""
PHOTO_URL = "() => document.querySelector('.wallpaper-layer')?.style.getPropertyValue('--wallpaper-photo-url') ?? null"


def ops(number: str, result: str, note: str):
    OPERATIONS.append((number, result, note))


def prefs(uploaded: bool):
    return {"wallpaper": {"mode": "bokeh"}, "uploaded": uploaded}


def open_dashboard(browser, base, width, height, uploaded, theme="dark", scale=1, fake=None):
    fake = fake or Fake(atom=True, user_prefs=prefs(uploaded))
    context, page = new_page(browser, base, fake, width, height=height, theme=theme, scale=scale, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
    page.route("**/api/config/settings", lambda route: route.fulfill(json={"categories": []}))
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={"items": [], "nextCursor": None}))
    page.goto(base + "/", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    page.wait_for_timeout(600)
    return context, page, fake


def open_appearance(page, width, already_open=False):
    if not already_open:
        open_settings(page)
    if width <= 640:
        page.get_by_role("button", name="화면과 읽기", exact=True).click()
    expect(page.locator(GRID)).to_be_visible(timeout=15000)
    page.wait_for_function("() => [...document.querySelectorAll('.config-wallpaper-options img')].every(i => i.complete)", timeout=15000)
    page.wait_for_timeout(300)


def save(page, out: Path, name: str, width: int, state: str, locator=None):
    (locator or page).screenshot(path=str(out / name), animations="disabled")
    INDEX.append((name, width, state))


def assert_grid(label: str, width: int, uploaded: bool, grid: dict):
    expected = STYLE_LABELS + PRESET_LABELS + (["내 사진"] if uploaded else [])
    tiles = grid["tiles"]
    check(f"{label}: 타일 순서와 이름", [t["label"] for t in tiles] == expected, [t["label"] for t in tiles])
    check(f"{label}: 「사진」 칸과 「기본값 복원」 없음", "사진" not in [t["label"] for t in tiles] and not grid["restoreButton"], {"labels": [t["label"] for t in tiles], "restore": grid["restoreButton"]})
    thumbs = [t for t in tiles if t["imgSrc"]]
    check(f"{label}: 썸네일 {len(thumbs)}장이 모두 불러와짐(번들 썸네일은 가로 480)", all(t["imgOk"] for t in thumbs) and all(t["imgNaturalW"] == 480 for t in thumbs if t["label"] != "내 사진"), [(t["label"], t["imgOk"], t["imgNaturalW"]) for t in thumbs])
    check(f"{label}: 모든 견본이 16:9", all(abs(t["swatchW"] / t["swatchH"] - 16 / 9) < 0.03 for t in tiles), [(t["label"], round(t["swatchW"], 1), round(t["swatchH"], 1)) for t in tiles])
    rows: dict[int, list[dict]] = {}
    for t in tiles:
        rows.setdefault(round(t["top"]), []).append(t)
    check(f"{label}: 같은 줄의 타일은 위쪽 끝과 높이가 같음", all(max(t["height"] for t in row) - min(t["height"] for t in row) <= 1 and max(t["swatchTop"] for t in row) - min(t["swatchTop"] for t in row) <= 1 for row in rows.values()), {k: [(t["label"], t["height"]) for t in v] for k, v in rows.items()})
    check(f"{label}: 격자가 구역의 왼쪽과 오른쪽 끝선에 맞음", abs(grid["gridLeft"] - grid["sectionLeft"]) <= 1 and abs(grid["gridRight"] - grid["sectionRight"]) <= 1, grid)
    check(f"{label}: 가로 넘침 없음, 타일이 격자 밖으로 나가지 않음", grid["docW"] <= grid["innerW"] and grid["gridScrollW"] <= grid["gridClientW"] and all(t["left"] >= grid["gridLeft"] - 0.5 and t["right"] <= grid["gridRight"] + 0.5 for t in tiles), grid)
    check(f"{label}: 이름이 잘리지 않고 최대 두 줄", all(not t["clipped"] and 1 <= t["lines"] <= 2 for t in tiles), [(t["label"], t["lines"], t["clipped"]) for t in tiles])
    check(f"{label}: 열 수 {grid['cols']}", grid["cols"] == (4 if width > 640 else 3), grid["cols"])
    return rows


def pressed(grid: dict) -> list[str]:
    return [t["label"] for t in grid["tiles"] if t["pressed"] == "true"]


def capture_grids(browser, base, out: Path):
    for width, height in ((1440, 900), (390, 844)):
        for uploaded in (False, True):
            tag = "uploaded" if uploaded else "none"
            context, page, _ = open_dashboard(browser, base, width, height, uploaded, scale=2 if width < 640 else 1)
            open_appearance(page, width)
            grid = page.evaluate(GRID_READ)
            assert_grid(f"격자 {width}px 올린 그림 {'있음' if uploaded else '없음'}", width, uploaded, grid)
            check(f"격자 {width}px {tag}: 처음 고른 타일은 보케 하나", pressed(grid) == ["보케"], pressed(grid))
            save(page, out, f"wallpaper-grid-{width}-{tag}.png", width, f"설정 창 배경 격자, 올린 그림 {'있음' if uploaded else '없음'}", page.locator(DIALOG))
            context.close()


def capture_baseline(browser, base, out: Path):
    context, page, _ = open_dashboard(browser, base, 1440, 900, False)
    open_settings(page)
    expect(page.locator(GRID)).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    save(page, out, "baseline-wallpaper-grid-1440.png", 1440, "변경 전(origin/main 빌드) 배경 격자", page.locator(DIALOG))
    context.close()


def choose_and_persist(browser, base, out: Path):
    """기본 그림을 고르면 배경이 바뀌고, 새로고침 뒤에도 남고, 올린 그림이 있어도 유지된다."""
    for uploaded in (False, True):
        who = f"올린 그림 {'있음' if uploaded else '없음'}"
        context, page, fake = open_dashboard(browser, base, 1440, 900, uploaded)
        open_appearance(page, 1440)
        page.get_by_role("button", name="호수 수평선", exact=True).click()
        page.wait_for_timeout(900)
        grid = page.evaluate(GRID_READ)
        check(f"고르기 ({who}): 눌러 둔 타일은 「호수 수평선」 하나", pressed(grid) == ["호수 수평선"], pressed(grid))
        check(f"고르기 ({who}): 배경 층이 그 그림으로 바뀜", "/wallpapers/lake-horizon.webp" in (page.evaluate(PHOTO_URL) or ""), page.evaluate(PHOTO_URL))
        check(f"고르기 ({who}): 서버에 {{photo, /wallpapers/lake-horizon.webp}}가 저장됨", fake.user_prefs["wallpaper"] == {"mode": "photo", "customImage": "/wallpapers/lake-horizon.webp"}, fake.user_prefs)
        check(f"고르기 ({who}): 올린 그림은 지워지지 않음", fake.user_prefs["uploaded"] == uploaded, fake.user_prefs)
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        page.wait_for_timeout(900)
        check(f"새로고침 ({who}): 배경이 그대로 호수 수평선", "/wallpapers/lake-horizon.webp" in (page.evaluate(PHOTO_URL) or ""), page.evaluate(PHOTO_URL))
        open_appearance(page, 1440)
        grid = page.evaluate(GRID_READ)
        check(f"새로고침 ({who}): 설정 창의 선택 표시도 유지", pressed(grid) == ["호수 수평선"] and (("내 사진" in [t["label"] for t in grid["tiles"]]) == uploaded), pressed(grid))
        if uploaded:
            page.get_by_role("button", name="내 사진", exact=True).click()
            page.wait_for_timeout(900)
            check("내 사진 타일을 누르면 업로드 그림 주소로 바뀜", fake.user_prefs["wallpaper"].get("customImage", "").startswith("/api/user/background") and pressed(page.evaluate(GRID_READ)) == ["내 사진"], fake.user_prefs)
        context.close()


def preserve_uploaded_photo(browser, base):
    """올린 사진이 있는 상태에서 보케를 골라도 올린 사진은 남고 「내 사진」 타일도 그대로다."""
    context, page, fake = open_dashboard(browser, base, 1440, 900, True)
    open_appearance(page, 1440)
    page.get_by_role("button", name="오로라", exact=True).click()
    page.wait_for_timeout(700)
    page.get_by_role("button", name="보케", exact=True).click()
    page.wait_for_timeout(900)
    grid = page.evaluate(GRID_READ)
    check("올린 사진 보존: 보케를 골라도 서버의 올린 사진이 남음", fake.user_prefs["uploaded"] is True and fake.user_prefs["last_put"]["clearBackground"] is False, fake.user_prefs)
    check("올린 사진 보존: 「내 사진」 타일이 그대로 있음", "내 사진" in [t["label"] for t in grid["tiles"]], [t["label"] for t in grid["tiles"]])
    for label in ("오로라", "메탈", "단색", "은하수", "보케"):
        page.get_by_role("button", name=label, exact=True).click()
        page.wait_for_timeout(700)
        check(f"올린 사진 보존: {label}을 골라도 사진이 남음", fake.user_prefs["uploaded"] is True and "내 사진" in [t["label"] for t in page.evaluate(GRID_READ)["tiles"]], fake.user_prefs)
    context.close()


def legacy_saved_value(browser, base):
    """customImage가 없는 예전 저장값 {mode: photo}는 「새벽 능선」이 눌려 보인다."""
    fake = Fake(atom=True, user_prefs={"wallpaper": {"mode": "photo"}, "uploaded": False})
    context, page, _ = open_dashboard(browser, base, 1440, 900, False, fake=fake)
    open_appearance(page, 1440)
    grid = page.evaluate(GRID_READ)
    check("예전 저장값 {photo}: 눌린 타일이 「새벽 능선」 하나", pressed(grid) == ["새벽 능선"], pressed(grid))
    context.close()


TILE_STYLE = """(label) => { const b = [...document.querySelectorAll('.config-wallpaper-options button')].find(x => x.textContent === label);
  const s = getComputedStyle(b); const probe = document.createElement('i'); probe.style.borderColor = 'var(--v3-stroke-hover)'; probe.style.borderStyle = 'solid'; document.querySelector('.config-dialog').append(probe);
  const hover = getComputedStyle(probe).borderTopColor; probe.remove();
  return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow, border: s.borderTopColor, pressed: b.getAttribute('aria-pressed'), focused: document.activeElement === b, hoverToken: hover }; }"""


def focus_and_hover(browser, base, out: Path):
    """초점과 고르기가 캡처에서 다르게 보이고, 고르지 않은 타일에 마우스를 올리면 테두리가 --v3-stroke-hover다(두 테마)."""
    for theme in ("dark", "light"):
        context, page, _ = open_dashboard(browser, base, 1440, 900, False, theme=theme)
        open_appearance(page, 1440)
        page.get_by_role("button", name="오로라", exact=True).click()
        page.wait_for_timeout(700)
        page.get_by_role("button", name="사진 업로드", exact=True).focus()
        for _ in range(6):
            page.keyboard.press("Tab")
        focused = page.evaluate(FOCUS)
        check(f"초점({theme}): 「사진 업로드」에서 Tab 여섯 번이면 「비단 곡선」", focused["label"] == "비단 곡선", focused)
        page.wait_for_timeout(300)
        focus_style = page.evaluate(TILE_STYLE, "비단 곡선")
        selected_style = page.evaluate(TILE_STYLE, "오로라")
        check(f"초점({theme}): outline 없이 box-shadow 고리로 그림(설정 창 탐색 항목과 같은 꼴)", focus_style["outlineStyle"] in ("none", "") or focus_style["outlineWidth"] == "0px", focus_style)
        check(f"초점({theme}): 초점 고리가 있고 고른 타일에는 없음", focus_style["boxShadow"] != "none" and selected_style["boxShadow"] == "none", {"focus": focus_style["boxShadow"], "selected": selected_style["boxShadow"]})
        check(f"초점({theme}): 초점만 있는 타일과 고르기만 한 타일의 테두리가 다름", focus_style["border"] != selected_style["border"] and selected_style["pressed"] == "true" and focus_style["pressed"] == "false", {"focus": focus_style["border"], "selected": selected_style["border"]})
        region = page.locator(".config-wallpaper-options")
        save(page, out, f"wallpaper-focus-vs-selected-{theme}.png", 1440, f"초점만 있는 「비단 곡선」과 고르기만 한 「오로라」({theme})", region)
        page.mouse.move(-10, -10)
        page.get_by_role("button", name="사막 언덕", exact=True).hover()
        page.wait_for_timeout(300)
        hover_style = page.evaluate(TILE_STYLE, "사막 언덕")
        check(f"마우스 올림({theme}): 고르지 않은 타일 테두리가 --v3-stroke-hover", hover_style["border"] == hover_style["hoverToken"] and hover_style["pressed"] == "false", hover_style)
        save(page, out, f"wallpaper-hover-{theme}.png", 1440, f"「사막 언덕」에 마우스를 올림({theme})", region)
        page.mouse.move(-10, -10)
        page.get_by_role("button", name="오로라", exact=True).hover()
        page.wait_for_timeout(300)
        check(f"마우스 올림({theme}): 고른 타일은 선택 테두리를 그대로 가짐", page.evaluate(TILE_STYLE, "오로라")["border"] == selected_style["border"], page.evaluate(TILE_STYLE, "오로라"))
        context.close()


def measure_operations(browser, base, out: Path):
    context, page, fake = open_dashboard(browser, base, 1440, 900, True)
    opener = page.get_by_test_id("config-button")
    opener.focus()
    open_settings(page)
    page.wait_for_timeout(500)
    first_focus = page.evaluate(FOCUS)
    check("열린 뒤 첫 초점이 설정 창 안에 있음", first_focus["inDialog"], first_focus)
    open_appearance(page, 1440, already_open=True)
    page.get_by_role("button", name="사진 업로드", exact=True).focus()
    order = []
    for _ in range(12):
        page.keyboard.press("Tab")
        order.append(page.evaluate(FOCUS))
    labels = [item["label"] for item in order]
    expected = STYLE_LABELS + PRESET_LABELS + ["내 사진"]
    check("Tab 순서가 격자의 보이는 순서를 따름(보케부터 내 사진까지)", labels[:12] == expected, labels)
    check("Tab으로 닿는 요소가 모두 설정 창 안에 있음", all(item["inDialog"] for item in order), order)
    page.get_by_role("button", name="은하수", exact=True).focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)
    grid = page.evaluate(GRID_READ)
    check("Enter로 타일을 고르면 선택됨(「은하수」)", pressed(grid) == ["은하수"] and fake.user_prefs["wallpaper"].get("customImage") == "/wallpapers/milky-way.webp", {"pressed": pressed(grid), "saved": fake.user_prefs})
    page.keyboard.press("Escape")
    expect(page.locator(DIALOG)).to_have_count(0)
    after = page.evaluate(FOCUS)
    check("Esc로 설정 창이 닫히고 초점이 열었던 설정 단추로 돌아옴", after["testid"] == "config-button", after)
    DIALOG_ROWS.append(f"| 설정 창(배경 격자 포함) | 툴바 설정 단추 | {first_focus['label']} | 타일에서 Enter: 고르고 창은 그대로 | 닫힘, 바깥 화면은 그대로 | {after['label']} (config-button) |")
    context.close()

    context, page, _ = open_dashboard(browser, base, 1440, 900, True)
    open_appearance(page, 1440)
    wide = page.evaluate(GRID_READ)
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(500)
    narrow = page.evaluate(GRID_READ)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(500)
    back = page.evaluate(GRID_READ)
    check("창 크기 바꾸기: 열 수가 4 → 3 → 4로 다시 서고 가로 넘침 없음", [wide["cols"], narrow["cols"], back["cols"]] == [4, 3, 4] and narrow["docW"] <= narrow["innerW"] and back["docW"] <= back["innerW"], [wide["cols"], narrow["cols"], back["cols"], narrow["docW"], narrow["innerW"]])
    check("창 크기 바꾸기: 열려 있던 설정 창과 선택 표시가 유지됨", pressed(narrow) == pressed(wide) == pressed(back), [pressed(wide), pressed(narrow), pressed(back)])
    context.close()

    context, page, _ = open_dashboard(browser, base, 360, 800, True)
    open_appearance(page, 360)
    narrow360 = page.evaluate(GRID_READ)
    assert_grid("최소 폭 360px 올린 그림 있음", 360, True, narrow360)
    context.close()

    ops("14", "통과", "설정 단추로 열면 첫 초점이 창 안, Esc로 닫으면 초점이 설정 단추로 돌아옴. 타일을 누른 뒤에도 초점은 그 타일에 남음")
    ops("15", "통과", "Tab이 보케부터 내 사진까지 보이는 순서로 열두 칸을 지나고 창 밖으로 나가지 않음. 보이지 않는 요소로 가지 않음. Esc는 창만 닫음")
    ops("16", "통과", "360px에서 3열, 가로 스크롤 없음, 이름이 잘리지 않음(「호수 수평선」은 어절에서만 줄이 바뀜), 타일이 격자 밖으로 나가지 않음")
    ops("17", "해당 없음", "배경 격자는 서버에서 받는 목록이 없다. 그림은 번들 정적 파일이고 내 사진 타일은 설정 동기화 응답의 backgroundUrl이 있을 때만 생긴다. 업로드 읽기 실패 안내(role=alert)는 이번에 바꾸지 않았다")
    ops("18", "통과", "1440 → 390 → 1440으로 창 크기를 바꿔도 열 수가 4 → 3 → 4로 다시 서고 선택 표시와 열린 설정 창이 유지됨")


EXPECTED_CAPTURES = 36
REPRESENTATIVES = [("light-moonlit-sea-css-w1440", "밝은 테마 달빛 바다"), ("dark-desert-dunes-css-w1440", "어두운 테마 사막 언덕")]


def publish_representatives(out: Path, tag: str, label: str):
    """대표 캡처를 shots/ 맨 위로 복사한다(봉인 산출물 glob은 하위 폴더를 보지 않는다)."""
    for stem, text in REPRESENTATIVES:
        name = f"contrast-{label}-{stem.removesuffix('-css-w1440')}.png"
        (out / name).write_bytes((out / "contrast" / f"{tag}{stem}.png").read_bytes())
        INDEX.append((name, 1440, f"README 데모 표본 위 {text}, 고치기 {label}"))


def run_contrast_capture(dist: str, out: Path, tag: str):
    out = out / "contrast"
    env = {**os.environ, "REVIEW_DIST": dist, "REVIEW_OUT": str(out), "REVIEW_TAG": tag}
    subprocess.run([str(ROOT / "unified-dashboard/node_modules/.bin/playwright"), "test", "--config", str(ROOT / "scripts/visual-check/wallpaper_contrast.config.mts")], env=env, cwd=ROOT, check=False, stdout=subprocess.DEVNULL)
    # 찍을 조합이 모두 이미 있으면 Playwright는 시험이 없다며 1로 끝난다. 캡처 수로 성패를 가린다(조합은 wallpaper_contrast.spec.mts의 COMBOS).
    captured = len([path for path in out.glob(f"{tag}*.json") if tag or not path.stem.startswith("before-")])
    assert captured == EXPECTED_CAPTURES, f"대비 캡처 {captured}장(기대 {EXPECTED_CAPTURES}장)"


def soft_check(label: str, condition: bool, detail) -> None:
    """실패해도 멈추지 않고 모두 기록한다. 단계 끝에서 한 번에 실패로 끝낸다."""
    CHECKS.append({"check": label, "ok": bool(condition), "detail": detail})


def contrast_after(out: Path, dist: str):
    """고친 빌드: 사진 위 글 대비, 사진 보임. 실패한 조합을 전부 기록한 뒤 실패로 끝낸다."""
    first = len(CHECKS)
    run_contrast_capture(dist, out, "")
    publish_representatives(out, "", "후")
    out = out / "contrast"
    for item in wallpaper_contrast.contrast_checks(out):
        detail = {"texts": item["texts"], "worse": item["worse"], "lowest": item["lowest"]}
        soft_check(f"대비 {item['name']}: 보케 기준 min(4.5, 보케) - 0.5보다 나쁜 글 0개(글 {item['texts']}개)", item["worse"] == 0, detail)
        if item["webgl"] is not None and "webgl" in item["name"]:
            soft_check(f"대비 {item['name']}: WebGL 유리가 실제로 켜짐", item["webgl"] == "on", item["webgl"])
    for item in wallpaper_contrast.photo_visibility(out, Path(dist) / "wallpapers"):
        if item["skipped"]:
            continue
        soft_check(f"사진 보임 {item['name']}: 패널 밖 화소가 덮개를 씌운 사진과 같은 모양(평균 오차 {item['mean_error']:.1f} < 16)", item["mean_error"] < 16, item)
    failed = [item["check"] for item in CHECKS[first:] if not item["ok"]]
    assert not failed, f"{len(failed)}개 실패: {failed[:5]}"


def contrast_before(out: Path, before_dist: str):
    """고치기 전 커밋 1b2c283c 빌드: 같은 단언이 실패해야 단언이 늘 참이 아니다. 사진 아닌 배경은 화소가 같아야 한다."""
    run_contrast_capture(before_dist, out, "before-")
    publish_representatives(out, "before-", "전")
    out = out / "contrast"
    results = wallpaper_contrast.contrast_checks(out, "before-")
    failing = [item for item in results if item["worse"] > 0]
    summary = ", ".join(f"{item['name'].removeprefix('before-')}: {item['worse']}/{item['texts']}" for item in failing[:6])
    check(f"고치기 전(1b2c283c) 빌드에서 대비 단언이 실패함: 사진 캡처 {len(results)}장 중 {len(failing)}장", len(failing) >= 1, summary)
    check("고치기 전 빌드의 최저 대비 글 예시", True, [(item["name"].removeprefix("before-"), item["lowest"]) for item in failing[:3]])
    unchanged = wallpaper_contrast.unchanged_checks(out, out)
    check(f"보케, 메탈, 단색 캡처 {len(unchanged)}장이 고치기 전 빌드와 같음(렌더 잡음 범위)", unchanged and all(item["identical"] for item in unchanged), [(item["name"], item["changed_pixels"], item["max_delta"]) for item in unchanged])


STEP_ORDER = ["grid", "persist", "focus", "ops", "contrast", "contrast-before"]
STATE_FILE = ".wallpaper-state.json"


def write_operations(out: Path, state: dict):
    steps = [state[name] for name in STEP_ORDER if name in state]
    lines = ["# 카드 #1911 기본 배경화면 격자 조작 결과", "", "## 14번부터 18번", "", "| 항목 | 결과 | 근거 |", "| --- | --- | --- |"]
    lines += [f"| {number} | {result} | {note} |" for step in steps for number, result, note in step["ops"]]
    lines += ["", "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| --- | --- | --- | --- | --- | --- |"]
    rows = [row for step in steps for row in step["dialogs"]]
    lines += rows or ["| 없음 | | | | | |"]
    lines += ["", "## 실행 명령과 산출물", "",
              "- 실행: `python3 -P scripts/visual-check/settings_wallpaper.py --output <캡처 폴더> --steps grid,persist,focus,ops [--baseline-dist <이전 빌드 dist>]`",
              "- 대비 단계: `--steps contrast --dist <이번 dist>`, 고치기 전 빌드 확인은 `--steps contrast-before --before-dist <고치기 전 dist>`(README 데모 표본을 Playwright로 찍는다. 단계마다 한 호출씩 돌린다)",
              "- 이전 빌드까지 만들어 돌리려면 `scripts/visual-check/settings_wallpaper.sh <캡처 폴더>`",
              f"- 산출물: {out}", "", "## 캡처 목록", ""]
    lines += [f"- `{name}` ({width}px): {text}" for step in steps for name, width, text in step["index"]]
    lines += ["", "## 실측 단언", ""]
    lines += [f"- {'통과' if item['ok'] else '실패'}: {item['check']}" for step in steps for item in step["checks"]]
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True)
    parser.add_argument("--dist", default=str(DIST))
    parser.add_argument("--baseline-dist")
    parser.add_argument("--before-dist")
    parser.add_argument("--steps", default="grid,persist,focus,ops")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    state_path = out / STATE_FILE
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    wanted = args.steps.split(",")
    server, base = serve(args.dist)
    baseline_server = baseline_base = None
    if args.baseline_dist:
        baseline_server, baseline_base = serve(args.baseline_dist)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for name in STEP_ORDER:
                    if name not in wanted:
                        continue
                    checks_before, index_before = len(CHECKS), len(INDEX)
                    OPERATIONS.clear()
                    DIALOG_ROWS.clear()
                    try:
                        if name == "grid":
                            if baseline_base:
                                capture_baseline(browser, baseline_base, out)
                            capture_grids(browser, base, out)
                        elif name == "persist":
                            choose_and_persist(browser, base, out)
                            preserve_uploaded_photo(browser, base)
                            legacy_saved_value(browser, base)
                        elif name == "focus":
                            focus_and_hover(browser, base, out)
                        elif name == "ops":
                            measure_operations(browser, base, out)
                        elif name == "contrast":
                            contrast_after(out, args.dist)
                        elif name == "contrast-before":
                            contrast_before(out, args.before_dist)
                    finally:
                        state[name] = {"checks": CHECKS[checks_before:], "index": INDEX[index_before:], "ops": list(OPERATIONS), "dialogs": list(DIALOG_ROWS)}
                        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1))
                        write_operations(out, state)
            finally:
                browser.close()
    finally:
        server.shutdown()
        if baseline_server:
            baseline_server.shutdown()
    failed = [item["check"] for step in state.values() for item in step["checks"] if not item["ok"]]
    print(json.dumps({"checks": sum(len(step["checks"]) for step in state.values()), "failed": failed, "output": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""설정 창 카탈로그 선택 상자·인라인 오류 글 대비 검수 (카드 #1691, 범위 축소).

`/dialogues?sample=settings`의 외부 에이전트·접속 링크 탭과, 설정 창 밖 컴포넌트 검수 창
(`/components`)에서 남는 항목 3과 4만 잰다.

  - 카탈로그 선택 상자의 트리거 값이 soul-ui SelectValue 이고, 처음 값이 첫 항목이 아닐 때
    열면 고른 항목 글자와 트리거 값 글자의 위쪽 끝 차이가 1px 이하인지
    (설정 창 접속 링크 + 설정 창 밖 컴포넌트 검수 창),
  - 라이트·다크에서 인라인 오류 글의 계산된 글자색과 뷰포트 전체 캡처의 실제 바탕 화소 대비가
    4.5:1 이상인지 (외부 에이전트 불러오기 실패, SettingsAlert, 접속 링크 폼 small[role=alert]),
  - ui-design 0절 14~18번: 설정 창을 열 때(어떤 탭도 누르기 전)와 실제로 탭을 누른 뒤의 초점,
    선택 상자 Tab 과 Esc 의 초점, 360 넘침, 오류 상태와 다시 시도, 열린 채 1280↔360 창 크기 바꾸기.

외부 에이전트의 불러오기 실패는 앱 견본의 `ownedState=error`(첫 요청 503, 다시 시도하면 성공)로
만든다. 접속 링크 응답은 앱 코드가 `accessLinksVisual` 질의에서 실제 fetch 로 통과시켜
page.route 가 받는다.

실행

    # 저장소 루트에서. --serve 면 빈 포트를 스스로 골라 Vite 를 띄우고 끝나면 내린다.
    python3 -P unified-dashboard/scripts/visual-check/settings_polish.py \
        --serve --output .local/card1691-settings-polish

    # 이미 띄운 서버를 쓰려면 주소를 준다.
    python3 -P unified-dashboard/scripts/visual-check/settings_polish.py \
        http://127.0.0.1:5173 --output .local/card1691-settings-polish

산출물

    {출력}/owned-agents-error-{폭}-{테마}.png    불러오기 실패
    {출력}/catalog-open-{대상}-{폭}-{테마}.png   선택 상자 열림(고른 항목이 트리거 자리에 겹침)
    {출력}/access-links-error-{폭}-{테마}.png    접속 링크 목록 실패(SettingsAlert)
    {출력}/access-links-field-error-{폭}-{테마}.png  폼 필드 오류(small[role=alert])
    {출력}/report.json                          측정값과 판정

점검이 하나라도 어긋나면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import access_links_tab as alt  # noqa: E402  focus 도우미
import settings_nodes as sn  # noqa: E402  테마 문맥·정착 도우미
import settings_nodes_layout as snl  # noqa: E402  대비 하한(CONTRAST_MIN)

ROOT = Path(__file__).resolve().parents[3]
WIDE, NARROW = sn.WIDE, sn.NARROW
THEMES = ("light", "dark")
TOLERANCE_PX = 1.0
CONTRAST_MIN = snl.CONTRAST_MIN
SETTINGS_QUERY = "?sample=settings&accessLinksVisual=1"

SESSIONS = [
    {"session_id": f"00000000-0000-4000-8000-{index + 1:012}", "display_name": name, "agent_name": "로젤린"}
    for index, name in enumerate(["✨ 서소영 관제", "🌿 로젤린 작업", "🔍 조사 세션", "📝 글쓰기"])
]
LINKS = [
    {"id": "link-active", "label": "외부 조사 도우미", "target_session_id": SESSIONS[0]["session_id"], "permissions": ["send", "read_own"], "created_at": "2026-11-01T00:00:00Z", "expires_at": "2030-12-01T00:00:00Z", "revoked_at": None, "last_used_at": None},
    {"id": "link-past", "label": "지난 연결", "target_session_id": SESSIONS[1]["session_id"], "permissions": ["send"], "created_at": "2020-10-01T00:00:00Z", "expires_at": "2020-10-15T00:00:00Z", "revoked_at": None, "last_used_at": "2020-10-10T00:00:00Z"},
]

access_state = {"mode": "normal"}

FOCUS = alt.focus

SELECT_PROBE = r"""
(label) => {
  const combos = [...document.querySelectorAll('[role=combobox]')].filter(el => el.getAttribute('aria-label') === label);
  const combo = combos[combos.length - 1];
  const value = combo ? combo.querySelector('[data-slot=select-value]') : null;
  const listbox = [...document.querySelectorAll('[role=listbox]')].find(el => el.getBoundingClientRect().width > 0);
  const optionItems = listbox ? [...listbox.querySelectorAll('[role=option]')] : [];
  const selected = optionItems.find(el => el.hasAttribute('data-selected')) ?? null;
  const rectOfText = (el) => {
    if (!el) return null;
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom, height: rect.height, text: node.textContent.trim()};
  };
  const valueText = rectOfText(value);
  const itemText = rectOfText(selected);
  return {
    valueFound: Boolean(value),
    value: valueText,
    item: itemText,
    selectedIndex: selected ? optionItems.indexOf(selected) : -1,
    optionCount: optionItems.length,
    listboxVisible: Boolean(listbox),
    delta: valueText && itemText ? itemText.top - valueText.top : null,
  };
}
"""

FG_PROBE = r"""
(el) => {
  const css = getComputedStyle(el).color;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return {css, rgb: [data[0], data[1], data[2]]};
}
"""

OVERFLOW_JS = r"""
(selector) => {
  const root = document.querySelector(selector);
  if (!root) return {found: false};
  const bounds = root.getBoundingClientRect();
  const escaped = [...root.querySelectorAll('*')].filter(el => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    if (box.bottom <= bounds.top || box.top >= bounds.bottom) return false;
    if (el.closest('[aria-hidden=true]') || style.position === 'fixed') return false;
    const clipped = el.parentElement?.closest('[style*="overflow"], .truncate, .access-links-label, .owned-agents-name');
    if (clipped && clipped !== root) return false;
    return box.left < bounds.left - 1 || box.right > bounds.right + 1;
  }).map(el => ({tag: el.tagName, cls: String(el.className).slice(0, 80)}));
  return {found: true, scroll: root.scrollWidth, client: root.clientWidth, page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, escaped: escaped.slice(0, 20)};
}
"""


def access_route(route) -> None:
    path = route.request.url.split("?")[0]
    if path.endswith("/api/persistent-sessions"):
        route.fulfill(json={"sessions": SESSIONS, "total": len(SESSIONS)})
    elif access_state["mode"] == "error":
        route.fulfill(status=503, json={"detail": "fixture failure"})
    else:
        route.fulfill(json=LINKS)


def install_fixtures(context) -> None:
    context.route("**/api/access-links**", access_route)
    context.route("**/api/persistent-sessions", access_route)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(base: str) -> None:
    for _ in range(240):
        try:
            urllib.request.urlopen(base + "/", timeout=1)
            return
        except Exception:
            time.sleep(0.5)
    raise SystemExit("Vite 개발 서버가 뜨지 않았습니다: " + base)


def shot(page, out: Path, name: str, captures: list[str]) -> None:
    path = out / f"{name}.png"
    page.screenshot(path=str(path), animations="disabled")
    captures.append(path.name)


def select_tab(page, label: str, width: int) -> None:
    if width == NARROW:
        back = page.get_by_role("button", name="모든 설정")
        if back.count() and back.first.is_visible():
            back.first.click()
            page.wait_for_timeout(250)
    page.get_by_role("button", name=label, exact=True).first.click()
    page.wait_for_timeout(600)


def open_issue(page) -> None:
    page.get_by_role("button", name="링크 만들기", exact=True).first.click()
    page.get_by_role("dialog").last.get_by_text("새 접속 링크").wait_for()
    page.wait_for_timeout(300)


def check_overflow(page, measurements: dict, problems: list[str], name: str, selector: str = ".config-detail") -> None:
    data = page.evaluate(OVERFLOW_JS, selector)
    measurements[name] = data
    if not data.get("found"):
        problems.append(name + ": 영역 없음")
        return
    if data["page"] > data["viewport"] + 1 or data["scroll"] > data["client"] + 1 or data["escaped"]:
        problems.append(name + ": 가로 넘침")


INK_DISTANCE = 40


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    def channel(value: int) -> float:
        value = value / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])


def contrast_ratio(one: tuple[int, int, int], other: tuple[int, int, int]) -> float:
    high, low = sorted((relative_luminance(one), relative_luminance(other)), reverse=True)
    return round((high + 0.05) / (low + 0.05), 2)


def band_pixels(image: Image.Image, band: tuple[int, int, int, int]) -> list[tuple[int, int, int]]:
    left, top, right, bottom = band
    return [
        image.getpixel((x, y))
        for y in range(max(0, top), min(image.height, bottom))
        for x in range(max(0, left), min(image.width, right))
    ]


def measure_contrast(page, locator, measurements: dict, problems: list[str], name: str, region: str = "outside") -> None:
    """계산된 글자색과 뷰포트 전체 캡처의 실제 바탕 화소로 대비를 잰다.

    clip·locator.screenshot 은 DPR 2 이상에서 유리 층을 놓쳐 흰 바탕이 나오므로 쓰지 않는다.
    바탕은 글 상자 가장자리 바로 곁(region="outside")이나 안쪽 여백(region="inside")의
    글자 잉크가 없는 화소 가운데 가장 많은 색이다.
    """
    element = locator.first
    element.wait_for(state="visible")
    element.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    box = element.bounding_box()
    if not box:
        problems.append(name + ": 글 상자 없음")
        return
    viewport = page.evaluate("() => ({width: innerWidth, height: innerHeight})")
    foreground = element.evaluate(FG_PROBE)
    fg = tuple(foreground["rgb"])
    image = Image.open(io.BytesIO(page.screenshot(animations="disabled"))).convert("RGB")
    scale = image.width / viewport["width"]
    left, top = box["x"] * scale, box["y"] * scale
    right, bottom = (box["x"] + box["width"]) * scale, (box["y"] + box["height"]) * scale
    gap, thickness, inset = 2 * scale, 3 * scale, 3 * scale
    if region == "inside":
        bands = [
            (left + inset, top + inset, right - inset, top + inset + thickness),
            (left + inset, bottom - inset - thickness, right - inset, bottom - inset),
            (left + inset, top + inset + thickness, left + inset + thickness, bottom - inset - thickness),
            (right - inset - thickness, top + inset + thickness, right - inset, bottom - inset - thickness),
        ]
    else:
        bands = [
            (left, top - gap - thickness, right, top - gap),
            (left, bottom + gap, right, bottom + gap + thickness),
            (left - gap - thickness, top, left - gap, bottom),
            (right + gap, top, right + gap + thickness, bottom),
        ]
    sampled = [pixel for band in bands for pixel in band_pixels(image, tuple(int(round(value)) for value in band))]
    ink_free = [pixel for pixel in sampled if sum((one - other) ** 2 for one, other in zip(pixel, fg)) > INK_DISTANCE ** 2]
    if not ink_free:
        problems.append(name + ": 바탕 화소 없음")
        return
    bg, bg_count = Counter(ink_free).most_common(1)[0]
    ratio = contrast_ratio(fg, bg)
    measurements[name] = {
        "fg": "#%02x%02x%02x" % fg,
        "fg_css": foreground["css"],
        "bg_pixel": "#%02x%02x%02x" % bg,
        "ratio": ratio,
        "sample": region,
        "bg_count": bg_count,
        "sample_count": len(ink_free),
        "scale": scale,
    }
    if ratio < CONTRAST_MIN:
        problems.append(f"{name}: 대비 {ratio}:1")


def check_select_open(page, label: str, measurements: dict, problems: list[str], name: str, out: Path, shot_name: str, captures: list[str]) -> None:
    trigger = page.get_by_role("combobox", name=label).last
    trigger.scroll_into_view_if_needed()
    trigger.click()
    page.locator("[role=listbox]").last.wait_for()
    page.wait_for_timeout(350)
    data = page.evaluate(SELECT_PROBE, label)
    measurements[name] = data
    shot(page, out, shot_name, captures)
    if not data["valueFound"]:
        problems.append(name + ": 트리거 값이 SelectValue 아님")
    if data["selectedIndex"] < 1:
        problems.append(name + ": 처음 값이 첫 항목")
    if data["delta"] is None or abs(data["delta"]) > TOLERANCE_PX:
        problems.append(name + ": 고른 항목과 트리거 값 위쪽 끝 차이")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    try:
        page.wait_for_function(
            "(label) => document.activeElement?.getAttribute('aria-label') === label", arg=label, timeout=2000
        )
    except Exception:
        pass


def resize_state(page, label: str) -> dict:
    state = page.evaluate(
        """(label) => ({
          visibleListboxes: [...document.querySelectorAll('[role=listbox]')].filter(el => el.getBoundingClientRect().width > 0).length,
          expanded: [...document.querySelectorAll('[role=combobox]')].find(el => el.getAttribute('aria-label') === label)?.getAttribute('aria-expanded'),
          page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
        })""",
        label,
    )
    state["focus"] = FOCUS(page)
    return state


def run(browser, base: str, out: Path, captures: list[str], measurements: dict, problems: list[str]) -> None:
    for width in (WIDE, NARROW):
        for theme in THEMES:
            key = f"{width}-{theme}"
            access_state.update(mode="normal")
            context = sn.new_context(browser, width, theme)
            install_fixtures(context)
            page = context.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            page.goto(base + "/dialogues" + SETTINGS_QUERY, wait_until="domcontentloaded")
            sn.settle(page)
            tab_button = page.get_by_role("button", name="외부 에이전트", exact=True).first
            tab_button.wait_for(state="visible", timeout=30000)
            page.wait_for_timeout(300)
            measurements[f"focus-open-{key}"] = FOCUS(page)
            if not measurements[f"focus-open-{key}"]["dialog"]:
                problems.append(f"{key}: 설정 창을 열었을 때 초점이 창 밖")
            tab_button.click(timeout=30000)
            page.get_by_text("아직 등록한 에이전트가 없습니다.", exact=True).wait_for(timeout=30000)
            page.wait_for_timeout(300)
            measurements[f"focus-after-tab-click-{key}"] = FOCUS(page)
            before = measurements[f"focus-open-{key}"]
            after = measurements[f"focus-after-tab-click-{key}"]
            if not after["dialog"]:
                problems.append(f"{key}: 탭을 누른 뒤 초점이 창 밖")
            if (after["tag"], after["name"], after["text"], after["dialog"]) == (before["tag"], before["name"], before["text"], before["dialog"]):
                problems.append(f"{key}: 창을 열 때와 탭을 누른 뒤의 초점이 같음")
            check_overflow(page, measurements, problems, f"overflow-owned-{key}")

            select_tab(page, "접속 링크", width)
            page.get_by_text("외부 조사 도우미", exact=True).wait_for()
            check_overflow(page, measurements, problems, f"overflow-access-links-{key}")

            if theme == "light":
                open_issue(page)
                page.get_by_role("combobox", name="대상 세션").click()
                page.get_by_role("option", name=SESSIONS[1]["display_name"], exact=True).click()
                page.wait_for_timeout(300)
                check_select_open(page, "대상 세션", measurements, problems, f"select-access-links-{key}", out, f"catalog-open-access-links-{key}", captures)
                measurements[f"select-escape-focus-{key}"] = FOCUS(page)
                if measurements[f"select-escape-focus-{key}"]["label"] != "대상 세션":
                    problems.append(f"{key}: 선택 상자 Esc 뒤 초점 복귀")
                page.get_by_role("combobox", name="대상 세션").focus()
                page.keyboard.press("Tab")
                page.wait_for_timeout(200)
                measurements[f"select-tab-focus-{key}"] = FOCUS(page)
                if not measurements[f"select-tab-focus-{key}"]["dialog"]:
                    problems.append(f"{key}: 선택 상자 Tab 초점이 창 밖")
                # 18: 선택 상자를 연 채 창 크기를 바꾼다.
                page.get_by_role("combobox", name="대상 세션").click()
                page.locator("[role=listbox]").last.wait_for()
                other = NARROW if width == WIDE else WIDE
                page.set_viewport_size({"width": other, "height": 800 if other == NARROW else 1000})
                page.wait_for_timeout(700)
                resized = resize_state(page, "대상 세션")
                measurements[f"resize-select-{key}-to-{other}"] = resized
                if resized["page"] > resized["viewport"] + 1:
                    problems.append(f"{key}→{other}: 창 크기 변경 뒤 가로 넘침")
                if resized["visibleListboxes"] and resized["expanded"] != "true":
                    problems.append(f"{key}→{other}: 목록이 보이는데 펼침 상태 아님")
                if not resized["visibleListboxes"] and resized["focus"]["label"] != "대상 세션":
                    problems.append(f"{key}→{other}: 목록이 닫혔는데 초점이 트리거로 돌아오지 않음")
                if resized["visibleListboxes"]:
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(300)
                page.set_viewport_size({"width": width, "height": 900 if width == WIDE else 800})
                page.wait_for_timeout(300)
                page.get_by_role("dialog").last.get_by_role("button", name="취소").click()
                page.wait_for_timeout(300)
                # 18: 설정 창을 연 채 창 크기를 바꾼다.
                page.set_viewport_size({"width": other, "height": 800 if other == NARROW else 1000})
                page.wait_for_timeout(500)
                check_overflow(page, measurements, problems, f"resize-settings-{key}-to-{other}", ".config-layout")
                page.set_viewport_size({"width": width, "height": 900 if width == WIDE else 800})
                page.wait_for_timeout(300)

            if width == NARROW:
                page.goto(base + "/dialogues" + SETTINGS_QUERY + "&ownedState=error", wait_until="domcontentloaded")
                sn.settle(page)
                page.get_by_role("button", name="외부 에이전트", exact=True).click(timeout=30000)
                page.get_by_text("공개 예시: 요청을 처리하지 못했습니다. 다시 시도해 주세요.", exact=True).wait_for(timeout=30000)
                shot(page, out, f"owned-agents-error-{key}", captures)
                measure_contrast(page, page.locator(".owned-agents [role=alert] p"), measurements, problems, f"contrast-owned-error-{key}")
                check_overflow(page, measurements, problems, f"overflow-owned-error-{key}")
                page.get_by_role("button", name="다시 시도").click()
                page.locator(".owned-agents [role=alert]").wait_for(state="hidden", timeout=30000)
                measurements[f"owned-retry-{key}"] = {"text": "아직 등록한 에이전트가 없습니다.", "retried": True}

                access_state.update(mode="error")
                page.goto(base + "/dialogues" + SETTINGS_QUERY, wait_until="domcontentloaded")
                sn.settle(page)
                page.get_by_role("button", name="외부 에이전트", exact=True).click(timeout=30000)
                page.get_by_text("아직 등록한 에이전트가 없습니다.", exact=True).wait_for(timeout=30000)
                select_tab(page, "접속 링크", width)
                page.get_by_text("링크 목록을 불러오지 못했습니다.", exact=True).wait_for(timeout=30000)
                shot(page, out, f"access-links-error-{key}", captures)
                measure_contrast(page, page.locator(".access-links [role=alert]"), measurements, problems, f"contrast-settings-alert-{key}", region="inside")
                access_state.update(mode="normal")
                page.get_by_role("button", name="다시 시도").click()
                page.get_by_text("외부 조사 도우미", exact=True).wait_for(timeout=30000)
                open_issue(page)
                page.get_by_role("combobox", name="대상 세션").click()
                page.get_by_role("option", name="세션 ID 직접 입력", exact=True).click()
                page.get_by_label("세션 ID").fill("bad")
                page.get_by_label("세션 ID").blur()
                page.get_by_text("세션 ID 형식이 아닙니다.", exact=True).wait_for()
                shot(page, out, f"access-links-field-error-{key}", captures)
                measure_contrast(page, page.locator(".access-links-form small[role=alert]"), measurements, problems, f"contrast-field-error-{key}")
                check_overflow(page, measurements, problems, f"overflow-field-error-{key}")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)

            measurements[f"pageErrors-{key}"] = page_errors
            context.close()


def run_outside_settings(browser, base: str, out: Path, captures: list[str], measurements: dict, problems: list[str]) -> None:
    """설정 창 밖 카탈로그 선택 상자: 컴포넌트 검수 창의 실행 모델(처음 값 Sol, 첫 항목 아님)."""
    context = browser.new_context(viewport={"width": WIDE, "height": 1000}, color_scheme="light", reduced_motion="reduce")
    sn.install_page(context, "light")
    page = context.new_page()
    page.goto(base + "/components", wait_until="domcontentloaded")
    page.get_by_role("combobox", name="실행 모델").wait_for(timeout=90000)
    page.wait_for_timeout(800)
    check_select_open(page, "실행 모델", measurements, problems, "select-components-wide-light", out, "catalog-open-components-1280-light", captures)
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="설정 창 정비 시각 검수")
    parser.add_argument("base", nargs="?", help="이미 띄운 개발 서버 주소")
    parser.add_argument("--serve", action="store_true", help="빈 포트에 Vite 를 띄운다")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.serve and not args.base:
        parser.error("개발 서버 주소나 --serve 가 필요합니다")
    args.output.mkdir(parents=True, exist_ok=True)
    server = None
    base = args.base or ""
    try:
        if args.serve:
            port = free_port()
            base = f"http://127.0.0.1:{port}"
            env = {**os.environ, "VITE_API_BASE": "http://127.0.0.1:9"}
            server = subprocess.Popen(
                ["corepack", "pnpm", "--dir", str(ROOT / "unified-dashboard"), "exec", "vite", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
                cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            wait_ready(base)
        captures: list[str] = []
        measurements: dict = {}
        problems: list[str] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            run(browser, base, args.output, captures, measurements, problems)
            run_outside_settings(browser, base, args.output, captures, measurements, problems)
            browser.close()
    finally:
        if server:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
    report = {
        "result": "pass" if not problems else "fail",
        "check_count": len(measurements),
        "captures": captures,
        "measurements": measurements,
        "problems": problems,
    }
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"result": report["result"], "check_count": report["check_count"], "problems": problems}, ensure_ascii=False))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

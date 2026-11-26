#!/usr/bin/env python3
"""세션 통계 제어 줄 시각 검수 (카드 #1752).

검수 번들(unified-dashboard/dist/assets/ios-components)을 빈 포트로 서빙하고,
앱 설정 > 세션 통계 화면에서 보기 피커와 측정·캐시 세그먼트 묶음의 배치를 잰다.

단언
  1) 자연 폭 합(간격 포함)이 줄 폭 - 1 이하면 셋이 반드시 한 줄이고 세로 가운데 차이 1px 이하,
     피커 왼쪽 끝과 카드 시작선 차이 1px 이하, 묶음 오른쪽 끝과 카드 끝선 차이 1px 이하
  2) 자연 폭 합이 줄 폭 + 1을 넘으면 반드시 넘어간 모양이고, 넘어간 줄의 첫 컨트롤 왼쪽 끝이
     카드 시작선과 1px 이하, 세그먼트 묶음은 컨트롤 단위로만 갈라진다(컨트롤 하나가 두 줄이 되지 않는다).
     줄 폭과의 차이가 ±1px 안이면 어느 쪽이어도 되지만, 그린 모양의 위치 단언은 그대로 지킨다
  3) 모든 폭에서 컨트롤 라벨 getClientRects().length == 1, 말줄임·잘림 없음, 겹침 없음, 가로 스크롤 없음
  4) 피커 폭이 가장 긴 선택지의 내용 폭과 같고, 같은 뷰포트와 테마에서 「모델별」과 「폴더별」의
     피커 폭 차이가 1px 이하다(남은 폭으로 늘어나지 않는다)
  5) 뷰포트 가운데 적어도 하나에서 1)의 한 줄 경우가, 적어도 하나에서 2)의 넘어간 경우가 나온다.
     320(작은 iPhone의 확대 표시 폭)이 넘어간 경우를 보장한다
  6) 같은 뷰포트와 테마에서 두 보기가 둘 다 한 줄이거나 둘 다 넘어간 모양이고,
     차트(usage-stats-*-chart-chart) 위쪽 끝 차이가 1px 이하다
  7) 조작 단언: 한 페이지에서 「모델별」→「폴더별」→「모델별」로 바꾸며 차트 위쪽 끝과 묶음 위치를
     전후로 재어 차이가 1px 이하다(320, 360, 390)
  8) 320, 360, 390에서 첫 진입과 기간 「주간」→「월간」 동안 layout-shift를 걸어, 출처에
     usage-stats-view-measure-bundle, 차트(usage-stats-*-chart-chart), 제어 줄이 든 이동이 0건이다.
     피커 폭을 그린 뒤에 재서 첫 그림이 다른 모양으로 한 프레임 그려지는 결함을 잡는다.
  9) 캐시 include 세그먼트의 보이는 글자는 「포함」, 접근성 이름(aria-label)은 「캐시 포함」이다.
     exclude는 둘 다 「캐시 제외」이고 측정 「토큰」·「정가」의 접근성 이름은 보이는 글자와 같다.

사용: python3 -P scripts/visual-check/usage_stats_controls.py --output <출력 폴더>
앞선 번들 내보내기는 scripts/visual-check/usage_stats_controls.sh가 맡는다.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
DIST_ROOT = REPO_ROOT / "unified-dashboard" / "dist"
VIEWPORTS = ((320, 700), (360, 800), (376, 812), (390, 844), (430, 932), (820, 1180))
THEMES = ("light", "dark")
PICKERS = (("model", "모델별"), ("project", "폴더별"))
TOLERANCE = 1.0
FIXED_NOW = "2026-10-18T12:00:00+09:00"
# 9) 세그먼트마다 (보이는 글자, 접근성 이름).
SEGMENT_EXPECTATIONS = {
    "measure-tokens": ("토큰", "토큰"),
    "measure-cost": ("정가", "정가"),
    "cache-read-exclude": ("캐시 제외", "캐시 제외"),
    "cache-read-include": ("포함", "캐시 포함"),
}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(DIST_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}/assets/ios-components/index.html"


def build_url(base: str, theme: str) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["nativeSettings"]
    query["entry"] = ["modal"]
    query["theme"] = [theme]
    query["state"] = ["ready"]
    query["usageStats"] = ["fixture"]
    return urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, parts.path,
        urllib.parse.urlencode(query, doseq=True), parts.fragment,
    ))


def install_routes(page: Page, base_netloc: str) -> None:
    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
            return
        if request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
            return
        route.abort()

    page.route("**/*", route_request)


MEASURE_SCRIPT = """
() => {
  const px = value => Number.parseFloat(value) || 0;
  const box = el => { const r = el.getBoundingClientRect(); return {
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
    cy: r.top + r.height / 2 }; };
  // 글자 상자는 요소 상자가 아니라 글리프 실측(Range)으로 잰다. 늘어난 요소 안에서
  // 가운데 정렬된 글자도 실제 글자 폭과 줄 수를 그대로 얻기 위해서다.
  const glyph = el => {
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5);
    const r = range.getBoundingClientRect();
    return {
      text: (el.textContent || '').trim(),
      rects: rects.length,
      width: r.width, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
    };
  };
  const q = id => document.querySelector(`[data-testid="${id}"]`);
  // 9) 세그먼트 칩의 보이는 글자와 접근성 이름(aria-label)을 함께 잰다.
  const segment = id => {
    const button = q(`settings-segment-usage-stats-${id}`);
    const label = q(`settings-segment-usage-stats-${id}-label`);
    return button && label
      ? { text: (label.textContent || '').trim(), ariaLabel: button.getAttribute('aria-label') }
      : null;
  };
  const row = q('usage-stats-view-measure-row');
  const card = q('usage-stats-models');
  const button = document.querySelector('[aria-label^="보기:"]');
  const bundle = q('usage-stats-view-measure-bundle');
  const measure = q('settings-segment-usage-stats-measure-track');
  const cache = q('settings-segment-usage-stats-cache-read-track');
  const chart = q('usage-stats-model-chart-chart') || q('usage-stats-project-chart-chart');
  if (!row || !card || !button || !measure || !cache) return { missing: true };
  const leaves = Array.from(button.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && (el.textContent || '').trim());
  const text = glyph(leaves[0] ?? null);
  const buttonStyle = getComputedStyle(button);
  const contentWidth = text
    ? text.width + px(buttonStyle.paddingLeft) + px(buttonStyle.paddingRight)
      + px(buttonStyle.borderLeftWidth) + px(buttonStyle.borderRightWidth)
    : null;
  const labels = {};
  for (const [group, values] of [['measure', ['tokens', 'cost']], ['cacheRead', ['exclude', 'include']]]) {
    for (const value of values) {
      const el = q(`settings-segment-usage-stats-${group === 'measure' ? 'measure' : 'cache-read'}-${value}-label`);
      labels[value] = el ? glyph(el) : null;
    }
  }
  const rowStyle = getComputedStyle(row);
  const doc = document.documentElement;
  return {
    row: box(row), card: box(card), picker: box(button), button: box(button),
    bundle: bundle ? box(bundle) : null,
    measure: box(measure), cache: box(cache), chart: chart ? box(chart) : null,
    pickerContentWidth: contentWidth,
    gap: px(rowStyle.columnGap) || px(rowStyle.gap), labels,
    rowScroll: { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
    documentScroll: {
      scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    },
    pickerText: text,
    segments: Object.fromEntries(
      ['measure-tokens', 'measure-cost', 'cache-read-exclude', 'cache-read-include']
        .map(id => [id, segment(id)])),
  };
}
"""

SCROLL_TOP_SCRIPT = """
() => {
  let el = document.querySelector('[data-testid="usage-stats-view-measure-row"]');
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 1) return el.scrollTop;
    el = el.parentElement;
  }
  return window.scrollY;
}
"""

FOCUS_SCRIPT = """
() => ({
  tag: document.activeElement?.tagName ?? null,
  label: document.activeElement?.getAttribute('aria-label') ?? null,
  testID: document.activeElement?.getAttribute('data-testid') ?? null,
})
"""


def same_line(a: dict, b: dict) -> bool:
    return min(a["bottom"], b["bottom"]) - max(a["top"], b["top"]) > 0


def judge(measurement: dict) -> tuple[list[str], dict]:
    """잰 값 하나를 단언 1)~3)으로 판정한다. (실패 목록, 판정 요약)을 돌려준다."""
    failures: list[str] = []
    picker = measurement["picker"]
    measure = measurement["measure"]
    cache = measurement["cache"]
    card = measurement["card"]
    gap = measurement["gap"]
    natural = picker["width"] + measure["width"] + cache["width"] + 2 * gap
    one_line = same_line(picker, measure) and same_line(measure, cache) and same_line(picker, cache)
    # 자연 폭 합이 줄 폭과 1px 안쪽 차이면 어느 모양이어도 된다. 그 밖에서는 모양이 정해진다.
    must_fit = natural <= card["width"] - TOLERANCE
    must_wrap = natural > card["width"] + TOLERANCE

    # 1) 들어가는 폭: 셋이 한 줄이어야 한다.
    if must_fit and not one_line:
        failures.append(f"1) 자연 폭 {natural:.1f} <= 줄 폭 {card['width']:.1f} - 1인데 한 줄이 아니다")

    # 2) 넘어가는 폭: 반드시 넘어간 모양이어야 한다.
    if must_wrap and one_line:
        failures.append(f"2) 자연 폭 {natural:.1f} > 줄 폭 {card['width']:.1f} + 1인데 한 줄이다")

    # 그린 모양(한 줄/넘어감)의 위치 단언. 경계 띠 안에서도 고른 모양은 그대로 지킨다.
    if one_line:
        # 1) 셋이 한 줄, 세로 가운데와 양 끝선.
        for name, other in (("측정", measure), ("캐시", cache)):
            if abs(picker["cy"] - other["cy"]) > TOLERANCE:
                failures.append(f"1) 피커와 {name} 세로 가운데 차이 {abs(picker['cy'] - other['cy']):.1f}px")
        if abs(picker["left"] - card["left"]) > TOLERANCE:
            failures.append(f"1) 피커 왼쪽 {picker['left']:.1f} != 카드 시작선 {card['left']:.1f}")
        if abs(cache["right"] - card["right"]) > TOLERANCE:
            failures.append(f"1) 묶음 오른쪽 {cache['right']:.1f} != 카드 끝선 {card['right']:.1f}")
    else:
        # 2) 묶음이 통째로 다음 줄, 카드 시작선에서 시작, 컨트롤 단위로만 갈라짐.
        if not same_line(measure, cache):
            failures.append("2) 넘어간 줄에서 측정과 캐시 컨트롤이 서로 다른 줄이다")
        if picker["bottom"] - measure["top"] > TOLERANCE:
            failures.append(f"2) 묶음이 다음 줄로 가지 않았다(피커 아래 {picker['bottom']:.1f}, 묶음 위 {measure['top']:.1f})")
        if abs(measure["left"] - card["left"]) > TOLERANCE:
            failures.append(f"2) 넘어간 줄 시작선 {measure['left']:.1f} != 카드 시작선 {card['left']:.1f}")
        if abs(picker["left"] - card["left"]) > TOLERANCE:
            failures.append(f"2) 피커 왼쪽 {picker['left']:.1f} != 카드 시작선 {card['left']:.1f}")

    # 3) 겹침, 잘림, 가로 스크롤. 컨트롤 하나가 두 줄이 되지 않는다.
    for name, pair in (("피커·측정", (picker, measure)), ("측정·캐시", (measure, cache)), ("피커·캐시", (picker, cache))):
        first, second = pair
        if same_line(first, second) and first["right"] - second["left"] > 0.5:
            failures.append(f"3) {name} 겹침 {first['right'] - second['left']:.1f}px")
    for value, label in measurement["labels"].items():
        if label is None:
            failures.append(f"3) 라벨 {value}를 찾지 못했다")
            continue
        if label["rects"] != 1:
            failures.append(f"3) 라벨 '{label['text']}' 줄 수 {label['rects']}")
        if label["scrollWidth"] - label["clientWidth"] > TOLERANCE:
            failures.append(f"3) 라벨 '{label['text']}' 잘림 {label['scrollWidth'] - label['clientWidth']}px")
    row_scroll = measurement["rowScroll"]
    if row_scroll["scrollWidth"] - row_scroll["clientWidth"] > TOLERANCE:
        failures.append(f"3) 줄 가로 넘침 {row_scroll['scrollWidth'] - row_scroll['clientWidth']}px")
    document_scroll = measurement["documentScroll"]
    for key in ("scrollWidth", "bodyScrollWidth"):
        if document_scroll[key] - document_scroll["clientWidth"] > TOLERANCE:
            failures.append(f"3) 문서 가로 스크롤 {key} {document_scroll[key]} > {document_scroll['clientWidth']}")

    # 피커 글자: 가장 긴 라벨도 한 줄로 잘리지 않고 피커 가운데에 선다.
    picker_text = measurement["pickerText"]
    if picker_text is None:
        failures.append("3) 피커 글자를 찾지 못했다")
    else:
        if picker_text["rects"] != 1:
            failures.append(f"3) 피커 라벨 '{picker_text['text']}' 줄 수 {picker_text['rects']}")
        if picker_text["scrollWidth"] - picker_text["clientWidth"] > TOLERANCE:
            failures.append(f"3) 피커 라벨 '{picker_text['text']}' 잘림 "
                            f"{picker_text['scrollWidth'] - picker_text['clientWidth']}px")
        text_center = (picker_text["left"] + picker_text["right"]) / 2
        button_center = (picker["left"] + picker["right"]) / 2
        if abs(text_center - button_center) > TOLERANCE:
            failures.append(f"3) 피커 라벨이 가운데에서 {abs(text_center - button_center):.1f}px 벗어난다")

    # 9) 캐시 include는 보이는 글자만 줄이고 접근성 이름은 「캐시 포함」을 지킨다.
    for key, (text, aria) in SEGMENT_EXPECTATIONS.items():
        segment = measurement.get("segments", {}).get(key)
        if segment is None:
            failures.append(f"9) 세그먼트 {key}를 찾지 못했다")
            continue
        if segment["text"] != text:
            failures.append(f"9) 세그먼트 {key}의 보이는 글자 '{segment['text']}' != '{text}'")
        if segment["ariaLabel"] != aria:
            failures.append(f"9) 세그먼트 {key}의 접근성 이름 '{segment['ariaLabel']}' != '{aria}'")

    return failures, {"natural": natural, "cardWidth": card["width"],
                      "mustFit": must_fit, "mustWrap": must_wrap, "oneLine": one_line}


def compare_views(measurements: dict[str, dict], failures: list[str]) -> None:
    """단언 4)·6): 같은 뷰포트·테마에서 두 보기를 견준다."""
    for width, _ in VIEWPORTS:
        for theme in THEMES:
            names = {view: f"{width}-{theme}-{view}" for view, _ in PICKERS}
            pair = {view: measurements.get(name) for view, name in names.items()}
            if any(m is None or m.get("missing") for m in pair.values()):
                continue
            model, project = pair["model"], pair["project"]
            widest = max(model["pickerContentWidth"] or 0, project["pickerContentWidth"] or 0)
            for view, m in pair.items():
                drift = m["button"]["width"] - widest
                if abs(drift) > TOLERANCE:
                    failures.append(f"{names[view]}: 4) 피커 폭 {m['button']['width']:.1f} != "
                                    f"가장 긴 선택지 내용 폭 {widest:.1f}")
            spread = abs(model["button"]["width"] - project["button"]["width"])
            if spread > TOLERANCE:
                failures.append(f"{width}-{theme}: 4) 두 보기의 피커 폭 차이 {spread:.1f}px")

            model_line = judge(model)[1]["oneLine"]
            project_line = judge(project)[1]["oneLine"]
            if model_line != project_line:
                failures.append(f"{width}-{theme}: 6) 보기에 따라 줄 모양이 다르다"
                                f"(「모델별」 한 줄={model_line}, 「폴더별」 한 줄={project_line})")
            chart_tops = {view: (m.get("chart") or {}).get("top") for view, m in pair.items()}
            if chart_tops["model"] is None or chart_tops["project"] is None:
                failures.append(f"{width}-{theme}: 6) 차트를 찾지 못했다")
            elif abs(chart_tops["model"] - chart_tops["project"]) > TOLERANCE:
                failures.append(f"{width}-{theme}: 6) 차트 위쪽 끝 차이 "
                                f"{abs(chart_tops['model'] - chart_tops['project']):.1f}px")


def open_usage_stats(page: Page, base: str, theme: str = "light") -> None:
    page.goto(build_url(base, theme))
    page.get_by_test_id("native-settings-review").wait_for()
    page.get_by_test_id("settings-category-usage-stats").click()
    page.get_by_test_id("usage-stats-view-measure-row").wait_for()
    page.get_by_test_id("usage-stats-total-tokens").wait_for()


def choose_view(page: Page, label: str) -> None:
    """보기 피커에서 라벨을 고른다. 이미 골라져 있으면 그대로 둔다."""
    trigger = page.locator('[aria-label^="보기:"]')
    trigger.wait_for()
    if trigger.get_attribute("aria-label") == f"보기: {label}":
        return
    trigger.click()
    page.get_by_label(label, exact=True).click()
    page.get_by_label(f"보기: {label}", exact=True).wait_for()


def capture(page: Page, out_dir: Path, name: str, store: dict) -> dict:
    row = page.get_by_test_id("usage-stats-view-measure-row")
    row.scroll_into_view_if_needed()
    page.wait_for_timeout(120)
    measurement = page.evaluate(MEASURE_SCRIPT)
    page.screenshot(path=str(out_dir / f"{name}.png"))
    store[name] = measurement
    return measurement


def run_interactions(browser, base: str, out_dir: Path, failures: list[str], store: dict) -> None:
    """ui-design 0절 14·15·18번: 누른 뒤 초점, Esc와 Tab, 창 크기 바꾸기."""
    for width, height in ((376, 812), (390, 844)):
        context = browser.new_context(viewport={"width": width, "height": height},
                                      color_scheme="light", reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(20000)
        install_routes(page, urllib.parse.urlsplit(base).netloc)
        page.clock.set_fixed_time(FIXED_NOW)
        open_usage_stats(page, base)
        choose_view(page, "폴더별")

        # 14) Tab 순서는 피커 다음이 측정 세그먼트다.
        page.get_by_label("보기: 폴더별", exact=True).focus()
        page.keyboard.press("Tab")
        focus = page.evaluate(FOCUS_SCRIPT)
        store[f"interaction-{width}-focus-after-tab"] = focus
        if focus["testID"] != "settings-segment-usage-stats-measure-tokens":
            failures.append(f"15) {width}: 피커 다음 Tab이 측정 세그먼트가 아니라 {focus['testID'] or focus['tag']}에 있다")

        # 15) Esc로 시트가 닫힌다. 닫기 뒤 초점은 공용 Modal이 정하므로 잰 값만 남긴다.
        page.get_by_label("보기: 폴더별", exact=True).click()
        page.get_by_label("보기 검색", exact=True).wait_for()
        page.keyboard.press("Escape")
        page.get_by_label("보기 검색", exact=True).wait_for(state="detached")
        focus = page.evaluate(FOCUS_SCRIPT)
        store[f"interaction-{width}-focus-after-escape"] = focus
        if focus["label"] == "보기 검색":
            failures.append(f"15) {width}: Esc로 시트를 닫은 뒤에도 초점이 시트 안에 남아 있다")
        # 겹친 Modal이 Esc를 함께 받아 설정 창까지 닫히면 이어서 다시 연다.
        if page.locator('[data-testid="usage-stats-view-measure-row"]').count() == 0:
            open_usage_stats(page, base)

        # 18) 창 폭을 바꿔도 그 폭의 배치로 다시 서고 스크롤 위치가 유지된다.
        scroll_before = page.evaluate(SCROLL_TOP_SCRIPT)
        for resize_width, resize_height in ((360, 800), (390, 844)):
            page.set_viewport_size({"width": resize_width, "height": resize_height})
            # 폭이 바뀌면 설정 화면이 다시 서고 통계도 다시 받는다. 다 그려진 뒤에 잰다.
            page.get_by_test_id("usage-stats-view-measure-row").wait_for()
            page.get_by_test_id("usage-stats-total-tokens").wait_for()
            page.wait_for_timeout(200)
            measurement = page.evaluate(MEASURE_SCRIPT)
            store[f"interaction-{resize_width}-layout"] = measurement
            if measurement.get("missing"):
                failures.append(f"18) {resize_width}: 크기를 바꾼 뒤 제어 줄 요소를 찾지 못했다")
                continue
            found, summary = judge(measurement)
            failures.extend(f"18) {resize_width}: {item}" for item in found)
            # 360은 자연 폭 합이 줄 폭과 같은 경계라 어느 모양이어도 된다(단언 1·2의 경계 규칙).
            # 390은 자연 폭이 줄 폭보다 확실히 작으므로 한 줄이어야 한다.
            if resize_width >= 390 and not summary["oneLine"]:
                failures.append(f"18) {resize_width}: 배치가 다시 서지 않았다(한 줄 기대 True)")
        scroll_after = page.evaluate(SCROLL_TOP_SCRIPT)
        store[f"interaction-{width}-scroll"] = {"before": scroll_before, "after": scroll_after}
        if abs(scroll_before - scroll_after) > 1:
            failures.append(f"18) {width}: 창 크기를 바꾼 뒤 스크롤 위치가 {scroll_before}에서 {scroll_after}로 바뀌었다")
        page.screenshot(path=str(out_dir / f"interaction-{width}.png"))
        context.close()


def run_view_switch(browser, base: str, failures: list[str], store: dict) -> None:
    """단언 7): 한 페이지에서 보기를 바꿔도 차트 위쪽 끝과 묶음 자리가 그대로다. 320, 360, 390."""
    for width, height in ((320, 700), (360, 800), (390, 844)):
        context = browser.new_context(viewport={"width": width, "height": height},
                                      color_scheme="light", reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(20000)
        install_routes(page, urllib.parse.urlsplit(base).netloc)
        page.clock.set_fixed_time(FIXED_NOW)
        open_usage_stats(page, base)
        states: list[dict] = []
        for label in ("모델별", "폴더별", "모델별"):
            choose_view(page, label)
            page.get_by_test_id("usage-stats-project-chart-chart" if label == "폴더별"
                                else "usage-stats-model-chart-chart").wait_for()
            page.wait_for_timeout(200)
            measurement = page.evaluate(MEASURE_SCRIPT)
            states.append({
                "label": label,
                "chart": measurement.get("chart"),
                "measure": measurement["measure"],
                "cache": measurement["cache"],
            })
        store[f"interaction-{width}-view-switch"] = states
        chart_tops = [state["chart"]["top"] if state["chart"] else None for state in states]
        if any(value is None for value in chart_tops):
            failures.append(f"7) {width}: 차트를 찾지 못했다")
        else:
            spread = max(chart_tops) - min(chart_tops)
            if spread > TOLERANCE:
                failures.append(f"7) {width}: 보기를 바꾸면 차트 위쪽 끝이 {spread:.1f}px 움직인다"
                                + " (" + ", ".join(f"{value:.1f}" for value in chart_tops) + ")")
        for key in ("measure", "cache"):
            for field in ("top", "left", "right"):
                values = [state[key][field] for state in states]
                spread = max(values) - min(values)
                if spread > TOLERANCE:
                    failures.append(f"7) {width}: 보기를 바꾸면 {key}.{field}가 {spread:.1f}px 움직인다"
                                    + " (" + ", ".join(f"{value:.1f}" for value in values) + ")")
        context.close()

SHIFT_OBSERVER = """
(() => {
  window.__shifts = [];
  const watched = '[data-testid="usage-stats-view-measure-bundle"], [data-testid="usage-stats-view-measure-row"], [data-testid$="-chart-chart"]';
  const describe = source => {
    // 글자 노드가 출처로 오면 그 부모 요소로 판정한다.
    const node = source && source.nodeType === 3 ? source.parentElement : source;
    if (!node || !node.closest) return { node: node ? node.nodeName : null, watched: false };
    const own = node.closest('[data-testid]');
    return { node: (own ? own.getAttribute('data-testid') : '') + '|' + (node.getAttribute('aria-label') || (node.textContent || '').slice(0, 16)),
             watched: !!node.closest(watched) };
  };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      window.__shifts.push({
        t: Math.round(entry.startTime), value: entry.value, hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources || []).map(source => ({
          ...describe(source.node),
          prev: [Math.round(source.previousRect.x), Math.round(source.previousRect.y), Math.round(source.previousRect.width)],
          cur: [Math.round(source.currentRect.x), Math.round(source.currentRect.y), Math.round(source.currentRect.width)],
        })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
})();
"""


def run_layout_shift(browser, base: str, failures: list[str], store: dict) -> None:
    """단언 8): 첫 진입과 기간 전환 동안 제어 줄과 차트가 그려진 뒤에 움직이지 않는다. 320, 360, 390.

    브라우저는 입력 직후 500ms의 이동에 hadRecentInput을 달아 누적값에서 빼지만, 이 단언은
    그 표시와 상관없이 모든 이동을 센다. 기간 전환이 곧 입력이기 때문이다.
    """
    for width, height in ((320, 700), (360, 800), (390, 844)):
        context = browser.new_context(viewport={"width": width, "height": height},
                                      color_scheme="dark", reduced_motion="reduce")
        context.add_init_script(SHIFT_OBSERVER)
        page = context.new_page()
        page.set_default_timeout(20000)
        install_routes(page, urllib.parse.urlsplit(base).netloc)
        page.clock.set_fixed_time(FIXED_NOW)
        page.goto(build_url(base, "dark"))
        page.get_by_test_id("native-settings-review").wait_for()
        page.get_by_test_id("settings-category-usage-stats").click()
        page.get_by_test_id("usage-stats-view-measure-row").wait_for()
        page.get_by_test_id("usage-stats-total-tokens").wait_for()
        page.wait_for_timeout(800)
        first = page.evaluate("() => window.__shifts.splice(0)")
        page.get_by_text("월간", exact=True).click()
        page.wait_for_timeout(1200)
        period = page.evaluate("() => window.__shifts.splice(0)")
        store[f"layout-shift-{width}"] = {"firstEntry": first, "periodSwitch": period}
        for scene, entries in (("첫 진입", first), ("기간 전환", period)):
            hits = [entry for entry in entries if any(source["watched"] for source in entry["sources"])]
            print(f"layout-shift {width} {scene}: 이동 {len(entries)}건, 제어 줄·차트 관련 {len(hits)}건")
            if hits:
                value = sum(entry["value"] for entry in hits)
                moved = [source["node"] for entry in hits for source in entry["sources"] if source["watched"]]
                failures.append(f"8) {width}: {scene}에 제어 줄·차트가 그려진 뒤 움직였다 {len(hits)}건"
                                f"(값 {value:.4f}, 출처 {sorted(set(moved))[:3]})")
        context.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="캡처와 측정값을 둘 폴더")
    args = parser.parse_args()
    out_dir = Path(args.output).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if not (DIST_ROOT / "assets" / "ios-components" / "index.html").exists():
        print(f"검수 번들이 없습니다: {DIST_ROOT / 'assets' / 'ios-components'}"
              " — npm --prefix soul-app run export:components를 먼저 실행하십시오")
        return 2

    server, base = start_server()
    failures: list[str] = []
    measurements: dict[str, dict] = {}
    picker_widths: dict[str, list[float]] = {}
    one_line_seen = False
    wrapped_seen = False
    combos = 0
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width, height in VIEWPORTS:
                    for theme in THEMES:
                        for picker_id, picker_label in PICKERS:
                            combos += 1
                            name = f"{width}-{theme}-{picker_id}"
                            context = browser.new_context(
                                viewport={"width": width, "height": height},
                                color_scheme=theme, reduced_motion="reduce",
                            )
                            page = context.new_page()
                            page.set_default_timeout(20000)
                            install_routes(page, urllib.parse.urlsplit(base).netloc)
                            # 공개 픽스처의 사용 기록은 2026-10-18까지 있다. 시계를 그 주에 두어
                            # 기본 주간 화면이 운영 형태의 큰 숫자로 그려지게 한다.
                            page.clock.set_fixed_time(FIXED_NOW)
                            page.goto(build_url(base, theme))
                            page.get_by_test_id("native-settings-review").wait_for()
                            page.get_by_test_id("settings-category-usage-stats").click()
                            page.get_by_test_id("usage-stats-view-measure-row").wait_for()
                            page.get_by_test_id("usage-stats-total-tokens").wait_for()
                            choose_view(page, picker_label)
                            page.evaluate("() => document.fonts.ready")

                            measurement = capture(page, out_dir, name, measurements)
                            if measurement.get("missing"):
                                failures.append(f"{name}: 제어 줄 요소를 찾지 못했다")
                                context.close()
                                continue
                            found, summary = judge(measurement)
                            failures.extend(f"{name}: {item}" for item in found)
                            if summary["oneLine"]:
                                one_line_seen = True
                            else:
                                wrapped_seen = True
                            # 폰/태블릿은 여백 토큰이 달라 같은 무리 안에서만 폭을 견준다.
                            device = "phone" if width < 600 else "tablet"
                            picker_widths.setdefault(f"{device}/{picker_id}", []).append(
                                measurement["button"]["width"])
                            print(f"{name}: 줄 {summary['cardWidth']:.1f}, 자연 {summary['natural']:.1f}, "
                                  f"{'한 줄' if summary['oneLine'] else '묶음 다음 줄'}, 실패 {len(found)}")
                            context.close()

                compare_views(measurements, failures)
                print("[usage-stats] 조작 항목 7·8·14·15·18")
                run_view_switch(browser, base, failures, measurements)
                run_layout_shift(browser, base, failures, measurements)
                run_interactions(browser, base, out_dir, failures, measurements)
            finally:
                browser.close()
    finally:
        server.shutdown()

    # 피커 폭이 내용 폭이면 같은 여백 토큰 안에서 뷰포트가 달라도 같아야 한다.
    for picker_id, widths in picker_widths.items():
        spread = max(widths) - min(widths)
        if spread > TOLERANCE:
            failures.append(f"4) '{picker_id}' 피커 폭이 뷰포트에 따라 {spread:.1f}px 달라진다: "
                            + ", ".join(f"{value:.1f}" for value in widths))
    # 5) 한 줄 경우와 넘어간 경우가 각각 한 번은 실제로 나온다.
    if not one_line_seen:
        failures.append("5) 어떤 뷰포트에서도 세 컨트롤이 한 줄이 되지 않았다")
    if not wrapped_seen:
        failures.append("5) 어떤 뷰포트에서도 묶음이 다음 줄로 가지 않았다")

    (out_dir / "measurements.json").write_text(
        json.dumps(measurements, ensure_ascii=False, indent=1), encoding="utf-8")
    summary_path = out_dir / "summary.txt"
    lines = [f"조합 {combos}개", f"실패 {len(failures)}건", *failures]
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

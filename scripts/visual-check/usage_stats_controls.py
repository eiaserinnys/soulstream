#!/usr/bin/env python3
"""세션 통계 제어 줄 시각 검수 (카드 #1752).

검수 번들(unified-dashboard/dist/assets/ios-components)을 빈 포트로 서빙하고,
앱 설정 > 세션 통계 화면에서 보기 피커와 측정·캐시 세그먼트 묶음의 배치를 잰다.

단언
  1) 세 컨트롤의 자연 폭 합(간격 포함)이 줄 폭 이하면 셋이 한 줄이고 세로 가운데 차이 1px 이하,
     피커 왼쪽 끝과 카드 시작선 차이 1px 이하, 묶음 오른쪽 끝과 카드 끝선 차이 1px 이하
  2) 넘어가는 폭에서는 넘어간 줄의 첫 컨트롤 왼쪽 끝이 카드 시작선과 1px 이하,
     세그먼트 묶음은 컨트롤 단위로만 갈라진다(컨트롤 하나가 두 줄이 되지 않는다)
  3) 모든 폭에서 컨트롤 라벨 getClientRects().length == 1, 말줄임·잘림 없음, 겹침 없음, 가로 스크롤 없음
  4) 피커 폭이 자기 내용 폭과 같다(남은 폭으로 늘어나지 않는다)
  5) 네 뷰포트 가운데 적어도 하나에서 1)의 한 줄 경우가 실제로 나온다

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
BUNDLE_PREFIX = "/assets/ios-components/"
VIEWPORTS = ((360, 800), (390, 844), (430, 932), (820, 1180))
THEMES = ("light", "dark")
PICKERS = (("model", "모델별"), ("project", "프로젝트별"))
TOLERANCE = 1.0
FIXED_NOW = "2026-10-18T12:00:00+09:00"


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
  const q = id => document.querySelector(`[data-testid="${id}"]`);
  const row = q('usage-stats-view-measure-row');
  const card = q('usage-stats-models');
  const button = document.querySelector('[aria-label^="보기:"]');
  const bundle = q('usage-stats-view-measure-bundle');
  const measure = q('settings-segment-usage-stats-measure-track');
  const cache = q('settings-segment-usage-stats-cache-read-track');
  if (!row || !card || !button || !measure || !cache) return { missing: true };
  const leaves = Array.from(button.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && (el.textContent || '').trim());
  const text = leaves[0] ?? null;
  const buttonStyle = getComputedStyle(button);
  const contentWidth = text
    ? box(text).width + px(buttonStyle.paddingLeft) + px(buttonStyle.paddingRight)
      + px(buttonStyle.borderLeftWidth) + px(buttonStyle.borderRightWidth)
    : null;
  const labels = {};
  for (const [group, values] of [['measure', ['tokens', 'cost']], ['cacheRead', ['exclude', 'include']]]) {
    for (const value of values) {
      const el = q(`settings-segment-usage-stats-${group === 'measure' ? 'measure' : 'cache-read'}-${value}-label`);
      labels[value] = el ? {
        rects: el.getClientRects().length,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        text: (el.textContent || '').trim(),
      } : null;
    }
  }
  const rowStyle = getComputedStyle(row);
  const doc = document.documentElement;
  return {
    row: box(row), card: box(card), picker: box(button), button: box(button),
    bundle: bundle ? box(bundle) : null,
    measure: box(measure), cache: box(cache), pickerContentWidth: contentWidth,
    gap: px(rowStyle.columnGap) || px(rowStyle.gap), labels,
    rowScroll: { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
    documentScroll: {
      scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    },
    pickerText: text ? {
      text: (text.textContent || '').trim(),
      rects: text.getClientRects().length,
      clientWidth: text.clientWidth,
      scrollWidth: text.scrollWidth,
    } : null,
  };
}
"""


def same_line(a: dict, b: dict) -> bool:
    return min(a["bottom"], b["bottom"]) - max(a["top"], b["top"]) > 0


def judge(measurement: dict) -> tuple[list[str], dict]:
    """잰 값 하나를 단언 1)~4)로 판정한다. (실패 목록, 판정 요약)을 돌려준다."""
    failures: list[str] = []
    picker = measurement["picker"]
    measure = measurement["measure"]
    cache = measurement["cache"]
    card = measurement["card"]
    gap = measurement["gap"]
    natural = picker["width"] + measure["width"] + cache["width"] + 2 * gap
    fits = natural <= card["width"] + TOLERANCE
    one_line = same_line(picker, measure) and same_line(measure, cache) and same_line(picker, cache)

    # 1) 들어가는 폭: 셋이 한 줄, 세로 가운데와 양 끝선.
    if fits:
        if not one_line:
            failures.append(f"1) 자연 폭 {natural:.1f} <= 줄 폭 {card['width']:.1f}인데 한 줄이 아니다")
        else:
            for name, other in (("측정", measure), ("캐시", cache)):
                if abs(picker["cy"] - other["cy"]) > TOLERANCE:
                    failures.append(f"1) 피커와 {name} 세로 가운데 차이 {abs(picker['cy'] - other['cy']):.1f}px")
            if abs(picker["left"] - card["left"]) > TOLERANCE:
                failures.append(f"1) 피커 왼쪽 {picker['left']:.1f} != 카드 시작선 {card['left']:.1f}")
            if abs(cache["right"] - card["right"]) > TOLERANCE:
                failures.append(f"1) 묶음 오른쪽 {cache['right']:.1f} != 카드 끝선 {card['right']:.1f}")

    # 2) 넘어가는 폭: 묶음이 통째로 다음 줄, 카드 시작선에서 시작, 컨트롤 단위로만 갈라짐.
    if not fits:
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

    # 4) 피커는 내용 폭이고, 가장 긴 라벨도 한 줄로 잘리지 않는다.
    picker_text = measurement["pickerText"]
    if picker_text is None:
        failures.append("4) 피커 글자를 찾지 못했다")
    else:
        if picker_text["rects"] != 1:
            failures.append(f"4) 피커 라벨 '{picker_text['text']}' 줄 수 {picker_text['rects']}")
        if picker_text["scrollWidth"] - picker_text["clientWidth"] > TOLERANCE:
            failures.append(f"4) 피커 라벨 '{picker_text['text']}' 잘림 "
                            f"{picker_text['scrollWidth'] - picker_text['clientWidth']}px")
    if measurement["pickerContentWidth"] is None:
        failures.append("4) 피커 글자를 찾지 못했다")
    else:
        drift = measurement["button"]["width"] - measurement["pickerContentWidth"]
        if abs(drift) > TOLERANCE:
            failures.append(f"4) 피커 폭 {measurement['button']['width']:.1f} != 내용 폭 {measurement['pickerContentWidth']:.1f}")

    return failures, {"natural": natural, "cardWidth": card["width"], "fits": fits, "oneLine": one_line}


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


def open_usage_stats(page: Page, base: str) -> None:
    page.goto(build_url(base, "light"))
    page.get_by_test_id("native-settings-review").wait_for()
    page.get_by_test_id("settings-category-usage-stats").click()
    page.get_by_test_id("usage-stats-view-measure-row").wait_for()
    page.get_by_test_id("usage-stats-total-tokens").wait_for()


def run_interactions(browser, base: str, out_dir: Path, failures: list[str], store: dict) -> None:
    """ui-design 0절 14·15·18번: 누른 뒤 초점, Esc와 Tab, 창 크기 바꾸기."""
    for width, height in ((390, 844), (820, 1180)):
        context = browser.new_context(viewport={"width": width, "height": height},
                                      color_scheme="light", reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(20000)
        install_routes(page, urllib.parse.urlsplit(base).netloc)
        page.clock.set_fixed_time(FIXED_NOW)
        open_usage_stats(page, base)

        # 14) 고른 뒤 초점이 연 요소(피커)로 돌아온다.
        page.get_by_label("보기: 모델별", exact=True).click()
        page.get_by_label("프로젝트별", exact=True).click()
        page.get_by_label("보기: 프로젝트별", exact=True).wait_for()
        focus = page.evaluate(FOCUS_SCRIPT)
        store[f"interaction-{width}-focus-after-select"] = focus
        if focus["label"] != "보기: 프로젝트별":
            failures.append(f"14) {width}: 선택 뒤 초점이 피커가 아니라 {focus['label'] or focus['tag']}에 있다")

        # 15) Tab 순서는 피커 다음이 측정 세그먼트다.
        page.get_by_label("보기: 프로젝트별", exact=True).focus()
        page.keyboard.press("Tab")
        focus = page.evaluate(FOCUS_SCRIPT)
        store[f"interaction-{width}-focus-after-tab"] = focus
        if focus["testID"] != "settings-segment-usage-stats-measure-tokens":
            failures.append(f"15) {width}: 피커 다음 Tab이 측정 세그먼트가 아니라 {focus['testID'] or focus['tag']}에 있다")

        # 15) Esc로 시트가 닫힌다. 닫기 뒤 초점은 공용 Modal이 정하므로 잰 값만 남긴다.
        page.get_by_label("보기: 프로젝트별", exact=True).click()
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
        for resize_width, resize_height, expect_one_line in ((360, 800, False), (390, 844, True)):
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
            if summary["oneLine"] != expect_one_line:
                failures.append(f"18) {resize_width}: 배치가 다시 서지 않았다(한 줄 기대 {expect_one_line})")
        scroll_after = page.evaluate(SCROLL_TOP_SCRIPT)
        store[f"interaction-{width}-scroll"] = {"before": scroll_before, "after": scroll_after}
        if abs(scroll_before - scroll_after) > 1:
            failures.append(f"18) {width}: 창 크기를 바꾼 뒤 스크롤 위치가 {scroll_before}에서 {scroll_after}로 바뀌었다")
        page.screenshot(path=str(out_dir / f"interaction-{width}.png"))
        context.close()


def capture(page: Page, out_dir: Path, name: str, store: dict) -> dict:
    row = page.get_by_test_id("usage-stats-view-measure-row")
    row.scroll_into_view_if_needed()
    page.wait_for_timeout(120)
    measurement = page.evaluate(MEASURE_SCRIPT)
    page.screenshot(path=str(out_dir / f"{name}.png"))
    store[name] = measurement
    return measurement


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
                            page.get_by_label("보기: 모델별", exact=True).click()
                            page.get_by_label(picker_label, exact=True).click()
                            page.get_by_label(f"보기: {picker_label}", exact=True).wait_for()
                            page.evaluate("() => document.fonts.ready")

                            measurement = capture(page, out_dir, name, measurements)
                            if measurement.get("missing"):
                                failures.append(f"{name}: 제어 줄 요소를 찾지 못했다")
                                context.close()
                                continue
                            found, summary = judge(measurement)
                            failures.extend(f"{name}: {item}" for item in found)
                            if summary["fits"] and summary["oneLine"]:
                                one_line_seen = True
                            # 폰/태블릿은 여백 토큰이 달라 같은 무리 안에서만 폭을 견준다.
                            device = "phone" if width < 600 else "tablet"
                            picker_widths.setdefault(f"{device}/{picker_id}", []).append(
                                measurement["button"]["width"])
                            print(f"{name}: 줄 {summary['cardWidth']:.1f}, 자연 {summary['natural']:.1f}, "
                                  f"{'한 줄' if summary['fits'] else '묶음 다음 줄'}, 실패 {len(found)}")
                            context.close()
                print("[usage-stats] 조작 항목 14·15·18")
                run_interactions(browser, base, out_dir, failures, measurements)
            finally:
                browser.close()
    finally:
        server.shutdown()

    # 4) 피커 폭은 내용 폭이므로 같은 여백 토큰 안에서는 뷰포트가 달라도 같아야 한다.
    for picker_id, widths in picker_widths.items():
        spread = max(widths) - min(widths)
        if spread > TOLERANCE:
            failures.append(f"4) '{picker_id}' 피커 폭이 뷰포트에 따라 {spread:.1f}px 달라진다: "
                            + ", ".join(f"{value:.1f}" for value in widths))
    # 5) 적어도 한 뷰포트에서 한 줄 경우가 실제로 나온다.
    if not one_line_seen:
        failures.append("5) 네 뷰포트 어디에서도 세 컨트롤이 한 줄이 되지 않았다")

    (out_dir / "measurements.json").write_text(
        json.dumps(measurements, ensure_ascii=False, indent=1), encoding="utf-8")
    summary_path = out_dir / "summary.txt"
    lines = [f"조합 {combos}개", f"실패 {len(failures)}건", *failures]
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

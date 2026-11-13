#!/usr/bin/env python3
"""설정 구역 시작선·간격, 오류 줄과 경고 배지 대비 시각 검수 (카드 #1298 보완 2차).

`/dialogues?sample=settings`에서

  - 노드, 반복 작업, 영구 에이전트 세션 구역의 첫 상자가 제목과 내용 영역 선(.config-detail의 안쪽 여백 끝)에서
    시작하고 끝나는지, 설명과 첫 상자 사이 간격이 구역마다 같은지 (1280, 360),
  - 라이트와 다크에서 cogito 실패 줄, Claude 계정 행 오류 줄(actionError), 경고 배지(수집 지연, 해제 시각, Timeout)의
    글자 대비가 4.5:1 이상인지 (계산된 글자색과, 겹친 배경색을 합성한 값으로 잰다. 캡처 픽셀 값은 참고용이다)

를 캡처와 좌표로 잰다.

실행 (저장소 루트에서, settings_nodes_run.sh가 vite를 띄워 이 스크립트를 함께 돌린다)

    python3 -P unified-dashboard/scripts/visual-check/settings_nodes_layout.py \
        http://127.0.0.1:5183 /path/to/output

    # 고치기 전의 오류 줄·배지 색(`.c724-pool-error` red-300, `.c724-badge-warn` 58%)을 같은 화면에 덮어 전후를 비교한다.
    python3 -P unified-dashboard/scripts/visual-check/settings_nodes_layout.py \
        http://127.0.0.1:5183 /path/to/output-before --mode before

산출물

    {출력}/startline-{구역}-{폭}-{테마}.png      구역 첫 화면
    {출력}/contrast-{대상}-{테마}[-before].png    대비를 잰 줄이나 배지가 든 화면
    {출력}/layout.json                           좌표와 대비 수치, 판정

after 모드에서 시작선 차이가 1px을 넘거나, 간격이 구역마다 다르거나, 대비가 4.5 미만이면 종료 코드 1로 끝난다.
before 모드는 고치기 전 색에서 대비가 4.5 미만임을 확인하면 0으로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import settings_nodes as sn  # noqa: E402

START_DELTA_MAX_PX = 1.0
GAP_DELTA_MAX_PX = 1.0
CONTRAST_MIN = 4.5
TABS = ("노드", "반복 작업", "영구 에이전트 세션")
# 고치기 전 공용 규칙을 그대로 덮어 전후를 같은 화면에서 비교한다.
BEFORE_CSS = (
    ".c724-pool-error { color: var(--color-red-300) !important; }\n"
    ".c724-badge-warn { color: color-mix(in oklch, var(--color-amber-500) 58%, var(--foreground)) !important; }\n"
)

START_PROBE = r"""
() => {
  const detail = document.querySelector('.config-detail');
  const cs = getComputedStyle(detail);
  const d = detail.getBoundingClientRect();
  const left = d.left + parseFloat(cs.paddingLeft);
  const right = d.right - parseFloat(cs.paddingRight) - (detail.offsetWidth - detail.clientWidth);
  const heading = detail.querySelector('.config-detail-heading');
  const h2 = heading.querySelector('h2').getBoundingClientRect();
  const p = heading.querySelector('p');
  const descBottom = p ? p.getBoundingClientRect().bottom : heading.getBoundingClientRect().bottom;
  const block = heading.nextElementSibling;
  let first = null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n && !first; n = walker.nextNode()) {
    const s = getComputedStyle(n);
    const box = n.getBoundingClientRect();
    const framed = parseFloat(s.borderLeftWidth) > 0 && s.borderLeftStyle !== 'none';
    const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
    if (box.width > 0 && box.height > 0 && (framed || filled)) {
      first = {testId: n.getAttribute('data-testid'), x: box.left, r: box.right, y: box.top};
    }
  }
  return {
    lineLeft: left, lineRight: right, h2Left: h2.left, descBottom,
    first, gap: first ? first.y - descBottom : null,
  };
}
"""

# 계산된 글자색을 캔버스로 sRGB 8비트로 풀고, 겹친 배경색(투명도 포함)을 아래에서 위로 합성한다.
CONTRAST_JS = r"""
(el) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat([a]);
  };
  const chain = [];
  for (let n = el; n; n = n.parentElement) chain.push(getComputedStyle(n).backgroundColor);
  let bg = [255, 255, 255, 1];
  for (const css of chain.reverse()) {
    const c = rgba(css);
    if (c[3] > 0) bg = over(c, bg);
  }
  const fgCss = getComputedStyle(el).color;
  const fg = over(rgba(fgCss), bg);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const hi = Math.max(lum(fg), lum(bg)), lo = Math.min(lum(fg), lum(bg));
  return {
    text: (el.textContent || '').trim().slice(0, 60),
    color: fgCss,
    fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round),
    ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2),
  };
}
"""


def pixel_ratio(png: bytes) -> float | None:
    """캡처 픽셀 교차 확인. 가장 흔한 색을 배경으로, 배경과 가장 먼 색을 글자색으로 본다(참고용)."""
    try:
        import io

        from PIL import Image
    except ImportError:
        return None
    image = Image.open(io.BytesIO(png)).convert("RGB")
    pixels = image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
    counts = Counter(pixels)
    bg = counts.most_common(1)[0][0]

    def lin(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    def lum(rgb: tuple[int, int, int]) -> float:
        return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])

    def ratio(a, b) -> float:
        hi, lo = max(lum(a), lum(b)), min(lum(a), lum(b))
        return (hi + 0.05) / (lo + 0.05)

    fg = max(counts, key=lambda px: ratio(px, bg))
    return round(ratio(fg, bg), 2)


def measure(page: Page, locator, out: Path, name: str, before: bool) -> dict:
    locator.scroll_into_view_if_needed()
    data = locator.evaluate(CONTRAST_JS)
    png = locator.screenshot(animations="disabled")
    data["pixelRatio"] = pixel_ratio(png)
    page.screenshot(path=str(out / f"{name}{'-before' if before else ''}.png"), animations="disabled")
    return data


def start_lines(browser, base: str, out: Path) -> dict:
    result: dict = {}
    for width in (sn.WIDE, sn.NARROW):
        for theme in sn.THEMES:
            key = f"{width}-{theme}"
            result[key] = {}
            context = sn.new_context(browser, width, theme)
            page = context.new_page()
            for tab in TABS:
                page.goto(f"{base}/dialogues?sample=settings")
                sn.settle(page)
                page.get_by_role("button", name=tab, exact=True).click()
                page.wait_for_timeout(900)
                data = page.evaluate(START_PROBE)
                page.screenshot(path=str(out / f"startline-{tab.replace(' ', '_')}-{key}.png"), animations="disabled")
                result[key][tab] = data
            context.close()
    return result


def contrast_cases(browser, base: str, out: Path, before: bool) -> dict:
    result: dict = {}
    for theme in sn.THEMES:
        result[theme] = {}

        # cogito 실패 줄 (설정 노드 구역)
        context = sn.new_context(browser, sn.WIDE, theme)
        page = context.new_page()
        if before:
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded', () => {"
                f"const s = document.createElement('style'); s.textContent = {json.dumps(BEFORE_CSS)}; document.head.appendChild(s);"
                "});"
            )
        sn.open_settings_nodes(page, base, "failure")
        sn.expand_node(page, sn.SAMPLE_NODE)
        page.wait_for_selector('[data-node-state="error"]', state="visible", timeout=15_000)
        page.wait_for_timeout(700)
        sn.scroll_cogito_into_view(page)
        line = page.locator('[data-testid="cogito-node-health"] .c724-pool-error').first
        result[theme]["cogitoFailureLine"] = measure(page, line, out, f"contrast-cogito-failure-{theme}", before)
        context.close()

        # cogito Timeout 배지 (warn)
        context = sn.new_context(browser, sn.WIDE, theme)
        page = context.new_page()
        if before:
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded', () => {"
                f"const s = document.createElement('style'); s.textContent = {json.dumps(BEFORE_CSS)}; document.head.appendChild(s);"
                "});"
            )
        sn.open_settings_nodes(page, base)
        sn.expand_node(page, sn.SAMPLE_TIMEOUT_NODE)
        page.wait_for_selector(f'[data-testid="cogito-node-health"][data-node-id="{sn.SAMPLE_TIMEOUT_NODE}"]', state="visible")
        page.wait_for_timeout(700)
        sn.scroll_cogito_into_view(page)
        badge = page.locator(f'[data-testid="cogito-node-health"][data-node-id="{sn.SAMPLE_TIMEOUT_NODE}"] .c724-badge-warn').first
        result[theme]["timeoutBadge"] = measure(page, badge, out, f"contrast-warn-timeout-{theme}", before)
        context.close()

        # Claude 계정 행: 해제 시각 배지(접힘), 오류 줄(펼침 뒤 사용 스위치 실패), 수집 지연 배지(레거시)
        context = sn.new_context(browser, sn.WIDE, theme)
        page = context.new_page()
        if before:
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded', () => {"
                f"const s = document.createElement('style'); s.textContent = {json.dumps(BEFORE_CSS)}; document.head.appendChild(s);"
                "});"
            )
        page.goto(f"{base}/components?sample=claude-accounts&state=pool&claudeActionState=failure")
        sn.settle(page)
        sn.expand_node(page, sn.REVIEW_NODE)
        header = page.get_by_test_id("claude-pool-row-header").first
        release = header.locator(".c724-badge-warn").first
        if release.count():
            result[theme]["releaseBadge"] = measure(page, release, out, f"contrast-warn-release-{theme}", before)
        page.get_by_role("button", name="계정 펼치기").first.click()
        page.wait_for_selector(".c724-pool-account-body", state="visible")
        page.get_by_role("switch").first.click()
        page.wait_for_selector(".c724-pool-account-body .c724-pool-error", state="visible", timeout=10_000)
        page.wait_for_timeout(300)
        error = page.locator(".c724-pool-account-body .c724-pool-error").first
        result[theme]["claudeRowError"] = measure(page, error, out, f"contrast-claude-row-error-{theme}", before)
        context.close()

        context = sn.new_context(browser, sn.WIDE, theme)
        page = context.new_page()
        if before:
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded', () => {"
                f"const s = document.createElement('style'); s.textContent = {json.dumps(BEFORE_CSS)}; document.head.appendChild(s);"
                "});"
            )
        page.goto(f"{base}/components?sample=claude-accounts&state=legacy")
        sn.settle(page)
        sn.expand_node(page, "sample-provider-legacy")
        stale = page.locator(".c724-badge-warn").first
        stale.wait_for(state="visible", timeout=10_000)
        result[theme]["staleBadge"] = measure(page, stale, out, f"contrast-warn-stale-{theme}", before)
        context.close()
    return result


def assert_start_lines(lines: dict) -> dict:
    failures = []
    gaps: dict = {}
    for key, tabs in lines.items():
        gaps[key] = {}
        for tab, data in tabs.items():
            first = data["first"]
            if first is None:
                failures.append({"capture": key, "tab": tab, "where": "noFirstBox"})
                continue
            gaps[key][tab] = round(data["gap"], 1)
            if tab == "노드" and first["testId"] != "node-card":
                failures.append({"capture": key, "tab": tab, "where": "firstBoxIsNodeCard", "testId": first["testId"]})
            left_delta = abs(first["x"] - data["lineLeft"])
            # 오른쪽 끝선은 구역 전체 폭을 쓰는 노드 카드만 본다. 다른 구역의 첫 상자는 폭이 내용에 따라 다르다.
            right_delta = abs(first["r"] - data["lineRight"]) if tab == "노드" else 0.0
            if left_delta > START_DELTA_MAX_PX or right_delta > START_DELTA_MAX_PX:
                failures.append({
                    "capture": key, "tab": tab, "where": "startAndEndLine",
                    "line": [round(data["lineLeft"], 1), round(data["lineRight"], 1)],
                    "box": [round(first["x"], 1), round(first["r"], 1)],
                })
        node_gap = gaps[key].get("노드")
        for tab in TABS[1:]:
            other = gaps[key].get(tab)
            if node_gap is not None and other is not None and abs(node_gap - other) > GAP_DELTA_MAX_PX:
                failures.append({"capture": key, "tab": tab, "where": "gapToHeading", "nodeGap": node_gap, "tabGap": other})
    return {"passed": not failures, "maxDeltaPx": START_DELTA_MAX_PX, "gapsPx": gaps, "failures": failures}


def main() -> int:
    parser = argparse.ArgumentParser(description="설정 구역 시작선과 대비 시각 검수")
    parser.add_argument("base_url")
    parser.add_argument("output_dir")
    parser.add_argument("--mode", choices=("after", "before"), default="after")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    before = args.mode == "before"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            lines = {} if before else start_lines(browser, base, out)
            contrast = contrast_cases(browser, base, out, before)
        finally:
            browser.close()

    assertions: dict = {}
    if not before:
        assertions["sectionStartLines"] = assert_start_lines(lines)
    contrast_failures = []
    for theme, cases in contrast.items():
        for name, data in cases.items():
            below = data["ratio"] < CONTRAST_MIN
            if before and not below:
                continue
            if not before and below:
                contrast_failures.append({"theme": theme, "case": name, **data})
    if before:
        # 고치기 전 색은 적어도 하나가 4.5 미만이어야 덮어쓴 CSS가 실제로 적용된 것이다.
        low = [(theme, name) for theme, cases in contrast.items() for name, data in cases.items() if data["ratio"] < CONTRAST_MIN]
        assertions["beforeColorsAreLow"] = {"passed": bool(low), "lowCases": low}
    else:
        assertions["contrastAtLeast4_5"] = {"passed": not contrast_failures, "minimum": CONTRAST_MIN, "failures": contrast_failures}

    report = {"baseUrl": base, "mode": args.mode, "startLines": lines, "contrast": contrast, "assertions": assertions}
    report["passed"] = all(entry["passed"] for entry in assertions.values())
    (out / "layout.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for key, tabs in lines.items():
        for tab, data in tabs.items():
            first = data["first"]
            print(f"시작선 {key} {tab}: 선 {data['lineLeft']:.1f}~{data['lineRight']:.1f} / 상자 {first['x']:.1f}~{first['r']:.1f} / 설명→상자 {data['gap']:.1f}px")
    for theme, cases in contrast.items():
        for name, data in cases.items():
            print(f"대비 {theme} {name}: {data['ratio']} (글자 {data['fg']} 배경 {data['bg']}, 픽셀 교차 {data['pixelRatio']})")
    for name, entry in assertions.items():
        print(f"{name}: {'통과' if entry['passed'] else '실패'}")
    if report["passed"]:
        print(f"판정: {args.mode} 모드 통과")
        return 0
    print(json.dumps({name: entry.get("failures") for name, entry in assertions.items() if not entry["passed"]}, ensure_ascii=False, indent=2), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

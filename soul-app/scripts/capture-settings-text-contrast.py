#!/usr/bin/env python3
"""설정 화면 글자 대비와 토글 구분선의 전후 시각 검수 (카드 #1116).

무엇을 검수하나
---------------
1. 「서버 연결」의 현재 연결 세 줄(저장 URL, 저장 유형, 확인된 실행 모드)이 어두운
   테마에서 배경과 거의 같은 색이던 결함. 수정 뒤에는 세 줄의 계산된 색이 테마의
   textPrimary와 같아야 하고, 변경 전 어두운 테마에서는 달라야 한다(결함 재현).
   같은 블록의 「이 기기에 연결 설정을 저장했습니다.」 줄도 함께 기록한다.
2. 「화면과 배경」의 영구 세션 토글 행 아래에 남아 있던 구분선. 수정 뒤에는 그 행의
   computed border-bottom-width가 0, 변경 전에는 0보다 커야 한다.
3. 「요청 검수」의 빈 입력에서 비활성인 GlassButton(추가)의 바탕이 회색으로 칠해져
   글자가 읽히지 않던 결함. 수정 뒤 비활성 보조 버튼의 배경은 투명하고, 입력을
   채워 활성화한 상태도 함께 캡처한다.
4. 공유 값 표본: 「서버 연결」에서 URL을 지워 비활성으로 만든 보조 버튼
   settings-test-connection과 비활성 primary settings-save, component-review의
   autoRefresh 화면 비활성 보조 버튼 refresh-finish. 보조 버튼은 수정 뒤 투명,
   primary의 계산된 배경과 불투명도는 변경 전후가 같아야 한다(공유 값 불변).
5. --compare: 세 화면의 설정 카드 좌표(left, top, width, height)가 변경 전과 1px 이내.
   구분선 제거로 인한 높이 변화도 그 안이다.

대비 수치는 computed color, opacity, 가장 가까운 불투명 배경색과의 대비를 JSON에
남긴다. 합불 임계는 두지 않고, 판정은 위 검사와 세라피엘의 눈으로 한다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy runner 경유):
       node soul-app/scripts/export-components.mjs
2. 변경 전과 후 번들로 각각 실행한다(python3 -P, 사용자 site-packages 사용):
       python3 -P soul-app/scripts/capture-settings-text-contrast.py --phase before \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1116/visual/before
       python3 -P soul-app/scripts/capture-settings-text-contrast.py --phase after \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1116/visual/after \
           --compare .local/tmp/card1116/visual/before/settings-text-contrast.json

스크립트는 로컬 HTTP 서버로 번들만 제공하며 외부 네트워크를 호출하지 않는다.
API 응답은 component-review 공개 fixture(`/api/auth/status`)만 흉내 낸다.
서버·페이지·정리·캡처 도우미와 설정 프레임 정의는 기존
`soul-app/scripts/capture-duo-settings-postit.py`에서 그대로 불러다 쓴다.

이 파일은 리포에 두는 단일 시각 검수 스크립트라 측정 JS와 검사 문자열을 한 파일에 둔다.
그래서 500줄을 넘는다(공통 rules-extra module-size-limit의 사유 명시 예외).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Browser, sync_playwright

DUO_SCRIPT = Path(__file__).resolve().parent / "capture-duo-settings-postit.py"
_duo_spec = importlib.util.spec_from_file_location("capture_duo_settings_postit", DUO_SCRIPT)
if _duo_spec is None or _duo_spec.loader is None:
    raise SystemExit(f"기존 캡처 스크립트를 불러오지 못했습니다: {DUO_SCRIPT}")
duo = importlib.util.module_from_spec(_duo_spec)
_duo_spec.loader.exec_module(duo)

BundleServer = duo.BundleServer
Checks = duo.Checks
open_page = duo.open_page
settle = duo.settle
shot = duo.shot
settings_url = duo.settings_url
PREFIX = duo.PREFIX

THEMES = ("dark", "light")
# 세 화면 모두를 이 프레임에서 캡처한다(카드 #1116 요청).
FRAMES = (
    ("ipad-pro-13-portrait", 1032, 1376),
    ("ipad-pro-13-landscape", 1376, 1032),
    ("inner-portrait", 669, 951),
)
# autoRefresh 표본은 한 프레임에서만 본다.
SAMPLE_FRAME = ("ipad-pro-13-portrait", 1032, 1376)
# getComputedStyle은 #ffffff를 rgb(255, 255, 255)로 정규화한다.
TEXT_PRIMARY_RGB = {"dark": "rgb(255, 255, 255)", "light": "rgb(0, 0, 0)"}
ALIGN_TOLERANCE_PX = 1.0
TRANSPARENT_ALPHA = 0.5

MEASURE_BASE_JS = r"""
  const round = (value) => Math.round(value * 100) / 100;
  const parseColor = (value) => {
    const match = /^rgba?\(([^)]+)\)$/.exec((value || '').trim());
    if (!match) return null;
    const parts = match[1].split(',').map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const styleOf = (element) => getComputedStyle(element);
  const visible = (element) => {
    if (!element) return false;
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: round(rect.left), top: round(rect.top), right: round(rect.right),
      bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
  };
  const describe = (element) => element
    ? (element.getAttribute('data-testid') || element.tagName.toLowerCase())
    : null;
  const nearestOpaqueBackground = (element) => {
    let node = element.parentElement;
    while (node) {
      const value = styleOf(node).backgroundColor;
      const color = parseColor(value);
      if (color && color.a >= 0.999) return { color: value, source: describe(node) };
      node = node.parentElement;
    }
    return { color: null, source: null };
  };
  const ancestorOpacity = (element) => {
    let opacity = 1;
    let node = element.parentElement;
    while (node) {
      opacity *= parseFloat(styleOf(node).opacity || '1');
      node = node.parentElement;
    }
    return round(opacity);
  };
  const sample = (element) => {
    if (!element) return null;
    const style = styleOf(element);
    return {
      text: (element.textContent || '').trim().slice(0, 80),
      color: style.color,
      backgroundColor: style.backgroundColor,
      opacity: parseFloat(style.opacity || '1'),
      ancestorOpacity: ancestorOpacity(element),
      fontSize: style.fontSize,
      borderBottomWidth: style.borderBottomWidth,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomColor: style.borderBottomColor,
      background: nearestOpaqueBackground(element),
      box: box(element),
    };
  };
  const buttonSample = (element) => {
    if (!element) return null;
    const style = styleOf(element);
    const content = [...element.querySelectorAll('*')].find((node) => (node.textContent || '').trim());
    const contentStyle = content ? styleOf(content) : null;
    return {
      text: (element.textContent || '').trim().slice(0, 40),
      backgroundColor: style.backgroundColor,
      background: nearestOpaqueBackground(element),
      opacity: parseFloat(style.opacity || '1'),
      ariaDisabled: element.getAttribute('aria-disabled'),
      contentColor: contentStyle ? contentStyle.color : null,
      contentOpacity: contentStyle ? parseFloat(contentStyle.opacity || '1') : null,
      box: box(element),
    };
  };
  const cardRects = (root) => {
    const children = [...root.children].filter(visible);
    let row = null;
    for (const child of children) {
      const style = styleOf(child);
      if (style.display.includes('flex') && style.flexDirection === 'row'
          && style.flexWrap === 'wrap' && child.children.length > 0) {
        row = child;
        break;
      }
    }
    const cards = row ? [...row.children].filter(visible) : children;
    return cards.map((card, index) => ({ index, box: box(card) }));
  };
  const sectionRects = () => [...document.querySelectorAll('[data-testid^="settings-section-"]')]
    .filter((root) => visible(root) && !root.querySelector('[data-testid^="settings-section-"]'))
    .map((root) => ({ id: root.getAttribute('data-testid'), cards: cardRects(root) }));
"""

CONNECTION_JS = "() => {" + MEASURE_BASE_JS + r"""
  const detail = document.querySelector('[data-testid="settings-detail-connection"]');
  const root = detail || document;
  const label = [...root.querySelectorAll('*')].find((element) =>
    element.children.length === 0 && (element.textContent || '').trim() === '현재 연결');
  const block = label ? label.parentElement : null;
  const lines = block
    ? [...block.children].map((child) => sample(child)).filter((entry) => entry && entry.text)
    : [];
  const input = document.querySelector('[data-testid="settings-server-input"]');
  return { detailVisible: visible(detail), labelFound: Boolean(label), lines,
    referenceTextColor: input ? styleOf(input).color : null, sections: sectionRects() };
}"""

CONNECTION_BUTTONS_JS = "() => {" + MEASURE_BASE_JS + r"""
  const byTestID = (id) => document.querySelector(`[data-testid="${id}"]`);
  return {
    testConnection: buttonSample(byTestID('settings-test-connection')),
    save: buttonSample(byTestID('settings-save')),
    inputValue: byTestID('settings-server-input') ? byTestID('settings-server-input').value : null,
  };
}"""

DISPLAY_JS = "() => {" + MEASURE_BASE_JS + r"""
  const toggle = document.querySelector('[data-testid="settings-persistent-session-open-on-start"]');
  const label = '시작할 때 영구 세션으로 열기';
  let row = toggle;
  while (row && !((row.textContent || '').includes(label))) row = row.parentElement;
  const chain = [];
  let node = toggle;
  for (let depth = 0; node && depth < 5; depth += 1) {
    chain.push({ tag: node.tagName.toLowerCase(), testid: node.getAttribute('data-testid'),
      borderBottomWidth: styleOf(node).borderBottomWidth });
    node = node.parentElement;
  }
  return { toggleFound: Boolean(toggle), rowFound: Boolean(row), row: sample(row),
    chain, sections: sectionRects() };
}"""

REVIEW_JS = "() => {" + MEASURE_BASE_JS + r"""
  const add = document.querySelector('[data-testid="review-policy-add"]');
  const input = document.querySelector('[data-testid="review-policy-source-input"]');
  return { add: buttonSample(add), inputValue: input ? input.value : null,
    sections: sectionRects() };
}"""

AUTO_REFRESH_JS = "() => {" + MEASURE_BASE_JS + r"""
  const byTestID = (id) => document.querySelector(`[data-testid="${id}"]`);
  return { finish: buttonSample(byTestID('refresh-finish')),
    begin: buttonSample(byTestID('refresh-begin')),
    phase: byTestID('refresh-phase') ? byTestID('refresh-phase').textContent : null };
}"""


def parse_rgba(value: str | None):
    match = re.match(r"rgba?\(([^)]+)\)", (value or "").strip())
    if not match:
        return None
    parts = [float(part.strip()) for part in match.group(1).split(",")]
    if len(parts) < 3:
        return None
    return (parts[0], parts[1], parts[2], parts[3] if len(parts) > 3 else 1.0)


def relative_luminance(rgb) -> float:
    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])


def contrast_ratio(color: str | None, background: str | None):
    foreground, backdrop = parse_rgba(color), parse_rgba(background)
    if foreground is None or backdrop is None:
        return None
    high, low = relative_luminance(foreground), relative_luminance(backdrop)
    if high < low:
        high, low = low, high
    return round((high + 0.05) / (low + 0.05), 2)


def parse_px(value: str | None):
    match = re.match(r"(-?\d+(?:\.\d+)?)px", (value or "").strip())
    return float(match.group(1)) if match else None


def annotate_text(sample: dict | None) -> dict | None:
    if not sample:
        return sample
    sample["contrast"] = contrast_ratio(sample.get("color"),
                                        (sample.get("background") or {}).get("color"))
    return sample


def annotate_button(sample: dict | None) -> dict | None:
    if not sample:
        return sample
    own = parse_rgba(sample.get("backgroundColor"))
    background = (sample.get("background") or {}).get("color")
    if own and own[3] >= 0.999:
        background = sample["backgroundColor"]
    sample["contentContrast"] = contrast_ratio(sample.get("contentColor"), background)
    return sample


def is_transparent(background: str | None) -> bool:
    color = parse_rgba(background)
    return color is not None and color[3] <= TRANSPARENT_ALPHA


def open_settings(browser: Browser, base: str, frame_id: str, width: int, height: int, theme: str):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = settings_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.get_by_test_id("settings-layout-safe-area").wait_for(state="attached", timeout=20000)
    settle(page)
    return context, page, errors


def capture_connection(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                       width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"connection/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-connection").first.click()
        settle(page)
        metrics = page.evaluate(CONNECTION_JS)
        entry["detailVisible"] = metrics["detailVisible"]
        entry["referenceTextColor"] = metrics["referenceTextColor"]
        lines = [line for line in metrics["lines"] if line["text"] != "현재 연결"][:3]
        entry["lines"] = [annotate_text(line) for line in lines]
        entry["notice"] = next((annotate_text(line) for line in metrics["lines"]
                                if "저장했습니다" in line["text"]), None)
        entry["sections"] = metrics["sections"]

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 서버 연결 상세가 보임", metrics["detailVisible"],
                     {"detailVisible": metrics["detailVisible"]})
        checks.check(f"{key} 현재 연결 세 줄 존재", len(lines) == 3,
                     [line["text"] for line in metrics["lines"]])
        expected = TEXT_PRIMARY_RGB[theme]
        detail = [{"text": line["text"], "color": line["color"],
                   "contrast": line["contrast"]} for line in entry["lines"]]
        if phase == "before":
            if theme == "dark":
                checks.check(f"{key} 변경 전 결함 재현: 현재 연결 세 줄이 textPrimary가 아님",
                             len(lines) == 3
                             and all(line["color"] != expected for line in lines), detail)
        else:
            checks.check(f"{key} 현재 연결 세 줄 색이 테마 textPrimary",
                         len(lines) == 3
                         and all(line["color"] == expected for line in lines), detail)

        page.get_by_test_id("settings-server-input").fill("")
        settle(page)
        buttons = page.evaluate(CONNECTION_BUTTONS_JS)
        entry["samples"] = {
            "testConnection": annotate_button(buttons["testConnection"]),
            "save": annotate_button(buttons["save"]),
        }
        entry["clearedInputValue"] = buttons["inputValue"]
        screenshot = shot(page, out, f"connection-{frame_id}-{theme}", width, height)
        entry["screenshot"] = screenshot

        test_connection = entry["samples"]["testConnection"]
        save = entry["samples"]["save"]
        checks.check(f"{key} URL을 지워 연결 확인 버튼이 비활성",
                     test_connection is not None and test_connection["opacity"] == 0.55,
                     {"opacity": test_connection["opacity"] if test_connection else None})
        checks.check(f"{key} URL을 지워 저장 버튼이 비활성",
                     save is not None and save["opacity"] == 0.55,
                     {"opacity": save["opacity"] if save else None})
        background = test_connection["backgroundColor"] if test_connection else None
        if phase == "before":
            checks.check(f"{key} 변경 전 결함 재현: 비활성 보조 버튼 바탕이 불투명",
                         test_connection is not None and not is_transparent(background),
                         {"backgroundColor": background})
        else:
            checks.check(f"{key} 비활성 보조 버튼 바탕이 투명",
                         test_connection is not None and is_transparent(background),
                         {"backgroundColor": background})
    finally:
        page.close()
        context.close()
    return entry


def capture_display(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                    width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"display/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-display").first.click()
        settle(page)
        metrics = page.evaluate(DISPLAY_JS)
        entry["toggleFound"] = metrics["toggleFound"]
        entry["rowFound"] = metrics["rowFound"]
        entry["row"] = metrics["row"]
        entry["ancestorChain"] = metrics["chain"]
        entry["sections"] = metrics["sections"]
        entry["screenshot"] = shot(page, out, f"display-{frame_id}-{theme}", width, height)

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 영구 세션 토글 행 존재", metrics["rowFound"],
                     {"toggleFound": metrics["toggleFound"], "chain": metrics["chain"]})
        border = parse_px((metrics["row"] or {}).get("borderBottomWidth"))
        if phase == "before":
            checks.check(f"{key} 변경 전 결함 재현: 토글 행 아래 구분선 있음",
                         border is not None and border > 0,
                         {"borderBottomWidth": (metrics["row"] or {}).get("borderBottomWidth")})
        else:
            checks.check(f"{key} 토글 행 아래 구분선 없음", border == 0,
                         {"borderBottomWidth": (metrics["row"] or {}).get("borderBottomWidth")})
    finally:
        page.close()
        context.close()
    return entry


def capture_review_policy(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                          width: int, height: int, theme: str, checks: Checks) -> dict:
    key = f"reviewPolicy/{frame_id}/{theme}"
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    entry: dict = {"url": settings_url(base, frame_id, theme), "errors": errors}
    try:
        page.get_by_test_id("settings-category-review-policy").first.click()
        settle(page)
        page.get_by_test_id("review-policy-add").wait_for(state="attached", timeout=20000)
        settle(page)
        empty = page.evaluate(REVIEW_JS)
        entry["empty"] = annotate_button(empty["add"])
        entry["sections"] = empty["sections"]
        entry["screenshots"] = [shot(page, out, f"review-policy-{frame_id}-{theme}",
                                     width, height)]

        page.get_by_test_id("review-policy-source-input").fill("review-check")
        settle(page)
        enabled = page.evaluate(REVIEW_JS)
        entry["enabled"] = annotate_button(enabled["add"])
        entry["screenshots"].append(shot(page, out,
                                         f"review-policy-enabled-{frame_id}-{theme}",
                                         width, height))

        checks.check(f"{key} 페이지 오류 없음", not errors, errors)
        checks.check(f"{key} 추가 버튼 존재", entry["empty"] is not None and entry["enabled"] is not None,
                     {"empty": entry["empty"] is not None,
                      "enabled": entry["enabled"] is not None})
        if entry["empty"] is not None:
            background = entry["empty"]["backgroundColor"]
            if phase == "before":
                checks.check(f"{key} 변경 전 결함 재현: 빈 입력 추가 버튼 바탕이 불투명",
                             not is_transparent(background), {"backgroundColor": background})
            else:
                checks.check(f"{key} 빈 입력 추가 버튼 바탕이 투명",
                             is_transparent(background), {"backgroundColor": background})
        if entry["enabled"] is not None:
            checks.check(f"{key} 입력 후 추가 버튼 바탕이 투명",
                         is_transparent(entry["enabled"]["backgroundColor"])
                         and entry["enabled"]["opacity"] == 1,
                         {"backgroundColor": entry["enabled"]["backgroundColor"],
                          "opacity": entry["enabled"]["opacity"]})
    finally:
        page.close()
        context.close()
    return entry


def capture_auto_refresh(browser: Browser, base: str, out: Path, phase: str,
                         checks: Checks) -> dict:
    frame_id, width, height = SAMPLE_FRAME
    entry: dict = {"skipped": None}
    checks_by_theme: list[dict] = []
    for theme in THEMES:
        key = f"autoRefresh/{frame_id}/{theme}"
        context = browser.new_context(viewport={"width": width, "height": height},
                                      device_scale_factor=2)
        context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
        url = f"{base}{PREFIX}index.html?section=autoRefresh&theme={theme}"
        page, errors = open_page(context, base, url)
        try:
            try:
                page.get_by_test_id("refresh-finish").wait_for(state="attached", timeout=20000)
            except Exception as error:  # noqa: BLE001 - 하네스에서 안 열리면 사유를 남긴다
                entry["skipped"] = f"autoRefresh 화면에서 refresh-finish를 열지 못함: {error}"
                checks_by_theme.append({"theme": theme, "skipped": entry["skipped"]})
                continue
            settle(page)
            metrics = page.evaluate(AUTO_REFRESH_JS)
            sample = annotate_button(metrics["finish"])
            checks_by_theme.append({"theme": theme, "finish": sample, "begin": metrics["begin"],
                                    "phase": metrics["phase"], "errors": errors,
                                    "screenshot": shot(page, out,
                                                       f"autoRefresh-{frame_id}-{theme}",
                                                       width, height)})
            checks.check(f"{key} 페이지 오류 없음", not errors, errors)
            background = sample["backgroundColor"] if sample else None
            if phase == "before":
                checks.check(f"{key} 변경 전 결함 재현: 비활성 보조 버튼 바탕이 불투명",
                             sample is not None and not is_transparent(background),
                             {"backgroundColor": background})
            else:
                checks.check(f"{key} 비활성 보조 버튼 바탕이 투명",
                             sample is not None and is_transparent(background),
                             {"backgroundColor": background})
        finally:
            page.close()
            context.close()
    entry["themes"] = checks_by_theme
    return entry


def compare_phases(before: dict, after: dict, checks: Checks) -> dict:
    """세 화면의 카드 좌표가 변경 전과 1px 이내인지, primary 표본이 그대로인지 본다."""
    summary: dict = {}
    for screen in ("connection", "display", "reviewPolicy"):
        for key, current in after.get("screens", {}).get(screen, {}).items():
            prior = before.get("screens", {}).get(screen, {}).get(key)
            if not prior or not current:
                continue
            old_cards = {(section["id"], card["index"]): card["box"]
                         for section in prior.get("sections") or []
                         for card in section["cards"]}
            new_cards = {(section["id"], card["index"]): card["box"]
                         for section in current.get("sections") or []
                         for card in section["cards"]}
            checks.check(f"전후 {screen}/{key} 카드 목록 동일", set(old_cards) == set(new_cards),
                         {"before": sorted(map(str, old_cards)),
                          "after": sorted(map(str, new_cards))})
            deltas = []
            for ident, box in new_cards.items():
                old = old_cards.get(ident)
                if old is None:
                    continue
                delta = {axis: round(box[axis] - old[axis], 2)
                         for axis in ("left", "top", "width", "height")}
                checks.check(
                    f"전후 {screen}/{key}/{ident[0]}/카드{ident[1]} "
                    f"좌표 {ALIGN_TOLERANCE_PX}px 이내",
                    all(abs(value) <= ALIGN_TOLERANCE_PX for value in delta.values()), delta)
                deltas.append({"section": ident[0], "index": ident[1], "delta": delta})
            summary[f"{screen}/{key}"] = deltas

    primary: dict = {}
    for key, current in after.get("screens", {}).get("connection", {}).items():
        prior = before.get("screens", {}).get("connection", {}).get(key)
        old = (prior or {}).get("samples", {}).get("save")
        new = (current or {}).get("samples", {}).get("save")
        if not old or not new:
            continue
        same = (old["backgroundColor"] == new["backgroundColor"]
                and old["opacity"] == new["opacity"]
                and old["contentColor"] == new["contentColor"])
        checks.check(f"전후 connection/{key} 비활성 primary 배경·불투명도 동일", same,
                     {"before": {field: old[field] for field in
                                 ("backgroundColor", "opacity", "contentColor")},
                      "after": {field: new[field] for field in
                                ("backgroundColor", "opacity", "contentColor")}})
        primary[f"connection/{key}"] = {"before": old["backgroundColor"],
                                        "after": new["backgroundColor"]}
    return {"cards": summary, "primary": primary}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    parser.add_argument("--phase", required=True, choices=("before", "after"),
                        help="프로덕션 변경 전/후 번들")
    parser.add_argument("--compare", help="비교할 반대 단계의 settings-text-contrast.json")
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"phase": args.phase, "passed": False, "errors": [], "warnings": [],
                    "screens": {"connection": {}, "display": {}, "reviewPolicy": {}}}
    checks = Checks()
    try:
        with BundleServer(bundle_root) as server:
            base = server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for frame_id, width, height in FRAMES:
                        for theme in THEMES:
                            key = f"{frame_id}/{theme}"
                            result["screens"]["connection"][key] = capture_connection(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                            result["screens"]["display"][key] = capture_display(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                            result["screens"]["reviewPolicy"][key] = capture_review_policy(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                    result["samples"] = {"autoRefresh": capture_auto_refresh(
                        browser, base, out, args.phase, checks)}
                finally:
                    browser.close()
        if args.compare:
            prior = json.loads(Path(args.compare).read_text(encoding="utf-8"))
            result["comparison"] = compare_phases(prior, result, checks)
        skipped = result["samples"]["autoRefresh"].get("skipped")
        if skipped:
            result["warnings"].append(skipped)
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "settings-text-contrast.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "phase": result["phase"],
        "passed": result["passed"],
        "errors": result["errors"],
        "warnings": result["warnings"],
        "checks": len(result["checks"]),
        "failed": [entry["name"] for entry in result["checks"] if not entry["passed"]],
    }, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

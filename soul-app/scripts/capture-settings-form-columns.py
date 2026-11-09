#!/usr/bin/env python3
"""설정 폼 2열 배치에서 카드가 같은 줄의 가장 높은 카드로 늘어나는지 전후 시각 검수 (카드 #1115).

무엇을 검수하나
---------------
1. 「화면과 배경」(settings-section-display) 카드, 넓은 폭 2열
   - 같은 줄의 외양·배경 카드 위쪽 끝 차이 1px 이하.
   - 각 카드의 「아래 빈 공간」(카드 아래 끝 - 카드 안에서 보이는 자손 요소의 아래 끝
     최댓값)이 같은 섹션의 다른 카드와 1px 이내. 카드가 자기 내용 높이로 끝나면 이 값은
     카드 아래 테두리 두께와 같다.
   - 변경 전(before) 번들은 외양 카드가 배경 카드 높이로 늘어나 이 검사에 실패해야 하고
     (결함 재현), 변경 후(after) 번들은 통과해야 한다.
   - 1열 배치(columns가 꺼지는 폭)에서도 카드가 늘어나지 않아 빈 공간이 1px 이내다.
2. 나머지 설정 항목의 2열 배치도 같은 계약을 지킨다. 항목마다 카드별 측정값을 JSON에
   남긴다. 반복 작업과 영구 에이전트 세션은 목록 항목을 눌러 편집기를 연 뒤 잰다
   (편집기도 같은 SettingsSection 2열 행을 쓴다). 잴 수 없는 항목은 건너뛰고 사유를
   JSON에 남긴다.
3. 1열 배치(듀오 세로·가로)는 변경 전후 카드 좌표가 1px 이내로 같다(`--compare`).
   2열 배치는 늘어남 제거로 높이가 의도적으로 달라지므로 왼쪽 끝과 폭만 비교한다.

실행 방법
---------
1. 번들을 만든다(리포지토리 루트에서, heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
2. 변경 전과 후의 번들로 각각 실행한다:
       python3 -P soul-app/scripts/capture-settings-form-columns.py --phase before \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1115/visual/before
       python3 -P soul-app/scripts/capture-settings-form-columns.py --phase after \
           --bundle unified-dashboard/dist/assets/ios-components \
           --out .local/tmp/card1115/visual/after \
           --compare .local/tmp/card1115/visual/before/settings-form-columns.json

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
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, sync_playwright

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
SETTINGS_FRAMES = duo.SETTINGS_FRAMES
HIDE_SCROLLBAR_CSS = duo.HIDE_SCROLLBAR_CSS

THEMES = ("dark", "light")
DISPLAY_SECTION_ID = "settings-section-display"
# 카드 2열이 켜지는 프레임(카드 폭이 행 폭의 60% 미만)의 기대값.
# inner-landscape는 실측 카드 폭 587px로 1열이다(2열 기준 SETTINGS_FORM_COLUMNS_MIN_WIDTH 700 미만).
EXPECTED_COLUMNS = {
    "inner-portrait": False,
    "inner-landscape": False,
    "ipad-pro-13-portrait": True,
    "ipad-pro-13-landscape": True,
}
# usage-stats는 component-review iphoneDuo fixture client에 사용량 통계 API가 없어
# (getSessionStatistics is not a function) 화면이 그려지지 않고 사이드바까지 언마운트된다.
# 마지막에 두어 앞선 항목들의 캡처를 막지 않는다. 열리지 않는 항목은 JSON에 사유를 남긴다.
EXTRA_CATEGORIES = (
    "owned-agents",
    "connection",
    "backends",
    "recurring-jobs",
    "persistent",
    "review-policy",
    "diagnostics",
    "usage-stats",
)
EXTRA_FRAMES = (
    ("ipad-pro-13-portrait", 1032, 1376),
    ("ipad-pro-13-landscape", 1376, 1032),
)
EXTRA_THEME = "dark"
# 목록 항목을 눌러야 편집기가 열리는 항목: (목록 항목, 편집기 그룹 섹션) testID.
EDITOR_BY_CATEGORY = {
    "recurring-jobs": ("recurring-job-review-job-0", "settings-section-recurring-editor-groups"),
    "persistent": ("persistent-session-review-pas-1", "settings-section-persistent-editor-groups"),
}
# 픽셀 반올림만 허용한다. 같은 줄 판정, 빈 공간 비교, 전후 좌표 비교에 같이 쓴다.
ALIGN_TOLERANCE_PX = 1.0

MEASURE_JS = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: round(rect.left), top: round(rect.top), right: round(rect.right),
      bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
  };
  const styleOf = (element) => getComputedStyle(element);
  const visible = (element) => {
    if (!element) return false;
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelOf = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node.textContent || '').trim()) continue;
      const family = styleOf(node.parentElement).fontFamily.toLowerCase();
      if (family.includes('ionicons')) continue;
      return (node.textContent || '').trim().slice(0, 40);
    }
    return null;
  };
  const sections = [];
  for (const root of document.querySelectorAll('[data-testid^="settings-section-"]')) {
    if (!visible(root)) continue;
    // 다른 설정 섹션을 품은 바깥 껍데기(AIBackendSettingsSection)는 그 안쪽 섹션이
    // 카드 배치를 소유한다. 껍데기의 자식은 카드가 아니므로 측정하지 않는다.
    if (root.querySelector('[data-testid^="settings-section-"]')) continue;
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
    const rowBox = row ? box(row) : null;
    const cardElements = row ? [...row.children].filter(visible) : children;
    const cards = cardElements.map((card, index) => {
      const rect = box(card);
      let contentBottom = null;
      for (const descendant of card.querySelectorAll('*')) {
        if (!visible(descendant)) continue;
        // 넘침이 잘린 자손은 카드 아래 끝보다 아래로 잡힐 수 있다. 내용 끝으로 본다.
        const bottom = Math.min(descendant.getBoundingClientRect().bottom, rect.bottom);
        if (contentBottom === null || bottom > contentBottom) contentBottom = bottom;
      }
      return {
        index,
        label: labelOf(card),
        rect,
        contentBottom: contentBottom === null ? null : round(contentBottom),
        emptyBottom: contentBottom === null ? null : round(rect.bottom - contentBottom),
      };
    });
    const sorted = [...cards].sort((a, b) => a.rect.top - b.rect.top);
    const groups = [];
    for (const card of sorted) {
      const group = groups.find((item) => Math.abs(item.top - card.rect.top) <= 1);
      if (group) group.cards.push(card.index);
      else groups.push({ top: card.rect.top, cards: [card.index] });
    }
    const columns = Boolean(rowBox) && cards.length > 1
      && cards.some((card) => card.rect.width < rowBox.width * 0.6);
    sections.push({
      id: root.getAttribute('data-testid'),
      rect: box(root),
      rowWidth: rowBox === null ? null : rowBox.width,
      columns,
      cards,
      rowGroups: groups.map((group) => ({ top: round(group.top), cards: group.cards })),
    });
  }
  const details = {};
  const markers = [];
  for (const detail of document.querySelectorAll('[data-testid^="settings-detail-"]')) {
    const id = detail.getAttribute('data-testid').slice('settings-detail-'.length);
    details[id] = visible(detail);
  }
  for (const marker of document.querySelectorAll('[data-testid^="settings-"]')) {
    if (!visible(marker)) continue;
    markers.push(marker.getAttribute('data-testid'));
  }
  return { window: { width: innerWidth, height: innerHeight }, sections, details,
    markers: markers.sort() };
}
"""


def spread(values: list) -> float | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    if len(present) == 1:
        return 0.0
    return round(max(present) - min(present), 2)


def card_by_index(section: dict, index: int) -> dict | None:
    return next((card for card in section["cards"] if card["index"] == index), None)


def multi_card_rows(section: dict) -> list[list[dict]]:
    rows = []
    for group in section["rowGroups"]:
        if len(group["cards"]) < 2:
            continue
        cards = [card_by_index(section, index) for index in group["cards"]]
        rows.append([card for card in cards if card is not None])
    return rows


def row_top_delta(section: dict) -> float:
    deltas = []
    for cards in multi_card_rows(section):
        deltas.append(max(card["rect"]["top"] for card in cards)
                      - min(card["rect"]["top"] for card in cards))
    return round(max(deltas), 2) if deltas else 0.0


def section_empty_delta(section: dict) -> float | None:
    return spread([card["emptyBottom"] for card in section["cards"]])


def row_empty_delta(cards: list[dict]) -> float | None:
    return spread([card["emptyBottom"] for card in cards])


def section_brief(section: dict) -> dict:
    return {
        "id": section["id"],
        "rowWidth": section["rowWidth"],
        "columns": section["columns"],
        "rowTopDelta": row_top_delta(section),
        "sectionEmptyDelta": section_empty_delta(section),
        "cards": [
            {"index": card["index"], "label": card["label"], "rect": card["rect"],
             "contentBottom": card["contentBottom"], "emptyBottom": card["emptyBottom"]}
            for card in section["cards"]
        ],
    }


def open_settings(browser: Browser, base: str, frame_id: str, width: int, height: int,
                  theme: str) -> tuple[BrowserContext, object, list[str]]:
    context = browser.new_context(viewport={"width": width, "height": height},
                                  device_scale_factor=2)
    context.add_cookies([{"name": "review", "value": "fixture", "url": base}])
    url = settings_url(base, frame_id, theme)
    page, errors = open_page(context, base, url)
    page.get_by_test_id("settings-layout-safe-area").wait_for(state="attached", timeout=20000)
    settle(page)
    return context, page, errors


def capture_display(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                    width: int, height: int, theme: str, checks: Checks) -> dict:
    context, page, errors = open_settings(browser, base, frame_id, width, height, theme)
    try:
        metrics = page.evaluate(MEASURE_JS)
        screenshot = shot(page, out, f"display-{frame_id}-{theme}", width, height)
    finally:
        page.close()
        context.close()

    prefix = f"display/{frame_id}/{theme}"
    section = next((item for item in metrics["sections"]
                    if item["id"] == DISPLAY_SECTION_ID), None)
    checks.check(f"{prefix} 페이지 오류 없음", not errors, errors)
    checks.check(f"{prefix} 「화면과 배경」 섹션 존재", section is not None,
                 [item["id"] for item in metrics["sections"]])
    entry: dict = {"url": settings_url(base, frame_id, theme),
                   "screenshot": screenshot, "errors": errors,
                   "columns": bool(section and section["columns"]),
                   "section": section_brief(section) if section else None}
    if section is None:
        return entry
    entry["sections"] = [section_brief(item) for item in metrics["sections"]]
    expected = EXPECTED_COLUMNS.get(frame_id)
    checks.check(f"{prefix} 배치 열 수가 기대와 같음({expected})",
                 expected is not None and section["columns"] == expected,
                 {"expected": expected, "columns": section["columns"],
                  "rowWidth": section["rowWidth"],
                  "cardWidth": section["cards"][0]["rect"]["width"]
                  if section["cards"] else None})
    top_delta = row_top_delta(section)
    entry["rowTopDelta"] = top_delta
    checks.check(f"{prefix} 같은 줄 카드 위쪽 끝 {ALIGN_TOLERANCE_PX}px 이내",
                 top_delta <= ALIGN_TOLERANCE_PX, {"rowTopDelta": top_delta})
    if section["columns"]:
        checks.check(f"{prefix} 외양·배경 카드가 같은 줄",
                     bool(multi_card_rows(section)), section["rowGroups"])
        row = next(iter(multi_card_rows(section)), None)
        empty_delta = row_empty_delta(row) if row else None
        entry["rowEmptyDelta"] = empty_delta
        detail = {"rowEmptyDelta": empty_delta, "cards": entry["section"]["cards"]}
        if phase == "before":
            checks.check(f"{prefix} 변경 전 결함 재현: 외양 카드가 배경 카드 높이로 늘어남",
                         empty_delta is not None and empty_delta > ALIGN_TOLERANCE_PX, detail)
        else:
            checks.check(f"{prefix} 같은 줄 카드 아래 빈 공간 {ALIGN_TOLERANCE_PX}px 이내",
                         empty_delta is not None and empty_delta <= ALIGN_TOLERANCE_PX, detail)
        section_delta = section_empty_delta(section)
        entry["sectionEmptyDelta"] = section_delta
        if phase == "before":
            checks.check(f"{prefix} 변경 전 결함 재현: 한 섹션 카드의 아래 빈 공간이 서로 다름",
                         section_delta is not None and section_delta > ALIGN_TOLERANCE_PX,
                         {"sectionEmptyDelta": section_delta,
                          "cards": entry["section"]["cards"]})
        else:
            checks.check(f"{prefix} 섹션 안 카드 아래 빈 공간 {ALIGN_TOLERANCE_PX}px 이내",
                         section_delta is not None and section_delta <= ALIGN_TOLERANCE_PX,
                         {"sectionEmptyDelta": section_delta,
                          "cards": entry["section"]["cards"]})
    else:
        checks.check(f"{prefix} 1열이라 카드가 한 줄에 하나",
                     all(len(group["cards"]) == 1 for group in section["rowGroups"]),
                     section["rowGroups"])
        checks.check(f"{prefix} 1열 카드 아래 빈 공간 {ALIGN_TOLERANCE_PX}px 이내",
                     bool(section["cards"]) and all(
                         card["emptyBottom"] is not None
                         and card["emptyBottom"] <= ALIGN_TOLERANCE_PX
                         for card in section["cards"]),
                     entry["section"]["cards"])
    return entry


def capture_categories(browser: Browser, base: str, out: Path, phase: str, frame_id: str,
                       width: int, height: int, checks: Checks) -> dict:
    """아이패드 2열에서 나머지 설정 항목의 카드 배치를 항목마다 잰다."""
    context, page, errors = open_settings(browser, base, frame_id, width, height, EXTRA_THEME)
    result: dict = {"url": settings_url(base, frame_id, EXTRA_THEME), "errors": errors,
                    "categories": {}}
    try:
        seen_errors = len(errors)
        for category in EXTRA_CATEGORIES:
            key = f"categories/{frame_id}/{category}"
            entry: dict = {"skipped": None}
            try:
                locator = page.get_by_test_id(f"settings-category-{category}")
                if locator.count() == 0:
                    entry["skipped"] = "설정 색인에 이 항목이 없음"
                else:
                    before_markers = set(page.evaluate(MEASURE_JS)["markers"])
                    locator.first.click()
                    settle(page)
                    entry["pageErrors"] = errors[seen_errors:]
                    seen_errors = len(errors)
                    editor = EDITOR_BY_CATEGORY.get(category)
                    if editor is not None:
                        if page.get_by_test_id(editor[0]).count() == 0:
                            raise LookupError(f"목록 항목이 없음: {editor[0]}")
                        page.get_by_test_id(editor[0]).first.click()
                        settle(page)
                        entry["pageErrors"] += errors[seen_errors:]
                        seen_errors = len(errors)
                        entry["listItem"] = editor[0]
                    metrics = page.evaluate(MEASURE_JS)
                    after_markers = set(metrics["markers"])
                    # 상세 화면 testID가 없는 항목은 settings-* 표식 변화로 열림을 판정한다.
                    if editor is not None:
                        opened = any(sec["id"] == editor[1] for sec in metrics["sections"])
                    else:
                        opened = bool(metrics["details"].get(category)) \
                            or after_markers != before_markers
                    if not opened:
                        if editor is not None:
                            raise LookupError(f"편집기가 열리지 않음: {editor[1]}")
                        reason = (entry["pageErrors"][0] if entry["pageErrors"]
                                  else "화면이 바뀌지 않음")
                        entry["skipped"] = f"하네스에서 이 항목이 열리지 않음: {reason}"
                        entry["details"] = metrics["details"]
                    elif not metrics["sections"]:
                        reason = (entry["pageErrors"][0] if entry["pageErrors"]
                                  else "측정할 settings-section이 없는 화면")
                        entry["skipped"] = f"하네스에서 이 항목을 잴 수 없음: {reason}"
                        entry["visibleTestIDs"] = sorted(after_markers)
                    else:
                        checks.check(f"{key} 페이지 오류 없음", not entry["pageErrors"],
                                     entry["pageErrors"])
                        entry["screenshot"] = shot(
                            page, out, f"category-{frame_id}-{category}", width, height)
                        entry["sections"] = [section_brief(item)
                                             for item in metrics["sections"]]
                        for section in metrics["sections"]:
                            label = f"{key}/{section['id']}"
                            delta = row_top_delta(section)
                            checks.check(
                                f"{label} 같은 줄 카드 위쪽 끝 {ALIGN_TOLERANCE_PX}px 이내",
                                delta <= ALIGN_TOLERANCE_PX, {"rowTopDelta": delta})
                            if phase == "after":
                                empty_delta = section_empty_delta(section)
                                checks.check(
                                    f"{label} 카드 아래 빈 공간 {ALIGN_TOLERANCE_PX}px 이내",
                                    empty_delta is not None
                                    and empty_delta <= ALIGN_TOLERANCE_PX,
                                    {"sectionEmptyDelta": empty_delta,
                                     "cards": section["cards"]})
            except Exception as error:  # noqa: BLE001 - 한 항목 실패가 나머지를 막지 않게
                entry["error"] = str(error)
                checks.check(f"{key} 캡처", False, str(error))
            result["categories"][key] = entry
    finally:
        page.close()
        context.close()
    return result


def compare_phases(before: dict, after: dict, checks: Checks) -> dict:
    """1열 배치는 네 모서리가 그대로, 2열 배치는 폭·위쪽 끝·왼쪽 끝이 그대로인지 본다."""
    summary: dict = {}
    for key, current in after.get("display", {}).items():
        prior = before.get("display", {}).get(key)
        if not prior or not prior.get("section") or not current.get("section"):
            continue
        one_column = not prior["columns"] and not current["columns"]
        entry: dict = {"oneColumn": one_column, "cards": []}
        old_sections = {section["id"]: section for section in prior.get("sections") or []}
        for new_section in current.get("sections") or []:
            old_section = old_sections.get(new_section["id"])
            if old_section is None:
                continue
            old_cards = {card["index"]: card for card in old_section["cards"]}
            for card in new_section["cards"]:
                old = old_cards.get(card["index"])
                if old is None:
                    continue
                delta = {
                    "left": round(card["rect"]["left"] - old["rect"]["left"], 2),
                    "top": round(card["rect"]["top"] - old["rect"]["top"], 2),
                    "width": round(card["rect"]["width"] - old["rect"]["width"], 2),
                    "height": round(card["rect"]["height"] - old["rect"]["height"], 2),
                }
                entry["cards"].append({"section": new_section["id"],
                                       "index": card["index"], "delta": delta})
                label = f"전후 {key}/{new_section['id']}/카드{card['index']}"
                checks.check(f"{label} 왼쪽 끝·폭 그대로({ALIGN_TOLERANCE_PX}px)",
                             abs(delta["left"]) <= ALIGN_TOLERANCE_PX
                             and abs(delta["width"]) <= ALIGN_TOLERANCE_PX, delta)
                if one_column:
                    checks.check(f"{label} 위쪽 끝 그대로({ALIGN_TOLERANCE_PX}px)",
                                 abs(delta["top"]) <= ALIGN_TOLERANCE_PX, delta)
                    checks.check(f"{label} 1열 카드 높이 그대로({ALIGN_TOLERANCE_PX}px)",
                                 abs(delta["height"]) <= ALIGN_TOLERANCE_PX, delta)
        summary[key] = entry
    one_column_keys = [key for key, entry in summary.items() if entry["oneColumn"]]
    checks.check("전후 1열 배치 프레임이 하나 이상", bool(one_column_keys), one_column_keys)
    return {"display": summary, "oneColumnFrames": one_column_keys}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    parser.add_argument("--phase", required=True, choices=("before", "after"),
                        help="프로덕션 변경 전/후 번들")
    parser.add_argument("--compare", help="비교할 반대 단계의 settings-form-columns.json")
    args = parser.parse_args()

    bundle_root = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle_root / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle_root}")
    out.mkdir(parents=True, exist_ok=True)

    result: dict = {"phase": args.phase, "passed": False, "errors": [],
                    "display": {}, "categories": {}}
    checks = Checks()
    try:
        with BundleServer(bundle_root) as server:
            base = server.base
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for frame_id, width, height in SETTINGS_FRAMES:
                        for theme in THEMES:
                            key = f"{frame_id}/{theme}"
                            result["display"][key] = capture_display(
                                browser, base, out, args.phase, frame_id, width, height,
                                theme, checks)
                    for frame_id, width, height in EXTRA_FRAMES:
                        result["categories"][frame_id] = capture_categories(
                            browser, base, out, args.phase, frame_id, width, height, checks)
                finally:
                    browser.close()
        if args.compare:
            prior = json.loads(Path(args.compare).read_text(encoding="utf-8"))
            result["comparison"] = compare_phases(prior, result, checks)
        result["passed"] = all(entry["passed"] for entry in checks.entries)
    except Exception as error:  # noqa: BLE001 - 기록 후 실패로 끝낸다
        result["errors"].append(f"unexpected: {error}")
    finally:
        result["checks"] = checks.entries
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        (out / "settings-form-columns.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "phase": result["phase"],
        "passed": result["passed"],
        "errors": result["errors"],
        "checks": len(result["checks"]),
        "failed": [entry["name"] for entry in result["checks"] if not entry["passed"]],
    }, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

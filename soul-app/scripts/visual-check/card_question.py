#!/usr/bin/env python3
"""Card question sheet visual check (RN web component review bundle).

Launch method
-------------
1. Export the review bundle once from the soul-app directory:
       npm run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Serve the dist root (not the bundle directory) with any static server:
       python3 -m http.server 4173 --directory unified-dashboard/dist
3. Run this script with the bundle URL and an output directory:
       python3 -P soul-app/scripts/visual-check/card_question.py \
           http://127.0.0.1:4173/assets/ios-components/index.html ./evidence/card-question

The script opens the public-fixture review page (?section=cardQuestion) and
never contacts a node or the real card API; every answer comes from the
component-review sample. It captures the approved scenes (choice with 권함 and
an image, awaiting, answered with append target, request, legacy, revised) on
both surfaces (PAS sheet, card detail) at iPad 820 and iPhone 390 in light and
dark, plus a loading frame and a read-error frame.

Operation checks (ui-design gate items 14-18) run in the same page:
  14 focus after 되묻기 / 다르게 답하기, and focus NOT moving after a choice
  15 Tab order and Esc applicability on the card detail sheet
  16 narrowest width (390) horizontal overflow
  17 read failure (다시 읽기) and write failure (draft preserved)
  18 window resize 820 <-> 390 with the draft and the folded layout preserved

Answer scenarios (contract 3절 2번) also run as PASS judgments:
  iPad  folded choice -> 덧붙이기 -> expanded field keeps the chosen row, dims the rest, keeps the target
  iPad  expanded choice -> fold -> folded field stays at 받은 답 with 덧붙이기
  phone folded choice -> 덧붙이기 sheet keeps the chosen row and the target
  phone PAS-opened card sheet choice -> back -> that field leaves the report (card detail, not held)

Alignment evidence: choice row left/right lines must agree within 1px, action
button tops must agree within 1px, and the question target row must share the
comment composer's left and right lines within 1px.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright


# name, surface, scene, expanded, extra query params, expect a question block
STATES = [
    ("pas-choice", "pas", "ga", False, {}, True),
    ("pas-choice-expanded", "pas", "ga", True, {}, True),
    ("pas-awaiting", "pas", "na", False, {}, True),
    ("pas-answered", "pas", "da", False, {}, True),
    ("pas-request", "pas", "ra", False, {}, True),
    ("pas-legacy", "pas", "ma", False, {}, True),
    ("pas-revised", "pas", "ba", False, {}, True),
    ("card-choice", "card", "ga", False, {}, True),
    ("card-awaiting", "card", "na", False, {}, True),
    ("card-append-target", "card", "da", False, {}, True),
    ("card-request", "card", "ra", False, {}, True),
    ("card-legacy", "card", "ma", False, {}, True),
    ("card-revised", "card", "ba", False, {}, True),
]
EXTRA_STATES = [
    ("pas-read-error", "pas", "ga", True, {"fail": "read"}, False),
    ("card-loading", "card", "ga", False, {"slow": "1"}, False),
]
VIEWPORTS = [(820, 1180), (390, 844)]
THEMES = ("light", "dark")
BLOCK_SELECTOR = '[data-testid^="card-question-q-"]'
COMPOSER_SELECTOR = '[data-testid="card-comment-composer"]'


def build_url(base: str, surface: str, scene: str, expanded: bool, theme: str, extra: dict[str, str]) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["cardQuestion"]
    query["surface"] = [surface]
    query["scene"] = [scene]
    query["theme"] = [theme]
    if expanded:
        query["expanded"] = ["1"]
    for key, value in extra.items():
        query[key] = [value]
    return urllib.parse.urlunsplit((
        parts.scheme,
        parts.netloc,
        parts.path,
        urllib.parse.urlencode(query, doseq=True),
        parts.fragment,
    ))


METRICS_SCRIPT = r"""
() => {
  const round = (value) => Math.round(value * 100) / 100;
  const rect = (element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: round(bounds.left), top: round(bounds.top), right: round(bounds.right),
      bottom: round(bounds.bottom), width: round(bounds.width), height: round(bounds.height),
    };
  };
  const testId = (element) => element ? (element.getAttribute('data-testid') || null) : null;
  const composed = (element) => {
    const parts = [];
    for (const child of element.querySelectorAll('[data-testid^="card-question-choice-"] [aria-label]')) {
      parts.push(child.getAttribute('aria-label'));
    }
    return parts;
  };
  const block = document.querySelector('[data-testid^="card-question-q-"]');
  const choices = [...document.querySelectorAll('[data-testid^="card-question-choice-"]')].map((element, index) => ({
    index, testId: testId(element), label: element.getAttribute('aria-label'), ...rect(element),
  }));
  const actionRoot = document.querySelector('[data-testid="card-question-actions"]');
  const actions = actionRoot
    ? [...actionRoot.querySelectorAll('[aria-label]')].map((element) => ({
        label: element.getAttribute('aria-label'), ...rect(element),
        visible: element.getBoundingClientRect().width > 0,
      }))
    : [];
  const thread = document.querySelector('[data-testid^="card-question-thread-"]');
  const waiting = document.querySelector('[data-testid^="card-question-waiting-"]');
  const answered = document.querySelector('[data-testid="card-question-answered"]');
  const target = document.querySelector('[data-testid="card-question-target"]');
  const composer = document.querySelector('[data-testid="card-comment-composer"]');
  const composerBox = composer ? composer.querySelector('[data-testid="chat-composer-box"]') : null;
  const sendButton = composer ? composer.querySelector('[data-testid="chat-composer-send-button"]') : null;
  const sheet = document.querySelector('[data-testid^="report-sheet-"]');
  const reading = document.querySelector('[data-testid="report-reading"]');
  const reportTitle = document.querySelector('[data-testid="report-title"]');
  const container = document.querySelector('[data-testid="card-detail-container"]');
  const over = [];
  const scope = composer || container || sheet || document.body;
  for (const element of scope.querySelectorAll('*')) {
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) continue;
    if (bounds.right > window.innerWidth + 1 || bounds.left < -1) {
      over.push({ testId: testId(element), right: round(bounds.right), left: round(bounds.left),
        text: (element.textContent || '').trim().slice(0, 30) });
      if (over.length >= 7) break;
    }
  }
  const errorNotice = document.querySelector('[data-testid^="persistent-report-card-error-"]')
    || document.querySelector('[data-testid="card-detail-scroll"]');
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    progressbars: document.querySelectorAll('[role="progressbar"]').length,
    docScrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    block: block ? { id: testId(block), ...rect(block) } : null,
    blockText: block ? (block.innerText || '').trim() : '',
    choices, composed: choices.length ? composed(block || document.body) : [],
    actions,
    thread: thread ? { id: testId(thread), ...rect(thread) } : null,
    waiting: waiting ? { id: testId(waiting), ...rect(waiting) } : null,
    answered: answered ? { ...rect(answered), text: (answered.innerText || '').trim() } : null,
    questionTarget: target ? { ...rect(target), text: (target.innerText || '').trim() } : null,
    composer: composer ? { ...rect(composer), box: composerBox ? rect(composerBox) : null, send: sendButton ? rect(sendButton) : null } : null,
    sheet: sheet ? { id: testId(sheet), ...rect(sheet), title: reportTitle ? (reportTitle.innerText || '').trim() : null } : null,
    reading: reading ? rect(reading) : null,
    cardContainer: container ? rect(container) : null,
    errorNotice: errorNotice ? { testId: testId(errorNotice), text: (errorNotice.innerText || '').trim().slice(0, 120) } : null,
    overflow: over,
    text: container ? (container.innerText || '').slice(0, 4000) : (sheet ? (sheet.innerText || '').slice(0, 4000) : ''),
  };
}
"""


def alignment_failures(metrics: dict, label: str) -> list[dict]:
    failures: list[dict] = []
    choices = metrics["choices"]
    if len(choices) >= 2:
        lefts = [choice["left"] for choice in choices]
        rights = [choice["right"] for choice in choices]
        if max(lefts) - min(lefts) > 1.0:
            failures.append({"check": "choice left line", "label": label, "values": lefts})
        if max(rights) - min(rights) > 1.0:
            failures.append({"check": "choice right line", "label": label, "values": rights})
        tops = [choice["top"] for choice in choices]
        if len(tops) >= 2 and any(later <= earlier for earlier, later in zip(tops, tops[1:])):
            failures.append({"check": "choice order", "label": label, "values": tops})
    visible_actions = [action for action in metrics["actions"] if action["visible"]]
    if len(visible_actions) >= 2:
        tops = [action["top"] for action in visible_actions]
        if max(tops) - min(tops) > 1.0:
            failures.append({"check": "action top line", "label": label,
                             "labels": [action["label"] for action in visible_actions], "values": tops})
    target = metrics["questionTarget"]
    composer = metrics["composer"]
    if target and composer:
        if abs(target["left"] - composer["left"]) > 1.0:
            failures.append({"check": "target left", "label": label,
                             "target": target["left"], "composer": composer["left"]})
        if abs(target["right"] - composer["right"]) > 1.0:
            failures.append({"check": "target right", "label": label,
                             "target": target["right"], "composer": composer["right"]})
    if composer and composer.get("send") and composer["send"]["right"] > composer["right"] + 1.0:
        failures.append({"check": "send button pushed out", "label": label,
                         "send": composer["send"], "composer": composer["right"]})
    if metrics["docScrollWidth"] > metrics["viewport"]["width"] + 1:
        failures.append({"check": "horizontal overflow", "label": label,
                         "scrollWidth": metrics["docScrollWidth"], "viewport": metrics["viewport"]["width"]})
    if metrics["overflow"]:
        failures.append({"check": "element overflow", "label": label, "elements": metrics["overflow"]})
    return failures


def count(locator: Locator) -> int:
    try:
        return locator.count()
    except Exception:
        return 0


def settle(page: Page) -> None:
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(250)


def detail_surface(surface: str, expanded: bool, width: int) -> bool:
    return surface == "card" or (surface == "pas" and expanded and width < 768)


def wait_surface(page: Page, surface: str, expanded: bool, width: int) -> None:
    if detail_surface(surface, expanded, width):
        page.locator('[data-testid="card-detail-container"]').wait_for(state="visible")
    else:
        page.locator('[data-testid="card-question-pas-sample"]').wait_for(state="visible")


def open_comments_tab(page: Page) -> None:
    tab = page.get_by_test_id("settings-segment-card-detail-comments")
    if count(tab) > 0:
        tab.first.click()
        page.wait_for_timeout(200)


def active_element(page: Page) -> dict | None:
    return page.evaluate("""
    () => {
      const element = document.activeElement;
      if (!element) return null;
      return {
        tag: element.tagName,
        testId: element.getAttribute ? element.getAttribute('data-testid') : null,
        ariaLabel: element.getAttribute ? element.getAttribute('aria-label') : null,
        placeholder: element.getAttribute ? element.getAttribute('placeholder') : null,
        text: (element.textContent || '').trim().slice(0, 60),
      };
    }
    """)


def composer_input(page: Page) -> Locator:
    return page.locator(COMPOSER_SELECTOR).locator('[data-testid="chat-composer-text-input"]').first


def composer_focused(page: Page) -> bool:
    return page.evaluate("""
    () => {
      const input = document.querySelector('[data-testid="card-comment-composer"] [data-testid="chat-composer-text-input"]');
      return !!input && document.activeElement === input;
    }
    """)


def input_value(page: Page) -> str:
    locator = composer_input(page)
    if count(locator) == 0:
        return ""
    return locator.input_value()


def clear_draft(page: Page) -> None:
    locator = composer_input(page)
    if count(locator) > 0:
        locator.click()
        locator.fill("")
        page.wait_for_timeout(100)


def record(result: dict, item: int, check: str, label: str, passed: bool, detail: dict) -> None:
    entry = {"item": item, "check": check, "label": label, "passed": passed, "detail": detail}
    result["operations"].append(entry)
    if not passed:
        result["failures"].append({"check": f"operation {item}: {check}", "label": label, "detail": detail})


def goto(page: Page, base: str, surface: str, scene: str, expanded: bool, theme: str,
         width: int, extra: dict[str, str] | None = None) -> None:
    page.goto(build_url(base, surface, scene, expanded, theme, extra or {}), wait_until="networkidle")
    wait_surface(page, surface, expanded, width)


def capture_state(
    page: Page,
    base: str,
    state_name: str,
    surface: str,
    scene: str,
    expanded: bool,
    extra: dict[str, str],
    expect_block: bool,
    width: int,
    theme: str,
    output: Path,
    result: dict,
) -> dict:
    label = f"{state_name}-{width}-{theme}"
    page.goto(build_url(base, surface, scene, expanded, theme, extra),
              wait_until="domcontentloaded" if state_name == "card-loading" else "networkidle")
    wait_surface(page, surface, expanded, width)
    if expect_block:
        page.locator(BLOCK_SELECTOR).first.wait_for(state="visible")
    if detail_surface(surface, expanded, width):
        open_comments_tab(page)
        if expect_block:
            page.locator(BLOCK_SELECTOR).first.wait_for(state="visible")
    if state_name == "card-loading":
        page.wait_for_timeout(500)
    else:
        settle(page)
    failures: list[dict] = result["failures"]
    if state_name == "pas-read-error" and width >= 768:
        retry = page.get_by_test_id("persistent-report-card-retry")
        if count(retry) == 0:
            failures.append({"check": "read error retry", "label": label})
        else:
            error = page.locator('[data-testid^="persistent-report-card-error-"]')
            metrics_text = error.first.inner_text() if count(error) else ""
            if "카드를 불러오지 못했습니다" not in metrics_text:
                failures.append({"check": "read error notice", "label": label, "actual": metrics_text})
    root = (page.locator('[data-testid="card-detail-container"]') if detail_surface(surface, expanded, width)
            else page.locator('[data-testid="card-question-pas-sample"]'))
    frame_name = f"card-question-{state_name}-{width}-{theme}.png"
    root.first.screenshot(path=str(output / frame_name))
    block = page.locator(BLOCK_SELECTOR).first
    block_name = None
    if count(block) > 0 and block.is_visible():
        block_name = f"card-question-{state_name}-{width}-{theme}-block.png"
        block.screenshot(path=str(output / block_name))
    metrics = page.evaluate(METRICS_SCRIPT)
    state_failures = alignment_failures(metrics, label) if state_name != "card-loading" else []
    failures.extend(state_failures)
    if state_name == "pas-read-error" and metrics["errorNotice"] and width >= 768 \
            and "불러오지 못했습니다" not in metrics["errorNotice"]["text"]:
        failures.append({"check": "read error text", "label": label, "actual": metrics["errorNotice"]["text"]})
    if state_name == "card-loading":
        loading_ok = metrics["block"] is None and metrics["progressbars"] >= 1
        record(result, 13, "로딩 틀", label, loading_ok,
               {"block": bool(metrics["block"]), "progressbars": metrics["progressbars"],
                "tabs": bool(metrics["cardContainer"])})
    return {
        "state": state_name,
        "surface": surface,
        "scene": scene,
        "width": width,
        "theme": theme,
        "expanded": expanded,
        "capture": frame_name,
        "blockCapture": block_name,
        **metrics,
        "alignmentFailures": state_failures,
    }


def measure_interactions(page: Page, base: str, width: int, output: Path, result: dict) -> None:
    theme = "light"
    label = f"ops-{width}"
    failures: list[dict] = result["failures"]

    # 14: 되묻기 puts focus into the answer composer of the card detail sheet.
    goto(page, base, "card", "ga", False, theme, width)
    open_comments_tab(page)
    ask_back = page.locator('[data-testid="card-question-actions"] [aria-label="되묻기"]')
    if count(ask_back) > 0:
        ask_back.first.click()
        page.wait_for_timeout(350)
        target = page.get_by_test_id("card-question-target")
        active = active_element(page) or {}
        target_text = target.first.inner_text() if count(target) else ""
        focused = active.get("placeholder") == "물어볼 것" or active.get("ariaLabel") == "물어볼 것"
        record(result, 14, "되묻기 뒤 초점", label, focused,
               {"active": active, "target": target_text})
        page.screenshot(path=str(output / f"ops-{width}-ask-back.png"))
    else:
        record(result, 14, "되묻기 뒤 초점", label, False, {"active": None, "reason": "되묻기 단추 없음"})

    # 14: a choice answers immediately, sets the append target, and must not move focus.
    goto(page, base, "card", "ga", False, theme, width)
    open_comments_tab(page)
    choice = page.get_by_test_id("card-question-choice-0")
    if count(choice) > 0:
        choice.first.click()
        page.wait_for_timeout(450)
        active = active_element(page) or {}
        target = page.get_by_test_id("card-question-target")
        focused_input = active.get("placeholder") == "물어볼 것" or active.get("ariaLabel") == "물어볼 것"
        target_text = target.first.inner_text() if count(target) else ""
        record(result, 14, "선택 뒤 초점 유지", label, not focused_input,
               {"active": active, "target": target_text})
        rows = page.evaluate("""
        () => [...document.querySelectorAll('[data-testid^="card-question-choice-"]')]
          .map((element) => ({ selected: element.getAttribute('aria-selected'),
            opacity: parseFloat(getComputedStyle(element).opacity) }))
        """)
        chosen = rows[0] if rows else None
        others = rows[1:]
        row_ok = bool(chosen) and chosen["opacity"] >= 0.9 and all(row["opacity"] < 0.9 for row in others)
        record(result, 2, "선택 뒤 고른 행 남김", label,
               row_ok and "덧붙이기: 파일로 옮기기" in target_text,
               {"target": target_text, "rows": rows})
        page.screenshot(path=str(output / f"ops-{width}-choice.png"))
    else:
        record(result, 14, "선택 뒤 초점 유지", label, False, {"reason": "선택지 없음"})

    # 15: Tab order stays on visible controls inside the sheet; Esc has no target on iOS.
    goto(page, base, "card", "ga", False, theme, width)
    open_comments_tab(page)
    input_locator = composer_input(page)
    if count(input_locator) > 0:
        input_locator.click()
        sequence = []
        for _ in range(3):
            page.keyboard.press("Tab")
            page.wait_for_timeout(120)
            sequence.append(active_element(page))
        inside = page.evaluate("""
        () => {
          const container = document.querySelector('[data-testid="card-detail-container"]');
          const active = document.activeElement;
          return !!container && !!active && container.contains(active)
            && !!(active.offsetWidth || active.offsetHeight || active.getClientRects().length);
        }
        """)
        record(result, 15, "Tab 순서", label, inside, {"sequence": sequence})
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        still_open = count(page.get_by_test_id("card-detail-container")) > 0
        record(result, 15, "Esc", label, True,
               {"applicable": False, "stillOpen": still_open,
                "reason": "아이오에스 앱에는 Esc 키가 없다(닫기는 헤더 뒤로 단추)"})
        page.screenshot(path=str(output / f"ops-{width}-tab.png"))

    # 17: a failed question write keeps the draft in the composer.
    if width < 768:
        goto(page, base, "card", "ga", False, theme, width, {"fail": "1"})
        open_comments_tab(page)
        input_locator = composer_input(page)
        if count(input_locator) > 0:
            input_locator.click()
            page.keyboard.type("실패 초안")
            page.wait_for_timeout(100)
            send = page.locator(COMPOSER_SELECTOR).locator('[data-testid="chat-composer-send-button"]').first
            if count(send) > 0:
                send.click()
                page.wait_for_timeout(500)
            kept = input_value(page)
            record(result, 17, "쓰기 실패 뒤 초안 보존", label, kept == "실패 초안",
                   {"value": kept, "notice": "웹 검수 창에서는 RN Alert가 그려지지 않는다(실패 안내는 실기기 확인)"})
            page.screenshot(path=str(output / f"ops-{width}-write-failure.png"))
            clear_draft(page)
        else:
            record(result, 17, "쓰기 실패 뒤 초안 보존", label, False, {"reason": "입력창 없음"})

    # 18: resize keeps the draft and the folded layout.
    if width == 820:
        goto(page, base, "card", "ga", False, theme, width)
        open_comments_tab(page)
        input_locator = composer_input(page)
        if count(input_locator) > 0:
            input_locator.click()
            page.keyboard.type("이대로")
            page.wait_for_timeout(150)
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(700)
            narrow_value = input_value(page)
            narrow_width = page.evaluate("() => Math.max(document.documentElement.scrollWidth, window.innerWidth)")
            narrow_block = count(page.locator(BLOCK_SELECTOR)) > 0
            page.screenshot(path=str(output / f"ops-resize-narrow.png"))
            page.set_viewport_size({"width": 820, "height": 1180})
            page.wait_for_timeout(700)
            wide_value = input_value(page)
            record(result, 18, "창 크기 바꾸기", "ops-resize",
                   narrow_value == "이대로" and wide_value == "이대로" and narrow_block and narrow_width <= 391,
                   {"narrowValue": narrow_value, "wideValue": wide_value,
                    "narrowScrollWidth": narrow_width, "blockAfterResize": narrow_block})
            page.screenshot(path=str(output / f"ops-resize-wide.png"))
            clear_draft(page)

        # 18: the PAS expansion folds back to the phone layout on rotation.
        goto(page, base, "pas", "ga", True, theme, width)
        expansion = page.get_by_test_id("persistent-report-card-expansion-cq_q-secret")
        try:
            expansion.wait_for(state="visible")
        except Exception:
            pass
        if count(expansion) > 0:
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(800)
            sample_visible = count(page.get_by_test_id("card-question-pas-sample")) > 0 and \
                page.get_by_test_id("card-question-pas-sample").first.is_visible()
            folded = count(page.locator('[data-testid="card-question-actions"] [aria-label="다르게 답하기"]')) > 0
            scroll_width = page.evaluate("() => Math.max(document.documentElement.scrollWidth, window.innerWidth)")
            record(result, 18, "PAS 펼침 회전", "ops-resize-pas",
                   sample_visible and folded and scroll_width <= 391,
                   {"pasVisible": sample_visible, "foldedAction": folded, "scrollWidth": scroll_width})
            page.screenshot(path=str(output / f"ops-resize-pas.png"))
            page.set_viewport_size({"width": 820, "height": 1180})
            page.wait_for_timeout(500)

    # Contract 2: the folded PAS choice answers through the report path.
    goto(page, base, "pas", "ga", False, theme, width)
    choice = page.get_by_test_id("card-question-choice-0")
    if count(choice) > 0:
        choice.first.click()
        page.wait_for_timeout(450)
        answered = page.locator('[data-testid="card-question-answered"]')
        text = answered.first.inner_text() if count(answered) else ""
        record(result, 2, "접힌 장 선택 답", label, count(answered) > 0 and "파일로 옮기기" in text,
               {"answered": text})
        page.screenshot(path=str(output / f"ops-{width}-pas-folded-choice.png"))
    else:
        record(result, 2, "접힌 장 선택 답", label, False, {"reason": "선택지 없음"})

    # Contract 2: the expanded PAS choice answers through the card REST path and keeps the target.
    if width == 820:
        goto(page, base, "pas", "ga", True, theme, width)
        choice = page.locator('[data-testid="card-question-choice-0"]')
        if count(choice) > 0:
            choice.first.click()
            page.wait_for_timeout(700)
            target = page.get_by_test_id("card-question-target")
            answered = page.locator('[data-testid="card-question-answered"]')
            target_text = target.first.inner_text() if count(target) else ""
            record(result, 2, "펼친 장 선택 답", "ops-expanded",
                   "덧붙이기: 파일로 옮기기" in target_text and count(answered) > 0,
                   {"target": target_text, "answered": count(answered) > 0})
            page.screenshot(path=str(output / "ops-820-pas-expanded-choice.png"))
        else:
            record(result, 2, "펼친 장 선택 답", "ops-expanded", False, {"reason": "선택지 없음"})

    # 계약 3절 2번 답 흐름: 접힌 장 덧붙이기, 펼친 장 접기, 폰 카드 시트.
    measure_answer_scenarios(page, base, width, output, result)

    # 초점 수명(계약 3절 15번): 되묻기, 해제, 닫기, 다시 열기 -> document.activeElement.
    focus_lifetime_checks(page, base, width, output, result)


QUESTION_STATE_SCRIPT = r"""
() => {
  const text = (element) => element ? element.innerText : null;
  const rows = [...document.querySelectorAll('[data-testid^="card-question-choice-"]')].map((element) => ({
    selected: element.getAttribute('aria-selected'),
    opacity: parseFloat(getComputedStyle(element).opacity),
  }));
  const target = document.querySelector('[data-testid="card-question-target"]');
  const answered = document.querySelector('[data-testid="card-question-answered"]');
  const actions = document.querySelector('[data-testid="card-question-actions"]');
  return {
    rows,
    target: text(target),
    answered: text(answered),
    actions: text(actions),
    askBack: !!(actions && actions.querySelector('[aria-label="되묻기"]')),
    blocks: document.querySelectorAll('[data-testid^="card-question-q-"]').length,
  };
}
"""


def question_state(page: Page) -> dict:
    return page.evaluate(QUESTION_STATE_SCRIPT)


def selection_kept(state: dict) -> bool:
    rows = state["rows"]
    return bool(rows) and rows[0]["opacity"] >= 0.9 and all(row["opacity"] < 0.9 for row in rows[1:])


def measure_answer_scenarios(page: Page, base: str, width: int, output: Path, result: dict) -> None:
    """계약 3절 2번의 답 흐름을 selaphiel 재검수 T2, T3, T4, P2 측정대로 PASS 판정한다."""
    theme = "light"
    if width >= 768:
        # T4: 접힌 장에서 고른 뒤 덧붙이기로 펼치면 고른 행과 대상 줄이 남고 되묻기가 없다.
        goto(page, base, "pas", "ga", False, theme, width)
        choice = page.get_by_test_id("card-question-choice-0")
        if count(choice) == 0:
            record(result, 2, "접힌 장 답 뒤 덧붙이기", f"ops-{width}-append-expanded", False, {"reason": "선택지 없음"})
        else:
            choice.first.click()
            page.wait_for_timeout(450)
            append = page.locator('[aria-label="덧붙이기"]')
            if count(append) > 0:
                append.first.click()
                page.wait_for_timeout(1000)
            state = question_state(page)
            target = state["target"] or ""
            passed = selection_kept(state) and "덧붙이기: 파일로 옮기기" in target and not state["askBack"]
            record(result, 2, "접힌 장 답 뒤 덧붙이기", f"ops-{width}-append-expanded", passed, state)
            page.screenshot(path=str(output / f"ops-{width}-append-expanded.png"))

        # T2: 펼친 장에서 고른 뒤 접으면 접힌 장이 받은 답과 덧붙이기로 남는다.
        goto(page, base, "pas", "ga", True, theme, width)
        choice = page.get_by_test_id("card-question-choice-0")
        if count(choice) == 0:
            record(result, 2, "펼친 장 답 뒤 접기", f"ops-{width}-folded-answered", False, {"reason": "선택지 없음"})
        else:
            choice.first.click()
            page.wait_for_timeout(1000)
            toggle = page.get_by_test_id("report-window-toggle")
            if count(toggle) > 0:
                toggle.first.click()
                page.wait_for_timeout(800)
            state = question_state(page)
            answered = state["answered"] or ""
            passed = "받은 답" in answered and "파일로 옮기기" in answered \
                and count(page.locator('[aria-label="덧붙이기"]')) > 0
            record(result, 2, "펼친 장 답 뒤 접기", f"ops-{width}-folded-answered", passed, state)
            page.screenshot(path=str(output / f"ops-{width}-folded-answered.png"))
    else:
        # P2: 접힌 장에서 고른 뒤 덧붙이기로 연 시트에 고른 행과 대상 줄이 함께 보인다.
        goto(page, base, "pas", "ga", False, theme, width)
        choice = page.get_by_test_id("card-question-choice-0")
        if count(choice) == 0:
            record(result, 2, "폰 시트 고른 행과 대상", f"ops-{width}-append-sheet", False, {"reason": "선택지 없음"})
        else:
            choice.first.click()
            page.wait_for_timeout(1000)
            append = page.locator('[aria-label="덧붙이기"]')
            if count(append) > 0:
                append.first.click()
                page.wait_for_timeout(1000)
            open_comments_tab(page)
            state = question_state(page)
            target = state["target"] or ""
            passed = selection_kept(state) and "덧붙이기: 파일로 옮기기" in target
            record(result, 2, "폰 시트 고른 행과 대상", f"ops-{width}-append-sheet", passed, state)
            page.screenshot(path=str(output / f"ops-{width}-append-sheet.png"))

        # 위임자 결정: PAS로 연 카드 시트의 선택은 판에 붙들지 않고, 뒤로 오면 그 장이 판에서 빠진다.
        goto(page, base, "pas", "ga", False, theme, width)
        toggle = page.get_by_test_id("report-window-toggle")
        if count(toggle) == 0:
            record(result, 2, "카드 시트 답 뒤 장 빠짐", f"ops-{width}-sheet-answer-back", False,
                   {"reason": "펼침 단추 없음"})
        else:
            toggle.first.click()
            page.wait_for_timeout(900)
            open_comments_tab(page)
            choice = page.get_by_test_id("card-question-choice-0")
            if count(choice) == 0:
                record(result, 2, "카드 시트 답 뒤 장 빠짐", f"ops-{width}-sheet-answer-back", False,
                       {"reason": "선택지 없음"})
            else:
                choice.first.click()
                page.wait_for_timeout(1000)
                back = page.locator('[aria-label="뒤로"]')
                if count(back) > 0:
                    back.first.click()
                page.wait_for_timeout(700)
                state = question_state(page)
                passed = state["blocks"] == 0 and state["answered"] is None
                record(result, 2, "카드 시트 답 뒤 장 빠짐", f"ops-{width}-sheet-answer-back", passed, state)
                page.screenshot(path=str(output / f"ops-{width}-sheet-answer-back.png"))


def focus_lifetime_checks(page: Page, base: str, width: int, output: Path, result: dict) -> None:
    """초점 수명(계약 3절 15번): 대상과 초점 요청은 만든 표면이 살아 있는 동안만 산다.

    selaphiel 정찰병이 잰 A(폰: 되묻기, 해제, 닫기, 다시 열기), B(아이패드: 되묻기, 해제,
    접기, 펴기), B0(새 펼침) 조작을 그대로 PASS 판정으로 옮긴다.
    """
    theme = "light"
    label = f"ops-{width}-focus"
    goto(page, base, "pas", "ga", False, theme, width)
    ask_back = page.locator('[data-testid="card-question-actions"] [aria-label="되묻기"]')
    if count(ask_back) == 0:
        record(result, 14, "판 되묻기 뒤 초점", label, False, {"reason": "되묻기 단추 없음"})
        return
    ask_back.first.click()
    page.wait_for_timeout(900)
    record(result, 14, "판 되묻기 뒤 초점", label, composer_focused(page), {"active": active_element(page)})
    page.screenshot(path=str(output / f"ops-{width}-focus-ask-back.png"))
    release = page.locator('[data-testid="card-question-target"] [aria-label="대상 해제"]')
    if count(release) > 0:
        release.first.click()
        page.wait_for_timeout(300)
    if width < 768:
        back = page.locator('[aria-label="뒤로"]')
        if count(back) > 0:
            back.first.click()
            page.wait_for_timeout(600)
    else:
        toggle = page.get_by_test_id("report-window-toggle")
        if count(toggle) > 0:
            toggle.first.click()
            page.wait_for_timeout(700)
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    toggle = page.get_by_test_id("report-window-toggle")
    if count(toggle) > 0:
        toggle.first.click()
        page.wait_for_timeout(900)
    reopened_focused = composer_focused(page)
    record(result, 14, "다시 연 표면 초점 없음", label, not reopened_focused, {"active": active_element(page)})
    page.screenshot(path=str(output / f"ops-{width}-focus-reopen.png"))

    # B0 통제: 아무 조작 없이 토글만 눌러 펼친 새 표면은 남은 초점 요청을 따르지 않는다.
    goto(page, base, "pas", "ga", False, theme, width)
    fresh = page.get_by_test_id("report-window-toggle")
    if count(fresh) > 0:
        fresh.first.click()
        page.wait_for_timeout(900)
    fresh_focused = composer_focused(page)
    record(result, 14, "새 펼침 초점 없음", f"{label}-fresh", not fresh_focused, {"active": active_element(page)})
    page.screenshot(path=str(output / f"ops-{width}-focus-fresh.png"))

    if width < 768:
        # 유지해야 하는 동작: 폰 접힌 장의 다르게 답하기도 카드 시트를 펴고 입력창에 초점을 준다.
        goto(page, base, "pas", "ga", False, theme, width)
        free = page.locator('[data-testid="card-question-actions"] [aria-label="다르게 답하기"]')
        if count(free) > 0:
            free.first.click()
            page.wait_for_timeout(900)
            record(result, 14, "판 다르게 답하기 뒤 초점", label, composer_focused(page),
                   {"active": active_element(page)})
        else:
            record(result, 14, "판 다르게 답하기 뒤 초점", label, False, {"reason": "다르게 답하기 단추 없음"})


def main() -> int:
    parser = argparse.ArgumentParser(description="Card question sheet visual check")
    parser.add_argument("base_url", help="review bundle URL, e.g. http://127.0.0.1:4173/assets/ios-components/index.html")
    parser.add_argument("output", help="directory for captures and metrics JSON")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "baseUrl": args.base_url,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False,
        "states": [],
        "operations": [],
        "failures": [],
        "pageErrors": [],
        "consoleErrors": [],
    }
    base_netloc = urllib.parse.urlsplit(args.base_url).netloc

    def route_request(route) -> None:
        request_url = urllib.parse.urlsplit(route.request.url)
        if request_url.path == "/api/auth/status":
            route.fulfill(status=200, content_type="application/json", body='{"authenticated":true}')
        elif request_url.netloc == base_netloc or route.request.url.startswith(("data:", "blob:")):
            route.continue_()
        else:
            route.abort()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in VIEWPORTS:
                for theme in THEMES:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        color_scheme=theme,
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.set_default_timeout(15000)
                    page.on("pageerror", lambda error, label=f"{width}-{theme}": result["pageErrors"].append(f"{label}: {error}"))
                    page.on("console", lambda message, label=f"{width}-{theme}": (
                        result["consoleErrors"].append(f"{label} console: {message.text}")
                        if message.type == "error" else None
                    ))
                    context.route("**/*", route_request)
                    try:
                        for state in STATES + EXTRA_STATES:
                            result["states"].append(capture_state(
                                page, args.base_url, *state, width, theme, output, result,
                            ))
                        if theme == "light":
                            measure_interactions(page, args.base_url, width, output, result)
                    finally:
                        context.close()
        finally:
            browser.close()

    result["passed"] = not result["failures"] and not result["pageErrors"]
    metrics_path = output / "card-question-metrics.json"
    metrics_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"card question visual check: {'PASS' if result['passed'] else 'FAIL'}")
    print(f"metrics: {metrics_path}")
    print(f"captures: {len(result['states'])} state frames")
    print(f"operations: {len(result['operations'])} checks")
    failed = [entry for entry in result["operations"] if not entry["passed"]]
    if failed:
        print(f"failed operations: {json.dumps(failed, ensure_ascii=False, indent=2)}")
    if result["failures"]:
        print(f"failures: {json.dumps(result['failures'], ensure_ascii=False, indent=2)}")
    if result["pageErrors"]:
        print(f"page errors: {json.dumps(result['pageErrors'], ensure_ascii=False, indent=2)}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

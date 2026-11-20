#!/usr/bin/env python3
"""Provider panel visual check (RN web component review bundle).

Launch method
-------------
1. Export the review bundle once from the soul-app directory:
       npm run export:components
   The bundle is written to unified-dashboard/dist/assets/ios-components.
2. Serve the dist root (not the bundle directory) with any static server:
       python3 -m http.server 4173 --directory unified-dashboard/dist
3. Run this script with the bundle URL and an output directory:
       python3 -P soul-app/scripts/visual-check/provider_panel.py \
           http://127.0.0.1:4173/assets/ios-components/index.html ./evidence/provider-panel

The script opens the public-fixture review page (?section=claudePool). It does
not contact a node or the real provider APIs; every API answer comes from the
component-review fixtures. It captures the four requested states at iPad 820
and iPhone 390 in light and dark, plus one delayed-summary loading frame, and
records each quota grid's three cell left coordinates, track/bar vertical
coordinates, and each circular icon button's visual circle right edge. Column
lefts must agree within 1px across rows, the three track tops must agree within
1px inside a row, and the circle right edges must agree with the gauge track
right edge within 1px. The -screen.png files capture the whole
settings-section-backends root after the inner ScrollView returns to the top,
so the first node card and the last provider row are both present.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright


STATES = [
    ("default", "default", False),
    ("pool-expanded", "default", True),
    ("legacy-stale", "legacy-stale", False),
    ("codex-both", "codex-both", False),
]
VIEWPORTS = [(820, 1180), (390, 844)]
THEMES = ("light", "dark")
PROVIDER_ROW_RE = r"^provider-row-(claude|opencode_go|codex|antigravity)$"


def build_url(base: str, state: str, theme: str) -> str:
    parts = urllib.parse.urlsplit(base)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["section"] = ["claudePool"]
    query["theme"] = [theme]
    query["state"] = [state]
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
      left: round(bounds.left),
      top: round(bounds.top),
      right: round(bounds.right),
      width: round(bounds.width),
      height: round(bounds.height),
    };
  };
  const cellsFor = (row, prefix) => {
    const found = [];
    for (const element of row.querySelectorAll('[data-testid]')) {
      const testId = element.getAttribute('data-testid') || '';
      if (prefix === 'provider') {
        if (!/^provider-quota-[a-z_]+-\d+$/.test(testId)) continue;
      } else {
        if (!testId.startsWith(`claude-quota-${prefix}-`)) continue;
        if (!/^claude-quota-.+-\d+$/.test(testId)) continue;
        if (testId.includes('-bar-')) continue;
      }
      const indexMatch = testId.match(/-(\d+)$/);
      if (!indexMatch) continue;
      const index = Number(indexMatch[1]);
      const bar = element.querySelector(`[data-testid$="-bar-${index}"]`);
      const track = bar ? bar.parentElement : null;
      found.push({
        index,
        testId,
        ...rect(element),
        childCount: element.children.length,
        trackTop: track ? rect(track).top : null,
        trackRight: track ? rect(track).right : null,
        trackHeight: track ? rect(track).height : null,
        barTop: bar ? rect(bar).top : null,
        barWidth: bar ? rect(bar).width : null,
      });
    }
    return found.sort((a, b) => a.index - b.index);
  };
  const providerRows = [];
  for (const row of document.querySelectorAll('[data-testid^="provider-row-"]')) {
    const rowId = row.getAttribute('data-testid') || '';
    if (!/^provider-row-(claude|opencode_go|codex|antigravity)$/.test(rowId)) continue;
    providerRows.push({ row: rowId, provider: rowId.slice('provider-row-'.length), cells: cellsFor(row, 'provider') });
  }
  const accountRows = [];
  for (const row of document.querySelectorAll('[data-testid^="claude-account-row-"]')) {
    const rowId = row.getAttribute('data-testid') || '';
    if (!/^claude-account-row-.+/.test(rowId)) continue;
    const accountId = rowId.slice('claude-account-row-'.length);
    accountRows.push({ row: rowId, accountId, cells: cellsFor(row, accountId) });
  }
  const circleButtons = [];
  const buttons = [];
  for (const id of ['provider-panel-refresh', 'claude-provider-toggle', 'claude-delete-action']) {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (element) buttons.push(element);
  }
  if (!document.querySelector('[data-testid="claude-delete-action"]')) {
    const login = document.querySelector('[data-testid="claude-login-action"]');
    if (login) buttons.push(login);
  }
  for (const element of document.querySelectorAll('[data-testid^="claude-account-delete-"]')) {
    const id = element.getAttribute('data-testid') || '';
    if (id.startsWith('claude-account-delete-confirmation-')
      || id === 'claude-account-delete-cancel'
      || id.startsWith('claude-account-delete-confirm-')) continue;
    buttons.push(element);
  }
  for (const element of buttons) {
    const bounds = element.getBoundingClientRect();
    let visual = null;
    for (const child of element.querySelectorAll('*')) {
      const childRect = child.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(child).borderTopLeftRadius) || 0;
      if (childRect.width > 0 && childRect.width < bounds.width - 1 && radius >= childRect.width / 2 - 0.5) {
        visual = childRect;
        break;
      }
    }
    circleButtons.push({
      id: element.getAttribute('data-testid'),
      ...rect(element),
      visualRight: visual ? round(visual.right) : null,
      visualWidth: visual ? round(visual.width) : null,
    });
  }
  const skeleton = document.querySelector('[data-testid="claude-gauge-loading"]');
  const panel = document.querySelector('[data-testid="provider-panel"]');
  return {
    panel: panel ? rect(panel) : null,
    skeleton: skeleton ? rect(skeleton) : null,
    providerRows,
    accountRows,
    circleButtons,
    text: panel ? panel.innerText : '',
  };
}
"""


def rounded(value: float) -> float:
    return round(value, 2)


def alignment_failures(metrics: dict, label: str) -> list[dict]:
    failures: list[dict] = []
    grids = [row for row in metrics["providerRows"] if len(row["cells"]) == 3]
    grids += [row for row in metrics["accountRows"] if len(row["cells"]) == 3]
    # Each quota row owns a complete three-column grid, even when a window is
    # empty, so a missing third cell means the row collapsed instead.
    for row in metrics["providerRows"] + metrics["accountRows"]:
        if row["cells"] and len(row["cells"]) != 3:
            failures.append({"check": "three cells", "label": label, "row": row["row"], "cells": len(row["cells"])})
    for column in range(3):
        values = [row["cells"][column]["left"] for row in grids if len(row["cells"]) > column]
        if len(values) >= 2 and max(values) - min(values) > 1.0:
            failures.append({"check": "column left", "label": label, "column": column, "values": values})
    for row in grids:
        tops = [cell["trackTop"] for cell in row["cells"] if cell["trackTop"] is not None]
        bar_tops = [cell["barTop"] for cell in row["cells"] if cell["barTop"] is not None]
        if len(tops) >= 2 and max(tops) - min(tops) > 1.0:
            failures.append({"check": "track top", "label": label, "row": row["row"], "values": tops})
        if len(bar_tops) >= 2 and max(bar_tops) - min(bar_tops) > 1.0:
            failures.append({"check": "bar top", "label": label, "row": row["row"], "values": bar_tops})
        for cell in row["cells"]:
            if cell["barWidth"] is None and cell["childCount"] != 0:
                failures.append({"check": "empty cell content", "label": label, "row": row["row"],
                                 "cell": cell["testId"], "childCount": cell["childCount"]})
            if cell["barWidth"] is not None and cell["trackRight"] is not None \
                    and abs(cell["trackRight"] - cell["right"]) > 1.0:
                failures.append({"check": "track right", "label": label, "row": row["row"],
                                 "cell": cell["testId"], "trackRight": cell["trackRight"], "right": cell["right"]})

    def right_edge(cell: dict) -> float:
        return cell["trackRight"] if cell["trackRight"] is not None else cell["right"]

    rights = [right_edge(row["cells"][2]) for row in grids if len(row["cells"]) == 3]
    skeleton = metrics.get("skeleton")
    if skeleton is not None:
        rights.append(skeleton["right"])
    if rights:
        if max(rights) - min(rights) > 1.0:
            failures.append({"check": "gauge right line", "label": label, "values": rights})
        reference = max(rights)
        for button in metrics.get("circleButtons", []):
            if button["visualRight"] is None:
                failures.append({"check": "circle button visual", "label": label, "button": button["id"]})
            elif abs(button["visualRight"] - reference) > 1.0:
                failures.append({"check": "circle button right", "label": label, "button": button["id"],
                                 "visualRight": button["visualRight"], "reference": reference})
    return failures


CENTRAL_STATES = [
    ("central-empty", "central-empty"),
    ("central-accounts", "central-accounts"),
    ("central-login-url-ready", "central-login-url-ready"),
    ("central-login-verifying", "central-login-verifying"),
    ("central-login-failed", "central-login-failed"),
    ("central-loading", "central-loading"),
    ("central-error", "central-error"),
]
RECEIVE_STATES = [
    ("receive-on", "receive-on"),
    ("receive-off", "receive-off"),
    ("receive-pending", "receive-pending"),
    ("receive-failure", "receive-failure"),
    ("receive-settings-error", "receive-settings-error"),
]
LONG_CENTRAL_EMAIL = "seosoyoung.workspace+central-primary@example.invalid"

CENTRAL_METRICS_SCRIPT = r"""
() => {
  const text = (element) => (element?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const rect = (element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: Math.round(bounds.left * 10) / 10, top: Math.round(bounds.top * 10) / 10,
      right: Math.round(bounds.right * 10) / 10, bottom: Math.round(bounds.bottom * 10) / 10,
      width: Math.round(bounds.width * 10) / 10, height: Math.round(bounds.height * 10) / 10,
    };
  };
  const central = document.querySelector('[data-testid="settings-section-central-pool"]');
  const backend = document.querySelector('[data-testid="settings-section-backend-scope"]');
  const pool = document.querySelector('[data-testid="claude-account-pool-section"]');
  const receive = document.querySelector('[data-testid="claude-central-receive"]');
  const rows = Array.from(document.querySelectorAll('[data-testid^="claude-account-row-"]'));
  const toggleBox = document.querySelector('[data-testid="claude-central-receive-switch"]');
  // RN-web Switch는 testID 상자 안의 input[role=switch]에 값과 disabled를 담는다.
  const toggle = toggleBox?.querySelector('input[role="switch"]') ?? toggleBox;
  const login = document.querySelector('[data-testid="claude-login-flow"]');
  // 「중앙 풀」 머리는 목록일 때 풀 머리 제목, 로딩·실패일 때 구역이 직접 그린다.
  const centralTitleLeaf = central
    ? Array.from(central.querySelectorAll('*')).find((element) => element.children.length === 0 && text(element) === '중앙 풀')
    : null;
  const loadingBox = document.querySelector('[data-testid="central-pool-loading"]');
  const centralErrorCopy = central
    ? Array.from(central.querySelectorAll('*')).find((element) => element.children.length === 0 && text(element) === '계정 목록을 갱신하지 못했습니다.')
    : null;
  // 받기 줄의 오류 글은 줄 아래에 선다. 설정 읽기 실패와 저장 실패 두 문구만 받기 줄 안에서 찾는다.
  const receiveErrors = receive
    ? Array.from(receive.querySelectorAll('*')).filter((element) => element.children.length === 0
      && ['받기 설정을 불러오지 못했습니다.', '계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.'].includes(text(element)))
    : [];
  return {
    central: central ? { text: text(central), rect: rect(central) } : null,
    centralTitle: centralTitleLeaf ? { text: text(centralTitleLeaf), rect: rect(centralTitleLeaf) } : null,
    loadingRect: loadingBox ? rect(loadingBox) : null,
    centralErrorRect: centralErrorCopy ? rect(centralErrorCopy) : null,
    backend: backend ? { rect: rect(backend) } : null,
    pool: pool ? rect(pool) : null,
    receive: receive ? { text: text(receive), rect: rect(receive) } : null,
    receiveFirst: !!receive && rows.length > 0 && rect(receive).top < rect(rows[0]).top,
    receiveInPool: !!receive && !!pool && pool.contains(receive),
    switch: toggle ? {
      role: toggle.getAttribute('role'),
      ariaChecked: toggle.getAttribute('aria-checked'),
      checked: typeof toggle.checked === 'boolean' ? toggle.checked : null,
      disabled: typeof toggle.disabled === 'boolean' ? toggle.disabled : null,
      ariaDisabled: toggle.getAttribute('aria-disabled'),
    } : null,
    rows: rows.length,
    rowTexts: rows.map(row => text(row).slice(0, 140)),
    login: login ? {
      text: text(login).slice(0, 220),
      code: !!document.querySelector('[data-testid="claude-login-code"]'),
      openAuth: !!document.querySelector('[data-testid="claude-login-open-auth"]'),
      cancel: !!document.querySelector('[data-testid="claude-login-cancel"]'),
      submit: !!document.querySelector('[data-testid="claude-login-submit"]'),
    } : null,
    addButton: !!document.querySelector('[data-testid="claude-account-add"]'),
    loading: !!document.querySelector('[data-testid="central-pool-loading"]'),
    receiveRetry: !!document.querySelector('[data-testid="claude-central-receive-retry"]'),
    receiveError: receiveErrors.length ? text(receiveErrors[0]) : null,
    receiveErrorBelowSwitch: !!(receiveErrors.length && toggle
      && receiveErrors[0].getBoundingClientRect().top >= toggle.getBoundingClientRect().bottom - 0.5),
    bodyText: document.body.innerText,
    document: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
  };
}
"""


def wait_for_backends(page: Page) -> None:
    page.get_by_test_id("settings-section-backends").wait_for(state="visible")
    page.evaluate("document.fonts.ready")


def switch_value(state: dict) -> bool | None:
    if not state:
        return None
    if state["checked"] is not None:
        return state["checked"]
    value = state["ariaChecked"]
    return None if value is None else value == "true"


def capture_central_state(
    page: Page,
    base: str,
    state_name: str,
    fixture_state: str,
    width: int,
    theme: str,
    output: Path,
    failures: list[dict],
) -> dict:
    """중앙 풀 구역과 그 로그인 상태를 820/390에서 잰다."""
    label = f"{state_name}-{width}-{theme}"
    page.goto(build_url(base, fixture_state, theme), wait_until="networkidle")
    wait_for_backends(page)
    # 고치기 전 코드에는 중앙 구역이 없다. 화면을 남기고 단언이 실패를 보고하게 둔다.
    if count(page.get_by_test_id("settings-section-central-pool")) == 0:
        failures.append({"check": "central section", "label": label})
        page.screenshot(path=str(output / f"app-central-{state_name}-{width}-{theme}-screen.png"))
        return {
            "state": state_name, "fixtureState": fixture_state, "width": width, "theme": theme,
            "capture": None, "screenCapture": f"app-central-{state_name}-{width}-{theme}-screen.png",
            "metrics": None,
        }
    page.get_by_test_id("settings-section-central-pool").wait_for(state="visible")
    if state_name == "central-loading":
        page.get_by_test_id("central-pool-loading").wait_for(state="visible")
    elif state_name == "central-error":
        page.get_by_text("계정 목록을 갱신하지 못했습니다.").wait_for(state="visible")
    else:
        page.get_by_test_id("claude-account-pool-section").wait_for(state="visible")
        if state_name != "central-empty":
            page.wait_for_function(
                'document.querySelectorAll(\'[data-testid^="claude-account-row-"]\').length === 3',
            )
    if state_name.startswith("central-login-"):
        page.get_by_test_id("claude-account-add").click()
        page.get_by_test_id("claude-login-flow").wait_for(state="visible")
        if state_name == "central-login-url-ready":
            page.get_by_test_id("claude-login-code").wait_for(state="visible")
            page.get_by_test_id("claude-login-open-auth").wait_for(state="visible")
    settle(page)
    metrics = page.evaluate(CENTRAL_METRICS_SCRIPT)

    central = metrics["central"]
    if central is None:
        failures.append({"check": "central section", "label": label})
    else:
        # 검수 표본은 SettingsWorkspaceContext를 주므로 SettingsSection이 구역 제목을 그리지 않는다.
        # 그래서 「중앙 풀」 머리는 풀 머리(목록)나 구역(로딩·실패)이 직접 그린다.
        title = metrics["centralTitle"]
        if title is None or title["rect"]["width"] <= 0 or title["rect"]["height"] <= 0:
            failures.append({"check": "central title", "label": label})
        elif state_name == "central-loading":
            if metrics["loadingRect"] and title["rect"]["top"] >= metrics["loadingRect"]["top"]:
                failures.append({"check": "central title above loading", "label": label,
                                 "title": title["rect"], "loading": metrics["loadingRect"]})
        elif state_name == "central-error":
            if metrics["centralErrorRect"] and title["rect"]["top"] >= metrics["centralErrorRect"]["top"]:
                failures.append({"check": "central title above error", "label": label,
                                 "title": title["rect"], "error": metrics["centralErrorRect"]})
        if metrics["backend"] is None:
            failures.append({"check": "backend section", "label": label})
        elif central["rect"]["bottom"] > metrics["backend"]["rect"]["top"] + 1:
            failures.append({"check": "central above picker", "label": label,
                             "centralBottom": central["rect"]["bottom"],
                             "backendTop": metrics["backend"]["rect"]["top"]})
    if metrics["document"]["scrollWidth"] > metrics["document"]["innerWidth"] + 1:
        failures.append({"check": "horizontal overflow", "label": label, "document": metrics["document"]})

    if state_name == "central-loading":
        if not metrics["loading"]:
            failures.append({"check": "central loading skeleton", "label": label})
    elif state_name == "central-error":
        if "계정 목록을 갱신하지 못했습니다." not in metrics["bodyText"]:
            failures.append({"check": "central error copy", "label": label})
        if not page.get_by_text("다시 시도").count():
            failures.append({"check": "central error retry", "label": label})
    else:
        expected_rows = 0 if state_name == "central-empty" else 3
        if metrics["rows"] != expected_rows:
            failures.append({"check": "central account rows", "label": label,
                             "expected": expected_rows, "actual": metrics["rows"]})
        if state_name != "central-empty":
            if LONG_CENTRAL_EMAIL not in metrics["bodyText"]:
                failures.append({"check": "long central email", "label": label})
            if not metrics["addButton"]:
                failures.append({"check": "central add button", "label": label})
    if state_name.startswith("central-login-"):
        login = metrics["login"]
        if login is None:
            failures.append({"check": "login panel", "label": label})
        elif state_name == "central-login-url-ready":
            if not (login["code"] and login["openAuth"] and login["cancel"] and login["submit"]):
                failures.append({"check": "login url_ready controls", "label": label, "login": login})
        elif state_name == "central-login-verifying":
            if "확인 중" not in login["text"] or not login["cancel"]:
                failures.append({"check": "login verifying state", "label": label, "login": login})
        elif state_name == "central-login-failed":
            if "오류" not in login["text"] or not login["openAuth"]:
                failures.append({"check": "login failed state", "label": label, "login": login})

    page.get_by_test_id("settings-section-central-pool").screenshot(
        path=str(output / f"app-central-{state_name}-{width}-{theme}.png"),
    )
    capture_full_screen(page, output, f"app-central-{state_name}-{width}-{theme}-screen.png")
    return {
        "state": state_name,
        "fixtureState": fixture_state,
        "width": width,
        "theme": theme,
        "capture": f"app-central-{state_name}-{width}-{theme}.png",
        "screenCapture": f"app-central-{state_name}-{width}-{theme}-screen.png",
        "metrics": metrics,
    }


def capture_receive_state(
    page: Page,
    base: str,
    state_name: str,
    fixture_state: str,
    width: int,
    theme: str,
    output: Path,
    failures: list[dict],
) -> dict:
    """노드 클로드 목록 맨 위의 「중앙 풀 받기」 줄을 820/390에서 잰다."""
    label = f"{state_name}-{width}-{theme}"
    page.goto(build_url(base, fixture_state, theme), wait_until="networkidle")
    wait_for_backends(page)
    page.get_by_test_id("claude-provider-toggle").click()
    page.get_by_test_id("claude-account-pool-section").wait_for(state="visible")
    # 고치기 전 코드에는 받기 줄이 없다. 화면을 남기고 단언이 실패를 보고하게 둔다.
    if count(page.get_by_test_id("claude-central-receive")) == 0:
        failures.append({"check": "receive row", "label": label})
        page.screenshot(path=str(output / f"app-receive-{state_name}-{width}-{theme}-screen.png"))
        return {
            "state": state_name, "fixtureState": fixture_state, "width": width, "theme": theme,
            "capture": None, "screenCapture": f"app-receive-{state_name}-{width}-{theme}-screen.png",
            "metrics": None,
        }
    page.get_by_test_id("claude-central-receive").wait_for(state="visible")
    if state_name == "receive-settings-error":
        page.get_by_test_id("claude-central-receive-retry").wait_for(state="visible")
    else:
        page.get_by_test_id("claude-central-receive-switch").wait_for(state="visible")
    if state_name == "receive-pending":
        page.get_by_test_id("claude-central-receive-switch").click()
        page.wait_for_function(
            """() => {
              const box = document.querySelector('[data-testid="claude-central-receive-switch"]');
              const toggle = box?.querySelector('input[role="switch"]') ?? box;
              if (!toggle) return false;
              const checked = typeof toggle.checked === 'boolean' ? toggle.checked : toggle.getAttribute('aria-checked') === 'true';
              const disabled = (typeof toggle.disabled === 'boolean' && toggle.disabled)
                || toggle.getAttribute('aria-disabled') === 'true';
              return checked === false && disabled;
            }""",
            timeout=5000,
        )
    elif state_name == "receive-failure":
        page.get_by_test_id("claude-central-receive-switch").click()
        page.get_by_text("계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.").wait_for(state="visible")
    settle(page)
    metrics = page.evaluate(CENTRAL_METRICS_SCRIPT)

    receive = metrics["receive"]
    if receive is None:
        failures.append({"check": "receive row", "label": label})
    else:
        # 설정을 못 읽어도 「중앙 풀 받기」 이름은 남는다. 스위치 자리만 다시 시도로 바뀐다.
        if "중앙 풀 받기" not in receive["text"]:
            failures.append({"check": "receive label", "label": label, "actual": receive["text"][:120]})
        if metrics["rows"] > 0 and not metrics["receiveFirst"]:
            failures.append({"check": "receive first row", "label": label,
                             "receive": receive["rect"], "rows": metrics["rowTexts"][:2]})
        if not metrics["receiveInPool"]:
            failures.append({"check": "receive in pool", "label": label})
    if metrics["document"]["scrollWidth"] > metrics["document"]["innerWidth"] + 1:
        failures.append({"check": "horizontal overflow", "label": label, "document": metrics["document"]})

    if state_name == "receive-settings-error":
        if metrics["switch"] is not None:
            failures.append({"check": "settings error hides switch", "label": label})
        if not metrics["receiveRetry"]:
            failures.append({"check": "settings error retry", "label": label})
        if "받기 설정을 불러오지 못했습니다." not in metrics["bodyText"]:
            failures.append({"check": "settings error copy", "label": label})
        if "계정 목록을 갱신하지 못했습니다." in metrics["bodyText"]:
            failures.append({"check": "settings error borrowed copy", "label": label})
    elif state_name == "receive-on":
        if switch_value(metrics["switch"]) is not True:
            failures.append({"check": "receive on value", "label": label, "switch": metrics["switch"]})
        if metrics["rows"] != 0:
            failures.append({"check": "receive on hides central rows", "label": label, "rows": metrics["rows"]})
    elif state_name == "receive-off":
        if switch_value(metrics["switch"]) is not False:
            failures.append({"check": "receive off value", "label": label, "switch": metrics["switch"]})
        if metrics["rows"] != 2:
            failures.append({"check": "receive off local rows", "label": label, "rows": metrics["rows"]})
    elif state_name == "receive-pending":
        if switch_value(metrics["switch"]) is not False:
            failures.append({"check": "receive pending value", "label": label, "switch": metrics["switch"]})
        if not (metrics["switch"] or {}).get("disabled") and (metrics["switch"] or {}).get("ariaDisabled") != "true":
            failures.append({"check": "receive pending disabled", "label": label, "switch": metrics["switch"]})
    elif state_name == "receive-failure":
        # 저장에 실패해도 스위치는 제자리에서 되돌아간 값을 보이며 눌린다. 다시 시도는 그 스위치를 다시 누르는 것이다.
        if metrics["switch"] is None:
            failures.append({"check": "receive failure switch kept", "label": label})
        elif switch_value(metrics["switch"]) is not True:
            failures.append({"check": "receive failure revert", "label": label, "switch": metrics["switch"]})
        if metrics["switch"] and ((metrics["switch"].get("disabled") is True)
                                  or metrics["switch"].get("ariaDisabled") == "true"):
            failures.append({"check": "receive failure switch enabled", "label": label, "switch": metrics["switch"]})
        if metrics["receiveError"] != "계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.":
            failures.append({"check": "receive failure copy", "label": label, "error": metrics["receiveError"]})
        if metrics["receiveRetry"]:
            failures.append({"check": "receive failure no retry button", "label": label})
        if not metrics["receiveErrorBelowSwitch"]:
            failures.append({"check": "receive failure error below", "label": label})

    page.get_by_test_id("claude-account-pool-section").screenshot(
        path=str(output / f"app-receive-{state_name}-{width}-{theme}.png"),
    )
    capture_full_screen(page, output, f"app-receive-{state_name}-{width}-{theme}-screen.png")
    return {
        "state": state_name,
        "fixtureState": fixture_state,
        "width": width,
        "theme": theme,
        "capture": f"app-receive-{state_name}-{width}-{theme}.png",
        "screenCapture": f"app-receive-{state_name}-{width}-{theme}-screen.png",
        "metrics": metrics,
    }


def count(locator: Locator) -> int:
    try:
        return locator.count()
    except Exception:
        return 0


def assert_text(page: Page, selector: str, expected: str, failures: list[dict], label: str) -> None:
    locator = page.locator(f'[data-testid="{selector}"]')
    if count(locator) == 0:
        failures.append({"check": "missing testID", "label": label, "testID": selector})
        return
    text = locator.first.inner_text()
    if expected not in text:
        failures.append({"check": "text", "label": label, "testID": selector, "expected": expected, "actual": text})


def wait_for_panel(page: Page) -> None:
    page.get_by_test_id("provider-panel").wait_for(state="visible")
    page.evaluate("document.fonts.ready")


def settle(page: Page) -> None:
    page.wait_for_timeout(250)


def reset_inner_scroll(page: Page) -> None:
    """Return the review page's inner ScrollView to the top before a full capture."""
    page.evaluate("""
    () => {
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll')
          && element.scrollHeight > element.clientHeight) {
          element.scrollTop = 0;
        }
      }
    }
    """)
    page.wait_for_timeout(50)


def capture_full_screen(page: Page, output: Path, name: str) -> None:
    reset_inner_scroll(page)
    root = page.locator('[data-testid="settings-section-backends"]')
    if count(root) > 0:
        root.screenshot(path=str(output / name))
    else:
        page.screenshot(path=str(output / name))


def capture_state(
    page: Page,
    base: str,
    state_name: str,
    fixture_state: str,
    expanded: bool,
    width: int,
    theme: str,
    output: Path,
    failures: list[dict],
    page_errors: list[str],
) -> dict:
    label = f"{state_name}-{width}-{theme}"
    page.goto(build_url(base, fixture_state, theme), wait_until="networkidle")
    wait_for_panel(page)
    if state_name == "loading":
        page.get_by_test_id("claude-gauge-loading").wait_for(state="visible")
    else:
        page.get_by_test_id("provider-row-claude").wait_for(state="visible")
        page.get_by_test_id("provider-panel-updated").wait_for(state="visible")
    if expanded:
        page.get_by_test_id("claude-provider-toggle").click()
        page.get_by_test_id("claude-account-pool-section").wait_for(state="visible")
        page.wait_for_function(
            "document.querySelectorAll('[data-testid^=\"claude-account-row-\"]').length === 3",
        )
    settle(page)

    if state_name == "default":
        page.get_by_test_id("provider-row-opencode_go").wait_for()
        page.get_by_test_id("provider-row-codex").wait_for()
        page.get_by_test_id("provider-row-antigravity").wait_for()
        assert_text(page, "claude-provider-header", "2/3 가용", failures, label)
        assert_text(page, "claude-provider-header", "계정 3", failures, label)
        assert_text(page, "provider-quota-opencode_go-2", "월간", failures, label)
        monthly = page.get_by_test_id("provider-quota-opencode_go-2")
        if count(monthly) == 0 or not re.search(r"\d{1,2}/\d{1,2}", monthly.first.inner_text()):
            failures.append({"check": "monthly reset date", "label": label,
                             "actual": monthly.first.inner_text() if count(monthly) else None})
        assert_text(page, "provider-quota-codex-1", "7일", failures, label)
        if count(page.get_by_test_id("provider-quota-codex-bar-0")) != 0:
            failures.append({"check": "codex first cell blank", "label": label})
        if count(page.get_by_test_id("provider-quota-codex-bar-1")) == 0:
            failures.append({"check": "codex weekly bar", "label": label})
    if state_name == "pool-expanded":
        if count(page.locator('[data-testid^="claude-account-row-"]')) != 3:
            failures.append({"check": "pool account rows", "label": label,
                             "actual": count(page.locator('[data-testid^="claude-account-row-"]'))})
        if count(page.get_by_test_id("claude-account-add")) != 1:
            failures.append({"check": "pool add button", "label": label})
        if count(page.get_by_test_id("provider-quota-claude-0")) != 0:
            failures.append({"check": "collapsed Claude gauge hidden while expanded", "label": label})
        assert_text(page, "claude-provider-header", "2/3 가용", failures, label)
        header = page.get_by_test_id("claude-provider-header").first.inner_text()
        if "계정 3" in header or "주간 최대 잔여" in header:
            failures.append({"check": "expanded header summary", "label": label, "actual": header})
    if state_name == "legacy-stale":
        page.get_by_test_id("provider-row-opencode_go").wait_for()
        page.get_by_test_id("provider-row-antigravity").wait_for()
        page.get_by_test_id("claude-login-action").wait_for()
        assert_text(page, "provider-row-opencode_go", "미설정", failures, label)
        assert_text(page, "provider-row-antigravity", "조회 오류", failures, label)
        assert_text(page, "provider-panel-updated", "수집 지연", failures, label)
    if state_name == "codex-both":
        page.get_by_test_id("provider-quota-codex-0").wait_for()
        if count(page.get_by_test_id("provider-quota-codex-bar-0")) == 0:
            failures.append({"check": "codex short bar", "label": label})
        if count(page.get_by_test_id("provider-quota-codex-bar-1")) == 0:
            failures.append({"check": "codex weekly bar", "label": label})

    panel = page.get_by_test_id("provider-panel").first
    panel.screenshot(path=str(output / f"provider-panel-{state_name}-{width}-{theme}.png"))
    capture_full_screen(page, output, f"provider-panel-{state_name}-{width}-{theme}-screen.png")
    metrics = page.evaluate(METRICS_SCRIPT)
    grid_failures = alignment_failures(metrics, label)
    failures.extend(grid_failures)
    return {
        "state": state_name,
        "fixtureState": fixture_state,
        "width": width,
        "theme": theme,
        "expanded": expanded,
        "capture": f"provider-panel-{state_name}-{width}-{theme}.png",
        "screenCapture": f"provider-panel-{state_name}-{width}-{theme}-screen.png",
        "panel": metrics["panel"],
        "providerRows": metrics["providerRows"],
        "accountRows": metrics["accountRows"],
        "circleButtons": metrics["circleButtons"],
        "text": metrics["text"],
        "alignmentFailures": grid_failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Provider panel visual check")
    parser.add_argument("base_url", help="review bundle URL, e.g. http://127.0.0.1:4173/assets/ios-components/index.html")
    parser.add_argument("output", help="directory for captures and metrics JSON")
    parser.add_argument("--width", type=int, choices=(820, 390), help="한 폭만 잰다.")
    parser.add_argument("--theme", choices=("light", "dark"), help="한 테마만 잰다.")
    parser.add_argument(
        "--scenes", choices=("all", "provider", "central"), default="all",
        help="provider는 지금의 공급자 장면만, central은 중앙 풀·받기 장면만 잰다.",
    )
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "baseUrl": args.base_url,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False,
        "states": [],
        "loadingFrames": [],
        "centralStates": [],
        "receiveStates": [],
        "failures": [],
        "pageErrors": [],
        "consoleErrors": [],
    }
    failures: list[dict] = result["failures"]
    page_errors: list[str] = result["pageErrors"]
    console_errors: list[str] = result["consoleErrors"]
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
                if args.width not in (None, width):
                    continue
                for theme in THEMES:
                    if args.theme not in (None, theme):
                        continue
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        color_scheme=theme,
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.set_default_timeout(15000)
                    page.on("pageerror", lambda error, label=f"{width}-{theme}": page_errors.append(f"{label}: {error}"))
                    page.on("console", lambda message, label=f"{width}-{theme}": (
                        console_errors.append(f"{label} console: {message.text}")
                        if message.type == "error" else None
                    ))
                    context.route("**/*", route_request)
                    try:
                        if args.scenes in ("all", "provider"):
                            for state_name, fixture_state, expanded in STATES:
                                result["states"].append(capture_state(
                                    page, args.base_url, state_name, fixture_state, expanded,
                                    width, theme, output, failures, page_errors,
                                ))
                        if args.scenes in ("all", "central"):
                            for state_name, fixture_state in CENTRAL_STATES:
                                result["centralStates"].append(capture_central_state(
                                    page, args.base_url, state_name, fixture_state,
                                    width, theme, output, failures,
                                ))
                            for state_name, fixture_state in RECEIVE_STATES:
                                result["receiveStates"].append(capture_receive_state(
                                    page, args.base_url, state_name, fixture_state,
                                    width, theme, output, failures,
                                ))
                            if args.scenes == "central":
                                continue
                        # One deliberately delayed summary frame: the fixture never
                        # resolves getUsageSummary, so Claude shows its loading
                        # indicator while the other provider rows are absent.
                        loading_label = f"loading-{width}-{theme}"
                        page.goto(build_url(args.base_url, "loading", theme), wait_until="networkidle")
                        wait_for_panel(page)
                        page.get_by_test_id("claude-gauge-loading").wait_for(state="visible")
                        settle(page)
                        page.get_by_test_id("provider-panel").first.screenshot(
                            path=str(output / f"provider-panel-loading-{width}-{theme}.png"),
                        )
                        capture_full_screen(page, output, f"provider-panel-loading-{width}-{theme}-screen.png")
                        if count(page.get_by_test_id("claude-provider-loading")) != 0:
                            failures.append({"check": "duplicate header spinner", "label": loading_label})
                        metrics = page.evaluate(METRICS_SCRIPT)
                        grid_failures = alignment_failures(metrics, loading_label)
                        failures.extend(grid_failures)
                        result["loadingFrames"].append({
                            "state": "loading",
                            "width": width,
                            "theme": theme,
                            "capture": f"provider-panel-loading-{width}-{theme}.png",
                            "screenCapture": f"provider-panel-loading-{width}-{theme}-screen.png",
                            "panel": metrics["panel"],
                            "providerRows": metrics["providerRows"],
                            "circleButtons": metrics["circleButtons"],
                            "text": metrics["text"],
                            "skeleton": metrics["skeleton"],
                            "alignmentFailures": grid_failures,
                        })
                    finally:
                        context.close()
        finally:
            browser.close()

    # The loading frame is requested once; keep the first wide frame as the
    # named evidence path but do not hide the narrow frame.
    result["passed"] = not failures and not page_errors
    metrics_path = output / "provider-panel-metrics.json"
    metrics_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"provider panel visual check: {'PASS' if result['passed'] else 'FAIL'}")
    print(f"metrics: {metrics_path}")
    print(f"captures: {len(result['states'])} state frames, {len(result['loadingFrames'])} loading frames")
    if failures:
        print(f"failures: {json.dumps(failures, ensure_ascii=False, indent=2)}")
    if page_errors:
        print(f"page errors: {json.dumps(page_errors, ensure_ascii=False, indent=2)}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

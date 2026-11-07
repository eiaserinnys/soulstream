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
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "baseUrl": args.base_url,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False,
        "states": [],
        "loadingFrames": [],
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
                for theme in THEMES:
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
                        for state_name, fixture_state, expanded in STATES:
                            result["states"].append(capture_state(
                                page, args.base_url, state_name, fixture_state, expanded,
                                width, theme, output, failures, page_errors,
                            ))
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

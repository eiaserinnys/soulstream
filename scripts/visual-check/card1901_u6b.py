#!/usr/bin/env python3
"""Capture card #1901 unit 6b wording (session 턴 종료, 프로젝트 대 폴더) from the dashboard's real components.

Serve unified-dashboard with Vite (VITE_API_BASE required) from the build to capture, then run, once per build:
  python3 scripts/visual-check/card1901_u6b.py http://127.0.0.1:5193 before .local/card1901-u6b/shots
  python3 scripts/visual-check/card1901_u6b.py http://127.0.0.1:5192 after .local/card1901-u6b/shots
Each capture writes <phase>-<name>-<width>.png and .json, and the run writes <phase>-summary.json.
A capture passes when its probes see the phase's wording (and not the other phase's), nothing overflows
horizontally, and the page raises no error. Exit code is non-zero when any capture fails.
"""
import argparse
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

WIDTHS = (1440, 360)
WORD = {"after": "폴더", "before": "프로젝트"}
ROW_AGENT = '[data-testid="v3-session-row-s-agent"]'
ROW_LLM = '[data-testid="v3-session-row-s-llm"]'
FRAME = '[data-testid="review-frame"]'
STATUS = ".v3-chat-status"


def probe(selector, after_has=(), after_not=(), before_has=(), before_not=()):
    return {"selector": selector, "after": {"has": list(after_has), "not": list(after_not)},
            "before": {"has": list(before_has), "not": list(before_not)}}


def tabs(after, before):
    return {"tabs": {"after": after, "before": before}}


def captures_for(scene: str, width: int):
    wide = width >= 768
    if scene == "a":
        return [("running-card-session-list", [
            probe(ROW_AGENT, ["세션 턴 종료"], ["세션 완료"], ["세션 완료"], ["턴 종료"]),
            probe(ROW_LLM, ["세션 완료"], ["턴 종료"], ["세션 완료"], ["턴 종료"]),
            probe(f"{ROW_AGENT} .v3-run-row[data-has-actions]", [], [], [], []),
            probe(f"{ROW_LLM} .v3-run-row[data-has-actions]", [], [], [], []),
        ], None)]
    if scene == "b":
        return [("completed-chat-header", [
            probe(f'[data-testid="header-claude"] {STATUS}', ["턴 종료"], ["완료"], ["완료"], ["턴 종료"]),
            probe(f'[data-testid="header-llm"] {STATUS}', ["완료"], ["턴 종료"], ["완료"], ["턴 종료"]),
        ], None)]
    if scene == "c" and wide:
        return [("sidebar-folders", [
            probe(FRAME, ["전체 폴더", "폴더가 없습니다."], ["프로젝트"], ["전체 프로젝트", "프로젝트가 없습니다."], ["전체 폴더"]),
        ], None)]
    if scene == "c":
        return [("mobile-planner-tabs", [
            probe(FRAME, ["전체 폴더"], ["프로젝트"], ["전체 프로젝트"], ["전체 폴더"]),
            probe('section[aria-label="{folder} 목록"]', [], [], [], []),
            tabs(["카드", "전체 폴더", "폴더", "채팅"], ["카드", "프로젝트", "폴더", "채팅"]),
        ], None)]
    return [("usage-folder-picker", [
        probe('button[role="combobox"][aria-label="{folder}"]', ["모든 폴더"], ["프로젝트"], ["모든 프로젝트"], ["모든 폴더"]),
    ], "picker"), ("usage-by-folder", [
        probe('.usage-stats-chart[aria-label="{folder}별 사용량"]', [], [], [], []),
    ], "chart")]


def evaluate(page: Page, probes, phase: str) -> list:
    results = []
    for item in probes:
        if "tabs" in item:
            texts = page.evaluate("""() => [...document.querySelectorAll('[role=tab]')].map(e => e.textContent.trim().replace(/^\\S+\\s+/, ''))""")
            clipped = page.evaluate("""() => [...document.querySelectorAll('[role=tab]')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim())""")
            want = item["tabs"][phase]
            results.append({"probe": "tabs", "found": texts, "want": want, "clipped": clipped, "ok": texts == want and not clipped})
            continue
        selector = item["selector"].replace("{folder}", "폴더" if phase == "after" else "프로젝트")
        spec = item[phase]
        found = page.evaluate("""(sel) => { const el = document.querySelector(sel);
          return el ? (el.innerText || el.getAttribute('aria-label') || '') : null }""", selector)
        if found is None:
            results.append({"probe": selector, "ok": False, "failure": "selector not found"})
            continue
        missing = [t for t in spec["has"] if t not in found]
        present = [t for t in spec["not"] if t in found]
        results.append({"probe": selector, "text": found, "missing": missing, "unexpected": present, "ok": not missing and not present})
    return results


def drive(page: Page, step, phase: str) -> None:
    folder = WORD[phase]
    by_folder = f"{folder}별"
    page.get_by_role("combobox", name=folder, exact=True).wait_for(timeout=8000)
    if step == "picker":
        page.get_by_role("combobox", name=folder, exact=True).click()
        page.get_by_role("option").first.wait_for(timeout=4000)
    elif step == "chart":
        page.get_by_role("combobox", name="그래프 보기", exact=True).click()
        page.get_by_role("option", name=by_folder, exact=True).click()
        page.locator(f'.usage-stats-chart[aria-label="{by_folder} 사용량"]').wait_for(timeout=4000)
    page.wait_for_timeout(300)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("phase", choices=("before", "after"))
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    summary, failed = [], False
    with sync_playwright() as playwright:
        shells = sorted(Path.home().glob(".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))
        browser = playwright.chromium.launch(executable_path=str(shells[-1])) if shells else playwright.chromium.launch()
        for width in WIDTHS:
            for scene in "abcd":
                for name, probes, step in captures_for(scene, width):
                    page = browser.new_page(viewport={"width": width, "height": 900}, reduced_motion="reduce")
                    page.route("**/api/**", lambda route: route.fulfill(json={}))
                    errors: list = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    try:
                        page.goto(f"{args.base}/scripts/visual-check/card1901_u6b.html?scene={scene}", wait_until="networkidle", timeout=30000)
                        page.locator(FRAME).wait_for(state="attached", timeout=8000)
                        if scene == "d":
                            drive(page, step, args.phase)
                        page.evaluate("document.fonts.ready")
                        page.wait_for_timeout(400)
                        probe_results = evaluate(page, probes, args.phase)
                        metrics = page.evaluate("""() => ({
                            viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
                            clippedLabels: [...document.querySelectorAll('.v3-status-label, [role=tab], .v3-chat-status')]
                              .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()),
                            rowOverflow: [...document.querySelectorAll('.v3-run-row')].filter(row => {
                              const right = row.getBoundingClientRect().right + 1;
                              return [...row.querySelectorAll('*')].some(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > right);
                            }).map(row => row.querySelector('strong')?.textContent.trim() ?? ''),
                        })""")
                        page.screenshot(path=str(args.output / f"{args.phase}-{name}-{width}.png"), animations="disabled")
                        overflow = metrics["scrollWidth"] > metrics["viewport"] + 1
                        result = {"scene": scene, "name": name, "phase": args.phase, "width": width, **metrics,
                                  "horizontalOverflow": overflow, "probes": probe_results, "errors": errors,
                                  "pass": all(item["ok"] for item in probe_results) and not overflow and not metrics["clippedLabels"] and not metrics["rowOverflow"] and not errors}
                    except Exception as error:  # noqa: BLE001
                        result = {"scene": scene, "name": name, "phase": args.phase, "width": width, "failure": str(error), "errors": errors, "pass": False}
                    finally:
                        page.close()
                    (args.output / f"{args.phase}-{name}-{width}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(json.dumps({k: result.get(k) for k in ("name", "width", "pass", "horizontalOverflow", "failure")}, ensure_ascii=False), flush=True)
                    summary.append({k: result.get(k) for k in ("name", "width", "pass", "horizontalOverflow")})
                    failed = failed or not result["pass"]
        browser.close()
    (args.output / f"{args.phase}-summary.json").write_text(json.dumps({"phase": args.phase, "failed": failed, "captures": summary}, ensure_ascii=False, indent=2), encoding="utf-8")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())

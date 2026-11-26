#!/usr/bin/env python3
"""Capture card #1901 unit 6a labels from the dashboard's real components at 1440 and 360.

Run a dashboard Vite server (VITE_API_BASE required), then:
  python3 unified-dashboard/scripts/visual-check/card1901.py http://127.0.0.1:5191 before .local/card1901-u6a/shots
  python3 unified-dashboard/scripts/visual-check/card1901.py http://127.0.0.1:5191 after .local/card1901-u6a/shots
Each scene writes <phase>-<scene>-<width>.png and <phase>-<scene>-<width>.json. Exit code is non-zero when a scene
of the after phase lacks its expected text, overflows horizontally, or raises a page error.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

SCENES = {
    "a": {"name": "folder-picker-no-stars", "before": "일치하는 폴더가 없습니다.", "after": None},
    "b": {"name": "awaiting-verification-menu", "before": None,
          "after": "지금 상태는 검증 대기입니다. 담당이 정한 시각에 다시 확인하며, 아래에서 다른 상태로 바꿀 수 있습니다."},
    "c": {"name": "running-chip", "before": "카드 진행 중", "after": "카드 실행 중"},
    "d": {"name": "empty-session-panel", "before": "위임 관계에서 세션을 선택하세요.", "after": "아직 시작된 세션이 없습니다."},
    "e": {"name": "error-session-body", "before": "대화를 기다리는 중", "after": "세션이 오류로 끝나 남은 대화가 없습니다."},
}
WIDTHS = (1440, 360)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("phase", choices=("before", "after"))
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    failed = False
    with sync_playwright() as playwright:
        shell = sorted(Path.home().glob(".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))[-1]
        browser = playwright.chromium.launch(executable_path=str(shell))
        for width in WIDTHS:
            for key, scene in SCENES.items():
                page = browser.new_page(viewport={"width": width, "height": 900}, reduced_motion="reduce")
                page.route("**/api/**", lambda route: route.fulfill(json={}))
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                try:
                    page.goto(f"{args.base}/scripts/visual-check/card1901.html?scene={key}", wait_until="networkidle", timeout=30000)
                    page.locator('[data-testid="review-frame"]').wait_for(state="attached", timeout=8000)
                    if key == "b":
                        page.locator('[data-slot="popover-trigger"]').click()
                        page.locator("[data-card-status-picker]").wait_for(timeout=4000)
                        page.wait_for_timeout(300)
                    if key == "d":
                        page.locator('[data-testid="v3-card-session-chat"]').wait_for(timeout=8000)
                    page.evaluate("document.fonts.ready")
                    page.wait_for_timeout(300)
                    checks = page.evaluate("""(texts) => {
                      const body = document.body.innerText;
                      const tab = [...document.querySelectorAll('[role=tab][aria-selected=true]')].map(e => e.textContent);
                      return {
                        text: Object.fromEntries(Object.entries(texts).filter(([, t]) => t).map(([k, t]) => [k, body.includes(t)])),
                        selectedTabs: tab,
                        treeRows: document.querySelectorAll('[role=treeitem]').length,
                        viewport: document.documentElement.clientWidth,
                        scrollWidth: document.documentElement.scrollWidth,
                      };
                    }""", {"before": scene["before"], "after": scene["after"]})
                    checks["horizontalOverflow"] = checks["scrollWidth"] > checks["viewport"] + 1
                    page.screenshot(path=str(args.output / f"{args.phase}-{scene['name']}-{width}.png"), animations="disabled")
                    result = {"scene": key, "name": scene["name"], "phase": args.phase, "width": width, **checks, "errors": errors}
                    if key == "a":
                        result["expectedAfter"] = checks["selectedTabs"] == ["전체"] and checks["treeRows"] > 0
                        result["expectedBefore"] = checks["text"].get("before", False)
                    else:
                        result["expectedAfter"] = checks["text"].get("after", False)
                        result["expectedBefore"] = checks["text"].get("before", False) if scene["before"] else None
                except Exception as error:
                    result = {"scene": key, "name": scene["name"], "phase": args.phase, "width": width, "failure": str(error), "errors": errors}
                finally:
                    page.close()
                (args.output / f"{args.phase}-{scene['name']}-{width}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps(result, ensure_ascii=False), flush=True)
                wanted = result.get("expectedAfter") if args.phase == "after" else result.get("expectedBefore") if scene["before"] or key == "a" else True
                if result.get("failure") or result["errors"] or result.get("horizontalOverflow") or not wanted:
                    failed = True
        browser.close()
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Capture the dashboard's real chat components at wide and narrow widths.

Run a dashboard Vite server, then:
  PYTHONPATH=.local/card1685/python python3.11 -P unified-dashboard/scripts/visual-check/card1685.py http://127.0.0.1:5178 .local/card1685/before
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

SCENES = ("toolbar", "named", "fallback", "llm", "empty", "waiting", "attention", "approval-banner", "question-banner", "cards", "context", "runtime", "input-error")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("output", type=Path)
    parser.add_argument("--scene", action="append", choices=SCENES)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = []
    with sync_playwright() as playwright:
        shell = sorted(Path.home().glob('.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
        browser = playwright.chromium.launch(executable_path=str(shell))
        for width in (1440, 360):
            for scene in args.scene or SCENES:
                page = browser.new_page(viewport={"width": width, "height": 1000}, reduced_motion="reduce")
                page.route("**/api/**", lambda route: route.fulfill(json={"schedules": [], "tasks": []}))
                page.route("**/api/persistent-sessions", lambda route: route.fulfill(json={"sessions": [], "create_defaults": {}}))
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                try:
                    page.goto(f"{args.base}/scripts/visual-check/card1685.html?scene={scene}", wait_until="networkidle", timeout=30000)
                    page.locator('[data-testid="review-frame"]').wait_for(state="attached", timeout=4000)
                    if scene == "runtime":
                        page.evaluate("document.querySelectorAll('section > div > button[aria-expanded=\"false\"]').forEach(button => button.click())")
                    if scene == "input-error":
                        page.locator("textarea").fill("가" * 50001)
                        page.locator('[data-testid="send-button"]').click()
                        page.locator('[role="alert"]').wait_for()
                    page.evaluate("document.fonts.ready")
                    page.screenshot(path=str(args.output / f"{scene}-{width}.png"), full_page=True, animations="disabled")
                    metrics = page.evaluate("""() => ({ viewport: document.documentElement.clientWidth,
                      scroll: document.documentElement.scrollWidth,
                      outside: [...document.querySelectorAll('button')].filter(e => {
                        const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1);
                      }).map(e => ({text: e.innerText, label: e.getAttribute('aria-label')})),
                      overlaps: [...document.querySelectorAll('button')].flatMap(a =>
                        [...(a.parentElement?.querySelectorAll(':scope > button') || [])].filter(b => {
                          if (a === b || !(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
                          const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
                          return x.width && x.height && y.width && y.height && Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1;
                        }).map(b => [a.innerText || a.getAttribute('aria-label'), b.innerText || b.getAttribute('aria-label')])),
                      wrappedHeaders: [...document.querySelectorAll('section > div > button > span')].filter(e => {
                        const line = parseFloat(getComputedStyle(e).lineHeight), rect = e.getBoundingClientRect();
                        return line && rect.height > line * 1.5;
                      }).map(e => e.innerText) })""")
                    report.append({"scene": scene, "width": width, **metrics, "errors": errors})
                    print(scene, width, metrics, errors, flush=True)
                except Exception as error:
                    report.append({"scene": scene, "width": width, "failure": str(error), "errors": errors})
                    print(scene, width, error, errors, flush=True)
                finally:
                    page.close()
        browser.close()
    report_name = "measurements.json" if not args.scene else "measurements-" + "-".join(args.scene) + ".json"
    (args.output / report_name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return int(any(entry.get("failure") or entry["errors"] or entry.get("scroll", 0) > entry.get("viewport", 0) + 1 or entry.get("outside") or entry.get("overlaps") or entry.get("wrappedHeaders") for entry in report))


if __name__ == "__main__":
    raise SystemExit(main())

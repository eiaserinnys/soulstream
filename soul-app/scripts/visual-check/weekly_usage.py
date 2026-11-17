#!/usr/bin/env python3
"""Capture the PAS usage-parts review bundle at wide and narrow viewports.

Run `npm --prefix soul-app run export:components`, serve unified-dashboard/dist,
then run this script with the bundle URL and an output directory.
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url")
    parser.add_argument("output_dir")
    args = parser.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width, height in ((1280, 1000), (360, 844)):
                page = browser.new_page(viewport={"width": width, "height": height}, reduced_motion="reduce")
                page.route("**/api/auth/status", lambda route: route.fulfill(json={"authenticated": True}))
                page.goto(f"{args.base_url}?section=persistent&sample=usage-parts&theme=light")
                page.get_by_test_id("weekly-usage-review-sample").wait_for(state="visible")
                page.evaluate("() => document.fonts.ready")
                page.screenshot(path=str(out / f"app-pas-{width}.png"), animations="disabled")
                print(f"app-pas-{width}: {page.get_by_test_id('persistent-session-weekly-usage').count()} gauges")
                page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()

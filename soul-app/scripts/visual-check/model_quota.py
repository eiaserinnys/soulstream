#!/usr/bin/env python3
"""Capture the exhausted-model labels at 390 and 360 widths (card #1901 unit 3B).

Run `npm --prefix soul-app run export:components`, serve the export under
/assets/ios-components, then run this script with the bundle URL, an output
directory, a file prefix (before/after) and the JSON written from
buildModelPresetActionSheet. ActionSheetIOS has no web renderer, so scene (a)
draws that JSON as a stand-in list; scene (b) mounts the real components.
"""
import argparse
import html
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

WIDTHS = (390, 360)
SCENES_B = (
    ("b-direct-row", "section=dialogues&sample=assignment&exhausted=direct", "맡길 대상"),
    ("b-auto-row", "section=dialogues&sample=assignment&exhausted=auto", "맡길 대상"),
    ("b-direct-long-row", "section=dialogues&sample=assignment&exhausted=direct-long", "맡길 대상"),
    ("b-auto-long-row", "section=dialogues&sample=assignment&exhausted=auto-long", "맡길 대상"),
    ("b-direct-chip", "section=entryShell&chips=long", "card-execution-chip"),
    ("c-execution-meta", "section=dialogues&sample=execution-picker&exhausted=direct-long", "execution-models"),
)
CLAMPED_TEXT = """() => [...document.querySelectorAll('div,span')]
  .filter(el => getComputedStyle(el).webkitLineClamp !== 'none' && /사용량 제한/.test(el.textContent || ''))
  .filter(el => ![...el.children].some(child => getComputedStyle(child).webkitLineClamp !== 'none' && /사용량 제한/.test(child.textContent || '')))
  .map(el => ({ text: el.textContent, lines: getComputedStyle(el).webkitLineClamp, truncated: el.scrollHeight > el.clientHeight + 1 }))"""


def action_sheet_html(sheet: dict, width: int) -> str:
    rows = []
    for index, text in enumerate(sheet["options"]):
        if index == sheet["cancelButtonIndex"]:
            continue
        color = "#ff3b30" if index in sheet["destructiveButtonIndex"] else "#007aff"
        if index in sheet["disabledButtonIndices"]:
            color = "#9a9aa0"
        rows.append(f'<div class="row" style="color:{color}">{html.escape(text)}</div>')
    cancel = html.escape(sheet["options"][sheet["cancelButtonIndex"]])
    return f"""<body style="margin:0;background:#cfd0d4;font:17px -apple-system,Helvetica,sans-serif">
<style>.group{{background:#f7f7f7;border-radius:14px;overflow:hidden}}
.row{{padding:15px 16px;text-align:center;border-top:1px solid #d6d6d8}}
.title{{padding:14px 16px;text-align:center;font-size:13px;color:#8a8a8e}}</style>
<div style="width:{width - 16}px;margin:0 8px;padding-top:24px">
<div style="font-size:11px;color:#555;margin-bottom:8px">iOS ActionSheet stand-in (real option strings)</div>
<div class="group"><div class="title">{html.escape(sheet.get("title", ""))}</div>{"".join(rows)}</div>
<div class="group" style="margin-top:8px"><div class="row" style="color:#007aff;font-weight:600;border-top:0">{cancel}</div></div></div></body>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url")
    parser.add_argument("output_dir")
    parser.add_argument("prefix")
    parser.add_argument("options_json")
    args = parser.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    sheet = json.loads(Path(args.options_json).read_text(encoding="utf-8"))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in WIDTHS:
                page = browser.new_page(viewport={"width": width, "height": 640}, reduced_motion="reduce")
                page.set_content(action_sheet_html(sheet, width))
                page.screenshot(path=str(out / f"{args.prefix}-a-model-list-{width}.png"))
                page.close()
                for name, query, test_id in SCENES_B:
                    page = browser.new_page(viewport={"width": width, "height": 844}, reduced_motion="reduce")
                    page.route("**/api/auth/status", lambda route: route.fulfill(json={"authenticated": True}))
                    page.goto(f"{args.base_url}?{query}&theme=light")
                    ready = page.get_by_test_id(test_id) if test_id.startswith(("card-", "execution-")) else page.get_by_text(test_id, exact=True)
                    ready.first.wait_for(state="visible", timeout=15000)
                    if test_id.startswith("execution-"):
                        ready.first.scroll_into_view_if_needed()
                    page.evaluate("() => document.fonts.ready")
                    page.wait_for_timeout(800)
                    page.screenshot(path=str(out / f"{args.prefix}-{name}-{width}.png"), animations="disabled")
                    print(f"{args.prefix}-{name}-{width}: {json.dumps(page.evaluate(CLAMPED_TEXT), ensure_ascii=False)}")
                    page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()

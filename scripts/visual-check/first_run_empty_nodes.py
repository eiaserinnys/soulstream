#!/usr/bin/env python3
"""연결된 노드가 하나도 없는 첫 설치 화면 시각 검수 (카드 #1901 단위 2).

가짜 응답(settings_toolbar_fakes.Fake)으로 노드 0대를 내리고 아래 세 장면을 넓은 폭(1440)과
좁은 폭(360)으로 찍는다. 바꾸기 전 빌드는 --prefix before-, 바뀐 빌드는 --prefix after-로 찍는다.

  settings-nodes  설정창의 노드 화면
  home-picker     홈의 실행 조합 고르기
  pas-create      영구 세션 만들기 화면(기본 노드가 빈 값)

단언은 after- 빌드에서만 한다. 문구는 「연결된 노드가 없습니다」이고, 영구 세션 만들기는 빈 노드로
에이전트 목록(/api/nodes/<id>/agents)을 부르지 않으며, 360px에서 가로 넘침이 없다.

사용
  corepack pnpm -C unified-dashboard run build
  python3 -P scripts/visual-check/first_run_empty_nodes.py --dist unified-dashboard/dist --prefix after- --output <폴더>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from settings_toc import SERVER_CATEGORIES  # noqa: E402
from settings_toolbar_fakes import CHECKS, Fake, check, new_page, open_settings, serve  # noqa: E402

EMPTY_NODES_TEXT = "연결된 노드가 없습니다"
WIDTHS = (1440, 360)
HOME_PREFERENCES = {"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None}
OVERFLOW = "() => document.documentElement.scrollWidth <= window.innerWidth"


def open_page(browser, base, fake, width, path="/", preferences=None):
    context, page = new_page(browser, base, fake, width, preferences=preferences)
    page.route("**/api/config/settings", lambda route: route.fulfill(json=SERVER_CATEGORIES))
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={"items": [], "nextCursor": None}))
    page.goto(base + path, wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    page.wait_for_timeout(600)
    return context, page


def agent_list_calls(fake):
    return [path for _, path in fake.calls if path.startswith("/api/nodes/") and path.endswith("/agents")]


def settings_nodes(browser, base, out: Path, prefix: str, width: int, current: bool):
    fake = Fake(atom=True, nodes="none", defaults_node="")
    context, page = open_page(browser, base, fake, width, preferences=HOME_PREFERENCES)
    open_settings(page)
    page.get_by_role("button", name="노드", exact=True).click()
    page.wait_for_timeout(500)
    dialog = page.locator('[data-slot="dialog-popup"]')
    if current:
        check(f"설정 노드 화면 {width}px: 연결된 노드가 없다는 문구", EMPTY_NODES_TEXT in dialog.inner_text(), dialog.inner_text())
        check(f"설정 노드 화면 {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    dialog.screenshot(path=str(out / f"{prefix}settings-nodes-{width}.png"), animations="disabled")
    context.close()


def home_picker(browser, base, out: Path, prefix: str, width: int, current: bool):
    fake = Fake(atom=True, nodes="none", defaults_node="")
    context, page = open_page(browser, base, fake, width, preferences=HOME_PREFERENCES)
    page.get_by_role("button", name="실행 조합 선택").click()
    popup = page.locator(".v3-card-execution-picker")
    expect(popup).to_be_visible(timeout=10000)
    page.wait_for_timeout(400)
    if current:
        node_section = popup.locator('section[aria-label="노드"]')
        check(f"홈 실행 조합 {width}px: 노드 자리에 연결된 노드가 없다는 문구", EMPTY_NODES_TEXT in node_section.inner_text(), node_section.inner_text())
        check(f"홈 실행 조합 {width}px: 문구가 고르는 상자 안에 있음", node_section.evaluate("""(section) => {
            const text = section.querySelector('p').getBoundingClientRect();
            const box = section.closest('.v3-card-execution-picker').getBoundingClientRect();
            return text.left >= box.left && text.right <= box.right;
        }"""), width)
        check(f"홈 실행 조합 {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    popup.screenshot(path=str(out / f"{prefix}home-picker-{width}.png"), animations="disabled")
    context.close()


def pas_create(browser, base, out: Path, prefix: str, width: int, current: bool):
    # 바꾸기 전 서버는 노드가 없어도 설정된 기본 노드(eiaserinnys)를 준다.
    fake = Fake(atom=True, nodes="none", sessions="manual", defaults_node="" if current else "eiaserinnys")
    context, page = open_page(browser, base, fake, width, path="/persistent")
    expect(page.get_by_test_id("persistent-empty-manual")).to_be_visible(timeout=20000)
    page.get_by_test_id("persistent-empty-manual").get_by_role("button", name="영구 세션 만들기").click()
    dialog = page.locator('[data-slot="dialog-popup"]')
    expect(dialog).to_be_visible(timeout=15000)
    expect(page.get_by_test_id("persistent-sessions-tab")).to_be_visible(timeout=15000)
    page.wait_for_timeout(800)
    if current:
        check(f"영구 세션 만들기 {width}px: 빈 노드로 에이전트 목록을 부르지 않음", agent_list_calls(fake) == [], agent_list_calls(fake))
        check(f"영구 세션 만들기 {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    dialog.screenshot(path=str(out / f"{prefix}pas-create-{width}.png"), animations="disabled")
    (out / f"{prefix}agent-list-calls-{width}.json").write_text(json.dumps(agent_list_calls(fake)), encoding="utf-8")
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="찍을 빌드 폴더(unified-dashboard/dist)")
    parser.add_argument("--prefix", required=True, choices=("before-", "after-"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    current = args.prefix == "after-"
    server, base = serve(Path(args.dist))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width in WIDTHS:
                settings_nodes(browser, base, out, args.prefix, width, current)
                home_picker(browser, base, out, args.prefix, width, current)
                pas_create(browser, base, out, args.prefix, width, current)
            browser.close()
    finally:
        server.shutdown()
    (out / f"{args.prefix}checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(CHECKS)} checks ok, captures in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

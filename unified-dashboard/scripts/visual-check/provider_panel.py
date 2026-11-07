#!/usr/bin/env python3
"""노드 공급자 사용량 패널 시각 검수.

`NodeProvidersPanel` 이 노드를 펼쳤을 때 보이는 모습을 네 가지 상태로 캡처하고,
세 칸 게이지의 열 시작 좌표와 막대 위쪽 좌표를 재서 열이 어긋나지 않았는지 확인한다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/provider_panel.py \
        http://127.0.0.1:5173 /path/to/output

산출물

    {출력}/provider-panel-{상태}-{폭}-{테마}.png
    {출력}/provider-panel-settings-{폭}-{테마}.png
    {출력}/provider-panel-loading-{폭}-{테마}.png
    {출력}/measurements.json   (열 시작 좌표·막대 위쪽 좌표·정렬 판정·로딩 이동량)

표준 출력에는 캡처마다 한 줄, 마지막에 정렬 판정 요약을 남긴다.
열 좌표나 로딩 중 막대 위치가 1px 넘게 어긋나면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

THEMES = ("dark", "light")
WIDTHS = (1280, 390)
STATES = ("pool-collapsed", "pool-expanded", "legacy", "codex")
STATE_NODE = {
    "pool": "sample-provider-pool",
    "legacy": "sample-provider-legacy",
    "codex": "sample-provider-codex",
}
TOLERANCE_PX = 1.0

AUTH_CONFIG = {"authEnabled": True, "devModeEnabled": False}
AUTH_STATUS = {
    "authenticated": True,
    "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True},
}
# 연결 경계(ConnectionBoundary)가 덮개를 띄우지 않도록 건강 상태와 노드 하나를 알린다.
HEALTH = {"healthy": True, "ready": True, "draining": False, "build_id": "dev"}
NODES = [{
    "nodeId": "eiaserinnys",
    "host": "localhost",
    "port": 3105,
    "status": "connected",
    "capabilities": {},
    "connectedAt": 0,
    "sessionCount": 1,
}]
NODES_STREAM = "event: snapshot\ndata: " + json.dumps(NODES) + "\n\n"

MEASURE_SCRIPT = """
() => {
  const round = (value) => Math.round(value * 10) / 10;
  // 계정 펼침 목록은 계정마다 별도 게이지 묶음이므로 행 정렬 판정에서 뺀다.
  const outsideAccounts = (element) => element.closest('.c724-pool-account-item') === null;
  return Array.from(document.querySelectorAll('[data-provider-id]')).map((row) => {
    const cells = Array.from(row.querySelectorAll('.c724-quota-cell')).filter(outsideAccounts).map((cell) => {
      const box = cell.getBoundingClientRect();
      return {
        x: round(box.x),
        width: round(box.width),
        name: (cell.querySelector('.c724-quota-name')?.textContent ?? '').trim(),
        percent: (cell.querySelector('.c724-quota-pct')?.textContent ?? '').trim(),
      };
    });
    const trackTops = Array.from(row.querySelectorAll('.c724-quota-track')).filter(outsideAccounts).map((track) => round(track.getBoundingClientRect().y));
    return { provider: row.getAttribute('data-provider-id'), cells, trackTops };
  });
}
"""


INIT_SCRIPT = """
localStorage.setItem('soul-dashboard-theme', '__THEME__');
Object.defineProperty(navigator.serviceWorker, 'register', {
  configurable: true,
  value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
});
Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
"""


def install_page(context, theme: str) -> None:
    context.add_init_script(INIT_SCRIPT.replace("__THEME__", theme))
    context.route(
        "**/api/auth/config",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(AUTH_CONFIG)),
    )
    context.route(
        "**/api/auth/status",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(AUTH_STATUS)),
    )
    context.route(
        "**/api/health",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(HEALTH)),
    )
    context.route(
        "**/api/nodes",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"nodes": NODES})),
    )
    context.route(
        "**/api/nodes/stream",
        lambda route: route.fulfill(status=200, content_type="text/event-stream", body=NODES_STREAM),
    )


def settle(page: Page) -> None:
    page.wait_for_load_state("load")
    page.wait_for_timeout(300)
    page.evaluate("() => document.fonts.ready")


def open_expanded_node(page: Page, node_id: str) -> None:
    # 같은 이름이 Cogito 패널에도 있으므로 노드 카드 머리를 직접 누른다.
    card = page.get_by_test_id("node-card").filter(has_text=node_id).first
    card.locator("div").first.click()
    page.wait_for_selector("[data-provider-id]", state="visible")


def measure(page: Page) -> list[dict]:
    return page.evaluate(MEASURE_SCRIPT)


def alignment(rows: list[dict]) -> dict:
    columns: list[list[float]] = [[], [], []]
    for row in rows:
        for index, cell in enumerate(row["cells"]):
            if index < len(columns):
                columns[index].append(cell["x"])
    spreads = [round(max(values) - min(values), 1) if values else None for values in columns]
    bar_spreads = []
    for row in rows:
        tops = row["trackTops"]
        bar_spreads.append(round(max(tops) - min(tops), 1) if tops else None)
    aligned = all(spread is None or spread <= TOLERANCE_PX for spread in spreads) and all(
        spread is None or spread <= TOLERANCE_PX for spread in bar_spreads
    )
    return {"columnSpreads": spreads, "barTopSpreads": bar_spreads, "aligned": aligned}


def capture(page: Page, path: Path, rows_out: list[dict], key: str) -> None:
    page.evaluate("() => document.fonts.ready")
    page.screenshot(path=str(path), animations="disabled")
    page.wait_for_timeout(120)
    rows = measure(page)
    rows_out.append({"capture": key, "rows": rows, "alignment": alignment(rows)})
    print(f"{key}: {path.as_posix()}")


def capture_state(page: Page, base: str, out: Path, state: str, width: int, theme: str, rows_out: list[dict]) -> None:
    base_state = state.split("-")[0]
    node_id = STATE_NODE[base_state]
    page.goto(f"{base}/components?sample=claude-accounts&state={base_state}")
    settle(page)
    open_expanded_node(page, node_id)
    page.wait_for_selector(".c724-quota-grid", state="visible")
    if state == "pool-expanded":
        page.get_by_role("button", name="계정 펼치기").click()
        page.wait_for_selector(".c724-pool-account-item", state="visible")
    capture(page, out / f"provider-panel-{state}-{width}-{theme}.png", rows_out, f"{state}-{width}-{theme}")


def capture_settings(page: Page, base: str, out: Path, width: int, theme: str, rows_out: list[dict]) -> None:
    page.goto(f"{base}/dialogues?sample=settings")
    settle(page)
    page.get_by_role("button", name="노드", exact=True).click()
    open_expanded_node(page, "sample-node")
    page.wait_for_selector(".c724-quota-grid", state="visible")
    capture(page, out / f"provider-panel-settings-{width}-{theme}.png", rows_out, f"settings-{width}-{theme}")


LOADING_MEASURE_SCRIPT = """
() => Array.from(document.querySelectorAll('[data-testid="provider-quota-skeleton"] .c724-quota-track'))
  .map((track) => Math.round(track.getBoundingClientRect().y * 10) / 10)
"""


def capture_loading(page: Page, base: str, out: Path, width: int, theme: str) -> list[float]:
    page.goto(f"{base}/components?sample=claude-accounts&state=pool&loading=1")
    settle(page)
    page.get_by_test_id("node-card").filter(has_text=STATE_NODE["pool"]).first.locator("div").first.click()
    page.wait_for_selector('[data-testid="provider-quota-skeleton"]', state="visible")
    page.evaluate("() => document.fonts.ready")
    tops = page.evaluate(LOADING_MEASURE_SCRIPT)
    path = out / f"provider-panel-loading-{width}-{theme}.png"
    page.screenshot(path=str(path), animations="disabled")
    print(f"loading-{width}-{theme}: {path.as_posix()}")
    return tops


def main() -> int:
    parser = argparse.ArgumentParser(description="노드 공급자 사용량 패널 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    rows_out: list[dict] = []
    loading_tops: dict[str, list[float]] = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in WIDTHS:
                for theme in THEMES:
                    context = browser.new_context(
                        viewport={"width": width, "height": 1000 if width >= 1280 else 1400},
                        color_scheme=theme,
                        reduced_motion="reduce",
                    )
                    install_page(context, theme)
                    page = context.new_page()
                    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
                    for state in STATES:
                        capture_state(page, base, out, state, width, theme, rows_out)
                    capture_settings(page, base, out, width, theme, rows_out)
                    loading_tops[f"{width}-{theme}"] = capture_loading(page, base, out, width, theme)
                    context.close()
        finally:
            browser.close()

    # 로딩 스켈레톤과 값이 들어온 뒤의 막대 위쪽을 견줘 로딩이 끝날 때 튀지 않는지 본다.
    jumps: list[dict] = []
    for entry in rows_out:
        if not entry["capture"].startswith("pool-collapsed-"):
            continue
        width, theme = entry["capture"].rsplit("-", 2)[1:]
        loaded = entry["rows"][0]["trackTops"] if entry["rows"] else []
        skeleton = loading_tops.get(f"{width}-{theme}", [])
        if not loaded or not skeleton:
            continue
        delta = round(max(abs(a - b) for a, b in zip(loaded, skeleton)), 1) if len(loaded) == len(skeleton) else None
        jumps.append({
            "capture": f"loading-{width}-{theme}",
            "loadedTops": loaded,
            "skeletonTops": skeleton,
            "deltaPx": delta,
        })

    (out / "measurements.json").write_text(
        json.dumps({"tolerancePx": TOLERANCE_PX, "captures": rows_out, "loadingJumps": jumps}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    failures = [entry["capture"] for entry in rows_out if not entry["alignment"]["aligned"]]
    failures += [jump["capture"] for jump in jumps if jump["deltaPx"] is None or jump["deltaPx"] > TOLERANCE_PX]
    for jump in jumps:
        print(f"로딩→완료 막대 이동 {jump['capture']}: {jump['deltaPx']}px")
    if failures:
        print(f"정렬 어긋남: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"정렬 확인: 캡처 {len(rows_out)}건 모두 열 시작선과 막대 위쪽이 {TOLERANCE_PX}px 안")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

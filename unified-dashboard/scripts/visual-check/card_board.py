#!/usr/bin/env python3
"""카드 보드 시각 검수.

컴포넌트 검수 창(`/components`)의 카드 보드 표본에서 칸 순서, 「검증 대기」 칸과
칩, 상태 고르기 선택지를 넓은 폭과 좁은 폭, 라이트와 다크로 확인한다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/card_board.py \
        http://127.0.0.1:5173 /path/to/output

    # 카드 #1191 이전(18a8e5a28) 보드를 찍을 때. 「검증 대기」 칸이 없어야 통과한다.
    python3 -P unified-dashboard/scripts/visual-check/card_board.py \
        --baseline http://127.0.0.1:5173 /path/to/before

산출물

    {출력}/card-board-{폭}-{테마}.png           카드 보드 표본(「검증 대기」 칸이 보이게 가로 스크롤)
    {출력}/card-board-expanded-{폭}-{테마}.png  보드 확대(빈 칸 포함 전체 칸)
    {출력}/measurements.json                    칸 순서·좌표·칩 글자와 색·상태 고르기 선택지
    {출력}/report.json                          판정과 실패 목록

표준 출력에는 캡처마다 한 줄, 마지막에 판정 요약을 남긴다.
「검증 대기」 칸이 없거나(기본 실행) 있거나(기준선 실행), 칸 순서·표시명·칩 글자와
기본 색, 상태 고르기에서 빠져 있는 조건이 어긋나면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

THEMES = ("light", "dark")
WIDTHS = (1440, 390)
AWAITING = "awaiting_verification"
EXPECTED_ORDER = ["todo", "queued", "running", AWAITING, "blocked", "review", "on_hold", "done", "cancelled"]
# 표본은 `완료 카드 포함`을 끈 채로 뜬다. 완료·취소 칸은 그때 빠지므로 앞의 일곱 칸만 확인한다.
EXPECTED_SAMPLE_ORDER = EXPECTED_ORDER[:-2]
EXPECTED_LABEL = "검증 대기"
EXPECTED_NOW = "배포 뒤 실제 사용 확인, 14:30에 다시 확인"

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

INIT_SCRIPT = """
localStorage.setItem('soul-dashboard-theme', '__THEME__');
Object.defineProperty(navigator.serviceWorker, 'register', {
  configurable: true,
  value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
});
Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
"""

LANES_SCRIPT = """
() => Array.from(document.querySelectorAll('.v3-card-board-workspace .v3-card-board-column[data-board-column]')).map((column) => {
  const box = column.getBoundingClientRect();
  const chip = column.querySelector('[data-slot="status-chip"]');
  const style = chip ? getComputedStyle(chip) : null;
  return {
    status: column.getAttribute('data-board-column'),
    label: column.querySelector('.v3-detail-section-head h3')?.textContent?.trim() ?? column.getAttribute('aria-label'),
    left: Math.round(box.left * 10) / 10,
    width: Math.round(box.width * 10) / 10,
    cardCount: column.querySelectorAll('[data-card-id]').length,
    chipLabel: chip?.getAttribute('aria-label') ?? null,
    chipColor: style?.color ?? null,
    chipBackground: style?.backgroundColor ?? null,
    nowText: column.querySelector('[data-card-now]')?.textContent?.trim() ?? null,
  };
})
"""

PICKER_SCRIPT = """
() => {
  const popup = document.querySelector('[data-card-status-picker]');
  if (!popup) return null;
  return Array.from(popup.querySelectorAll('button')).map((button) => ({
    label: (button.textContent ?? '').trim(),
    pressed: button.getAttribute('aria-pressed'),
  }));
}
"""


def install_page(context, theme: str) -> None:
    context.add_init_script(INIT_SCRIPT.replace("__THEME__", theme))
    # 아래 구체 경로가 나중에 등록되어 우선한다. 나머지 API 는 즉시 빈 응답으로 끝내
    # 존재하지 않는 서버(127.0.0.1:9)를 기다리는 시간 초과를 없앤다.
    context.route(
        "**/api/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
    )
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
    context.route(
        "**/api/nodes/*/agents",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"agents": []})),
    )
    context.route(
        "**/api/folders",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"folders": [], "sessions": {}}),
        ),
    )


def settle(page: Page) -> None:
    page.wait_for_load_state("load")
    page.wait_for_timeout(300)
    page.evaluate("() => Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))])")


def open_board(page: Page, base: str, label: str = "") -> None:
    print(f"open {base}/components {label}", flush=True)
    page.goto(f"{base}/components")
    settle(page)
    page.locator("#components-board").scroll_into_view_if_needed()
    page.wait_for_selector('[data-testid="card-board-sample"] [data-board-column]', state="visible")
    print(f"board ready {label}", flush=True)


def workspace(page: Page):
    return page.locator('[data-testid="card-board-sample"] .v3-card-board-workspace').first


def reveal_awaiting(page: Page, root) -> None:
    column = root.locator(f'[data-board-column="{AWAITING}"]')
    if column.count():
        column.first.scroll_into_view_if_needed()
        page.wait_for_timeout(150)


def read_picker(page: Page, root) -> dict:
    trigger = root.locator(f'[data-board-column="{AWAITING}"] [aria-label="카드 상태 변경"]')
    if not trigger.count():
        return {"available": False, "options": []}
    trigger.first.click()
    page.wait_for_selector("[data-card-status-picker]", state="visible")
    options = page.evaluate(PICKER_SCRIPT) or []
    page.keyboard.press("Escape")
    page.wait_for_selector("[data-card-status-picker]", state="detached")
    return {"available": True, "options": options}


def capture(page: Page, path: Path, key: str, lanes: list[dict], picker: dict, frames: list[dict]) -> None:
    page.evaluate("() => document.fonts.ready")
    page.screenshot(path=str(path), animations="disabled")
    frames.append({"capture": key, "lanes": lanes, "picker": picker})
    print(f"{key}: {path.as_posix()}", flush=True)


def capture_width(page: Page, base: str, out: Path, width: int, theme: str, baseline: bool) -> dict:
    key = f"{width}-{theme}"
    open_board(page, base, key)
    sample = workspace(page)
    reveal_awaiting(page, sample)
    lanes = page.evaluate(LANES_SCRIPT)
    picker = read_picker(page, sample) if not baseline else {"available": False, "options": []}
    frames: list[dict] = []
    capture(page, out / f"card-board-{key}.png", f"card-board-{key}", lanes, picker, frames)

    print(f"expand {key}", flush=True)
    sample.get_by_role("button", name="보드 확대").click()
    dialog = page.locator(".v3-card-board-workspace.is-expanded")
    page.wait_for_selector(".v3-card-board-workspace.is-expanded", state="visible")
    reveal_awaiting(page, dialog)
    expanded_lanes = page.evaluate(LANES_SCRIPT)
    capture(page, out / f"card-board-expanded-{key}.png", f"card-board-expanded-{key}", expanded_lanes, picker, frames)
    page.get_by_role("button", name="확대 닫기").click()
    page.wait_for_selector(".v3-card-board-workspace.is-expanded", state="detached")
    print(f"done {key}", flush=True)

    return {
        "width": width,
        "theme": theme,
        "lanes": lanes,
        "expandedLanes": expanded_lanes,
        "picker": picker,
        "frames": frames,
    }


def judge(frame: dict, baseline: bool) -> list[dict]:
    failures: list[dict] = []
    lanes = frame["lanes"]
    expanded = frame["expandedLanes"]
    statuses = [lane["status"] for lane in lanes]
    expanded_statuses = [lane["status"] for lane in expanded]
    awaiting = next((lane for lane in expanded if lane["status"] == AWAITING), None)
    on_hold = next((lane for lane in expanded if lane["status"] == "on_hold"), None)

    if baseline:
        if AWAITING in expanded_statuses:
            failures.append({"check": "baselineHasNoAwaitingLane", "detail": expanded_statuses})
        return failures

    if AWAITING not in expanded_statuses:
        failures.append({"check": "awaitingLanePresent", "detail": expanded_statuses})
        return failures

    if expanded_statuses != EXPECTED_SAMPLE_ORDER:
        failures.append({"check": "expandedLaneOrder", "expected": EXPECTED_SAMPLE_ORDER, "detail": expanded_statuses})
    if AWAITING not in statuses:
        failures.append({"check": "awaitingLaneVisibleWithoutExpanding", "detail": statuses})
    if awaiting["label"] != EXPECTED_LABEL:
        failures.append({"check": "awaitingLaneLabel", "expected": EXPECTED_LABEL, "detail": awaiting["label"]})
    if awaiting["cardCount"] < 1:
        failures.append({"check": "awaitingSampleCard", "detail": awaiting["cardCount"]})
    if awaiting["chipLabel"] != EXPECTED_LABEL:
        failures.append({"check": "awaitingChipLabel", "expected": EXPECTED_LABEL, "detail": awaiting["chipLabel"]})
    if awaiting["nowText"] is None or EXPECTED_NOW not in awaiting["nowText"]:
        failures.append({"check": "awaitingNowText", "expected": EXPECTED_NOW, "detail": awaiting["nowText"]})
    if on_hold is None:
        failures.append({"check": "onHoldComparisonChip"})
    else:
        same_color = awaiting["chipColor"] == on_hold["chipColor"]
        same_background = awaiting["chipBackground"] == on_hold["chipBackground"]
        if not (same_color and same_background):
            failures.append({
                "check": "awaitingChipUsesDefaultMuted",
                "detail": {
                    "awaiting": [awaiting["chipColor"], awaiting["chipBackground"]],
                    "onHold": [on_hold["chipColor"], on_hold["chipBackground"]],
                },
            })

    picker = frame["picker"]
    if not picker["available"]:
        failures.append({"check": "awaitingStatusPickerOpens"})
    else:
        labels = [option["label"] for option in picker["options"]]
        if EXPECTED_LABEL in labels:
            failures.append({"check": "awaitingIsNotAManualChoice", "detail": labels})
        if any(option["pressed"] == "true" for option in picker["options"]):
            failures.append({"check": "noChoicePretendsToBeCurrent", "detail": picker["options"]})
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="카드 보드 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument("--baseline", action="store_true", help="카드 #1191 이전 보드를 찍고 「검증 대기」 칸이 없음을 확인한다")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    frames: list[dict] = []
    failures: list[dict] = []

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
                    # dev 서버 첫 화면은 모듈 변환 때문에 20초 안팎 걸린다.
                    page.set_default_timeout(60000)
                    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr, flush=True))
                    frame = capture_width(page, base, out, width, theme, args.baseline)
                    frames.extend(frame["frames"])
                    for failure in judge(frame, args.baseline):
                        failures.append({"capture": f"{width}-{theme}", **failure})
                    context.close()
        finally:
            browser.close()

    report = {
        "baseUrl": base,
        "baseline": args.baseline,
        "expectedOrder": EXPECTED_ORDER,
        "frames": frames,
        "assertions": {"passed": not failures, "failures": failures},
    }
    (out / "measurements.json").write_text(json.dumps(frames, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    verdict = "통과" if not failures else f"실패 {len(failures)}건"
    print(f"판정: {verdict}")
    for failure in failures:
        print(json.dumps(failure, ensure_ascii=False))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())

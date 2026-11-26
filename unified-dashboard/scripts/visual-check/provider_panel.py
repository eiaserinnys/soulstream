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
    {출력}/provider-panel-login-sheet-{폭}-{테마}.png
    {출력}/provider-panel-loading-{폭}-{테마}.png
    {출력}/provider-panel-unconfigured-{폭}-{테마}.png        (Claude 계정 0개 · 연결 전)
    {출력}/provider-panel-unconfigured-sheet-{폭}-{테마}.png  (연결을 눌러 시트가 열린 뒤)
    {출력}/unconfigured-report.json   (연결 단추 위치·크기를 Codex 행과 견준 값과 판정)
    {출력}/measurements.json   (열 시작 좌표·막대 위쪽 좌표·막대 높이·정렬 판정·로딩 이동량)
    {출력}/report.json         (프레임별 텍스트 잘림·막대 높이·선택 규칙과 종합 판정)

표준 출력에는 캡처마다 한 줄, 마지막에 판정 요약을 남긴다.
열 좌표나 로딩 중 막대 위치가 1px 넘게 어긋나거나, 한도 칸 글자가 잘리거나,
게이지 막대 높이가 3.5px 미만이거나 막대가 아예 없거나,
공급자 이름이 선택되거나 계정 이메일이 선택되지 않으면 종료 코드 1로 끝난다.
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
    "none": "sample-provider-none",
    "pool": "sample-provider-pool",
    "legacy": "sample-provider-legacy",
    "codex": "sample-provider-codex",
}
UNCONFIGURED_WIDTHS = (1280, 360)
TOLERANCE_PX = 1.0
MIN_TRACK_HEIGHT_PX = 3.5

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
    // 펼친 계정 목록의 게이지도 같은 클래스라 행 안의 막대를 모두 잰다. 토큰이 없으면 높이가 0 이 된다.
    const trackHeights = Array.from(row.querySelectorAll('.c724-quota-track')).map((track) => round(track.getBoundingClientRect().height));
    return { provider: row.getAttribute('data-provider-id'), cells, trackTops, trackHeights };
  });
}
"""


TEXT_CHECK_SCRIPT = """
() => {
  const clipped = [];
  document.querySelectorAll('.c724-quota-reset, .c724-quota-name, .c724-quota-pct').forEach((element) => {
    if (element.scrollWidth > element.clientWidth + 1) {
      clipped.push({
        className: element.className,
        text: (element.textContent ?? '').trim(),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      });
    }
  });
  const readSelection = (element) => ({
    text: (element.textContent ?? '').trim(),
    userSelect: window.getComputedStyle(element).userSelect,
  });
  // 공급자 이름은 행 머리의 이메일 자리이고, 펼친 계정 이메일은 계정 항목 안에 있다.
  const providerNames = Array.from(document.querySelectorAll('[data-provider-id] .c724-account-top .c724-account-email'))
    .filter((element) => element.closest('.c724-pool-account-item') === null)
    .map(readSelection);
  const accountEmails = Array.from(document.querySelectorAll('.c724-pool-account-item .c724-account-email'))
    .map(readSelection);
  return { clipped, providerNames, accountEmails };
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


def record_text_checks(page: Page, frames_out: list[dict], key: str) -> None:
    frames_out.append({"capture": key, **page.evaluate(TEXT_CHECK_SCRIPT)})


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


def capture(page: Page, path: Path, rows_out: list[dict], frames_out: list[dict], key: str) -> None:
    page.evaluate("() => document.fonts.ready")
    page.screenshot(path=str(path), animations="disabled")
    page.wait_for_timeout(120)
    rows = measure(page)
    rows_out.append({"capture": key, "rows": rows, "alignment": alignment(rows)})
    record_text_checks(page, frames_out, key)
    print(f"{key}: {path.as_posix()}")


def capture_state(
    page: Page,
    base: str,
    out: Path,
    state: str,
    width: int,
    theme: str,
    rows_out: list[dict],
    frames_out: list[dict],
) -> None:
    base_state = state.split("-")[0]
    node_id = STATE_NODE[base_state]
    page.goto(f"{base}/components?sample=claude-accounts&state={base_state}")
    settle(page)
    open_expanded_node(page, node_id)
    page.wait_for_selector(".c724-quota-grid", state="visible")
    if state == "pool-expanded":
        page.get_by_role("button", name="계정 펼치기").click()
        page.wait_for_selector(".c724-pool-account-item", state="visible")
    capture(page, out / f"provider-panel-{state}-{width}-{theme}.png", rows_out, frames_out, f"{state}-{width}-{theme}")


def capture_settings(
    page: Page,
    base: str,
    out: Path,
    width: int,
    theme: str,
    rows_out: list[dict],
    frames_out: list[dict],
) -> None:
    page.goto(f"{base}/dialogues?sample=settings")
    settle(page)
    page.get_by_role("button", name="노드", exact=True).click()
    open_expanded_node(page, "sample-node")
    page.wait_for_selector(".c724-quota-grid", state="visible")
    capture(page, out / f"provider-panel-settings-{width}-{theme}.png", rows_out, frames_out, f"settings-{width}-{theme}")


def capture_login_sheet(page: Page, base: str, out: Path, width: int, theme: str, frames_out: list[dict]) -> None:
    """계정 연결 시트는 같은 배지 CSS 를 쓰므로 이번 변경으로 달라지지 않았는지 함께 본다."""
    page.goto(f"{base}/components?sample=claude-accounts&state=pool")
    settle(page)
    open_expanded_node(page, STATE_NODE["pool"])
    page.get_by_role("button", name="계정 펼치기").click()
    page.wait_for_selector(".c724-pool-account-item", state="visible")
    page.get_by_role("button", name="계정 추가").click()
    page.wait_for_selector(".c724-auth-sheet", state="visible")
    page.evaluate("() => document.fonts.ready")
    path = out / f"provider-panel-login-sheet-{width}-{theme}.png"
    page.screenshot(path=str(path), animations="disabled")
    record_text_checks(page, frames_out, f"login-sheet-{width}-{theme}")
    print(f"login-sheet-{width}-{theme}: {path.as_posix()}")


LOADING_MEASURE_SCRIPT = """
() => Array.from(document.querySelectorAll('[data-testid="provider-quota-skeleton"] .c724-quota-track'))
  .map((track) => Math.round(track.getBoundingClientRect().y * 10) / 10)
"""


def capture_loading(page: Page, base: str, out: Path, width: int, theme: str, frames_out: list[dict]) -> list[float]:
    page.goto(f"{base}/components?sample=claude-accounts&state=pool&loading=1")
    settle(page)
    page.get_by_test_id("node-card").filter(has_text=STATE_NODE["pool"]).first.locator("div").first.click()
    page.wait_for_selector('[data-testid="provider-quota-skeleton"]', state="visible")
    page.evaluate("() => document.fonts.ready")
    tops = page.evaluate(LOADING_MEASURE_SCRIPT)
    path = out / f"provider-panel-loading-{width}-{theme}.png"
    page.screenshot(path=str(path), animations="disabled")
    record_text_checks(page, frames_out, f"loading-{width}-{theme}")
    print(f"loading-{width}-{theme}: {path.as_posix()}")
    return tops


def capture_weekly_usage(base: str, out: Path) -> int:
    """PAS 샘플과 리셋이 없는 계정 행을 같은 프레임에서 기록한다."""
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in (1280, 360):
                context = browser.new_context(viewport={"width": width, "height": 1000},
                                              color_scheme="dark", reduced_motion="reduce")
                install_page(context, "dark")
                page = context.new_page()
                page.goto(f"{base}/components?sample=weekly-usage")
                settle(page)
                page.get_by_test_id("persistent-session-weekly-usage").wait_for(state="visible")
                page.screenshot(path=str(out / f"web-pas-{width}.png"), animations="disabled")
                if width == 360:
                    page.goto(f"{base}/components?sample=claude-accounts&state=pool")
                    settle(page)
                    open_expanded_node(page, STATE_NODE["pool"])
                    page.get_by_role("button", name="계정 펼치기").first.click()
                    row = page.locator(".c724-pool-account-item").filter(has_text="eiaserinnys.sub@gmail.com")
                    row.wait_for(state="visible")
                    row.scroll_into_view_if_needed()
                    page.screenshot(path=str(out / "web-accounts-360.png"), animations="disabled")
                    cells = row.locator(".c724-quota-cell").evaluate_all("""cells => cells.map(cell => ({
                      name: cell.querySelector('.c724-quota-name')?.textContent,
                      reset: cell.querySelector('.c724-quota-reset')?.textContent,
                      trackTop: cell.querySelector('.c724-quota-track')?.getBoundingClientRect().y
                    }))""")
                    if len(cells) != 3 or not any(cell["reset"] in ("", "—") for cell in cells):
                        raise RuntimeError(f"초기화 시각이 없는 세 칸을 찾지 못했습니다: {cells}")
                    tops = [cell["trackTop"] for cell in cells]
                    spread = max(tops) - min(tops)
                    results.append({"width": width, "cells": cells, "spreadPx": spread})
                    print(f"계정 행 막대 위쪽: {tops}, 차이 {spread}px")
                context.close()
        finally:
            browser.close()
    (out / "web-measurements.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


UNCONFIGURED_MEASURE_SCRIPT = """
() => {
  const round = (value) => Math.round(value * 10) / 10;
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
  };
  const rowInfo = (id) => {
    const row = document.querySelector(`[data-provider-id="${id}"]`);
    const top = row?.querySelector('.c724-account-top') ?? null;
    const buttons = Array.from(top?.querySelectorAll('button') ?? []).filter((item) => (item.textContent ?? '').trim() === '연결');
    const meta = Array.from(top?.querySelectorAll('.c724-meta-inline') ?? []).find((item) => (item.textContent ?? '').trim() === '미설정') ?? null;
    const caps = Array.from(top?.querySelectorAll('.c724-account-actions button') ?? []);
    return {
      top: box(top),
      lastAction: box(caps[caps.length - 1] ?? null),
      connect: box(buttons[0] ?? null),
      connectCount: buttons.length,
      unconfigured: box(meta),
      unconfiguredFont: meta ? (() => { const style = window.getComputedStyle(meta); return `${style.fontSize} ${style.fontWeight} ${style.fontFamily}`; })() : null,
      rowText: (top?.textContent ?? '').trim(),
    };
  };
  const header = document.querySelector('[data-testid="claude-pool-row-header"]');
  return {
    claude: rowInfo('claude'),
    codex: rowInfo('codex'),
    antigravity: rowInfo('antigravity'),
    claudeExpanded: header?.getAttribute('aria-expanded') ?? null,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}
"""


def center_of(rect: dict) -> float:
    return rect["y"] + rect["height"] / 2


def unconfigured_failures(info: dict) -> list[str]:
    """Claude 행의 연결 단추가 Codex 행의 연결 단추와 같은 모양·같은 끝선이고 세로 가운데가 맞는지 본다."""
    failures: list[str] = []
    claude, codex = info["claude"], info["codex"]
    if claude["unconfigured"] is None:
        failures.append("Claude 행에 미설정 글자가 없음")
    elif claude["unconfiguredFont"] != codex["unconfiguredFont"]:
        failures.append(f"미설정 글자 모양이 Codex 행과 다름: {claude['unconfiguredFont']} / {codex['unconfiguredFont']}")
    if claude["connectCount"] != 1:
        failures.append(f"Claude 행의 연결 단추 {claude['connectCount']}개")
        return failures
    button, other = claude["connect"], codex["connect"]
    for key in ("width", "height"):
        if abs(button[key] - other[key]) > TOLERANCE_PX:
            failures.append(f"연결 단추 {key}가 Codex 행과 다름: {button[key]} / {other[key]}")
    # 펼치기 화살표가 행 맨 오른쪽에 남으므로 동작 묶음의 오른쪽 끝선(화살표)을 Codex 행의 연결 단추와 견준다.
    last = claude["lastAction"]
    right, other_right = last["x"] + last["width"], other["x"] + other["width"]
    if abs(right - other_right) > TOLERANCE_PX:
        failures.append(f"동작 묶음 오른쪽 끝선이 Codex 행과 다름: {right} / {other_right}")
    # 미설정 글자는 Codex 행처럼 연결 단추 바로 왼쪽에 있다.
    meta = claude["unconfigured"]
    if meta is not None and abs((meta["y"] + meta["height"] / 2) - center_of(button)) > TOLERANCE_PX:
        failures.append("미설정 글자와 연결 단추의 세로 가운데가 다름")
    codex_meta = codex["unconfigured"]
    if meta is not None and codex_meta is not None:
        gap = button["x"] - (meta["x"] + meta["width"])
        other_gap = other["x"] - (codex_meta["x"] + codex_meta["width"])
        if abs(gap - other_gap) > TOLERANCE_PX:
            failures.append(f"미설정과 연결 사이 간격이 Codex 행과 다름: {gap} / {other_gap}")
    center = button["y"] + button["height"] / 2
    row_center = claude["top"]["y"] + claude["top"]["height"] / 2
    if abs(center - row_center) > TOLERANCE_PX:
        failures.append(f"연결 단추가 행 세로 가운데에 없음: {center} / {row_center}")
    if info["pageOverflowX"] > 0:
        failures.append(f"가로 넘침 {info['pageOverflowX']}px")
    return failures


def capture_unconfigured(base: str, out: Path) -> list[str]:
    """Claude 계정 0개 행을 1280px와 360px로 찍고, 연결을 눌러 시트를 연 장면까지 남긴다."""
    reports: list[dict] = []
    failures: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in UNCONFIGURED_WIDTHS:
                for theme in THEMES:
                    context = browser.new_context(viewport={"width": width, "height": 900},
                                                  color_scheme=theme, reduced_motion="reduce")
                    install_page(context, theme)
                    page = context.new_page()
                    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
                    page.goto(f"{base}/components?sample=claude-accounts&state=none")
                    settle(page)
                    open_expanded_node(page, STATE_NODE["none"])
                    page.wait_for_selector('[data-provider-id="codex"]', state="visible")
                    key = f"unconfigured-{width}-{theme}"
                    page.screenshot(path=str(out / f"provider-panel-{key}.png"), animations="disabled")
                    info = page.evaluate(UNCONFIGURED_MEASURE_SCRIPT)
                    found = unconfigured_failures(info)
                    sheet_opened = False
                    if info["claude"]["connectCount"] == 1:
                        page.locator('[data-provider-id="claude"] .c724-account-top').get_by_role("button", name="연결", exact=True).click()
                        page.wait_for_selector(".c724-auth-sheet", state="visible")
                        page.evaluate("() => document.fonts.ready")
                        sheet_opened = True
                        page.screenshot(path=str(out / f"provider-panel-unconfigured-sheet-{width}-{theme}.png"), animations="disabled")
                        if page.locator('[data-testid="claude-pool-row-header"]').get_by_role("button", name="계정 접기").count() > 0:
                            found.append("연결을 눌렀더니 행이 펼쳐짐")
                    else:
                        found.append("연결 단추가 없어 시트를 열지 못함")
                    reports.append({"capture": key, "sheetOpened": sheet_opened, "failures": found, "measured": info})
                    failures.extend(f"{key}: {message}" for message in found)
                    print(f"{key}: {'통과' if not found else '; '.join(found)}")
                    context.close()
        finally:
            browser.close()
    (out / "unconfigured-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="노드 공급자 사용량 패널 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument("--weekly-usage", action="store_true", help="PAS와 초기화 시각 없는 계정 행을 캡처")
    parser.add_argument("--unconfigured", action="store_true", help="Claude 계정 0개 행만 캡처하고 연결 단추를 Codex 행과 견줌")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.weekly_usage:
        return capture_weekly_usage(base, out)
    if args.unconfigured:
        problems = capture_unconfigured(base, out)
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        return 0
    rows_out: list[dict] = []
    frames_out: list[dict] = []
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
                        capture_state(page, base, out, state, width, theme, rows_out, frames_out)
                    capture_settings(page, base, out, width, theme, rows_out, frames_out)
                    capture_login_sheet(page, base, out, width, theme, frames_out)
                    loading_tops[f"{width}-{theme}"] = capture_loading(page, base, out, width, theme, frames_out)
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

    # 한도 칸의 이름·퍼센트·초기화 글자가 잘리지 않는지 프레임마다 본다.
    clipping_failures = [
        {"capture": frame["capture"], **item}
        for frame in frames_out
        for item in frame["clipped"]
    ]
    # 공급자 이름은 화면 틀이라 선택되지 않아야 하고, 펼친 계정 이메일은 복사 대상이라 선택돼야 한다.
    provider_selection_failures = [
        {"capture": frame["capture"], **item}
        for frame in frames_out
        for item in frame["providerNames"]
        if item["userSelect"] != "none"
    ]
    account_selection_failures = [
        {"capture": frame["capture"], **item}
        for frame in frames_out
        for item in frame["accountEmails"]
        if item["userSelect"] != "text"
    ]
    # 대상이 아예 그려지지 않으면 위 목록이 비어 통과처럼 보이므로 프레임 자체를 검사한다.
    missing_provider_names = [frame["capture"] for frame in frames_out if not frame["providerNames"]]
    missing_account_emails = [
        frame["capture"]
        for frame in frames_out
        if frame["capture"].startswith("pool-expanded-") and not frame["accountEmails"]
    ]
    # 게이지 막대는 토큰이 없으면 높이 0 이 되어 사라진다. 프레임마다 막대 높이를 잰다.
    track_height_failures = [
        {"capture": entry["capture"], "provider": row["provider"], "height": height}
        for entry in rows_out
        for row in entry["rows"]
        for height in row["trackHeights"]
        if height < MIN_TRACK_HEIGHT_PX
    ]
    # 막대가 하나도 그려지지 않은 프레임은 위 목록이 비어 통과처럼 보이므로 따로 잡는다.
    missing_track_frames = [
        entry["capture"]
        for entry in rows_out
        if not any(row["trackHeights"] for row in entry["rows"])
    ]
    alignment_failures = [entry["capture"] for entry in rows_out if not entry["alignment"]["aligned"]]
    jump_failures = [jump["capture"] for jump in jumps if jump["deltaPx"] is None or jump["deltaPx"] > TOLERANCE_PX]

    report = {
        "baseUrl": base,
        "tolerancePx": TOLERANCE_PX,
        "frames": frames_out,
        "loadingJumps": jumps,
        "assertions": {
            "quotaTextClipping": {
                "passed": not clipping_failures,
                "failures": clipping_failures,
            },
            "providerNameSelection": {
                "passed": not provider_selection_failures and not missing_provider_names,
                "failures": provider_selection_failures,
                "missingFrames": missing_provider_names,
            },
            "accountEmailSelection": {
                "passed": not account_selection_failures and not missing_account_emails,
                "failures": account_selection_failures,
                "missingFrames": missing_account_emails,
            },
            "quotaTrackHeight": {
                "passed": not track_height_failures and not missing_track_frames,
                "minimumPx": MIN_TRACK_HEIGHT_PX,
                "failures": track_height_failures,
                "missingFrames": missing_track_frames,
            },
            "columnAlignment": {
                "passed": not alignment_failures,
                "failures": alignment_failures,
            },
            "loadingJump": {
                "passed": not jump_failures,
                "failures": jump_failures,
            },
        },
    }
    report["passed"] = all(entry["passed"] for entry in report["assertions"].values())

    (out / "measurements.json").write_text(
        json.dumps({"tolerancePx": TOLERANCE_PX, "captures": rows_out, "loadingJumps": jumps}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    for jump in jumps:
        print(f"로딩→완료 막대 이동 {jump['capture']}: {jump['deltaPx']}px")
    print(f"한도 칸 글자 잘림: {len(clipping_failures)}건 (프레임 {len(frames_out)}건 검사)")
    print(
        f"게이지 막대 높이: {MIN_TRACK_HEIGHT_PX}px 미만 {len(track_height_failures)}건, "
        f"막대 없는 프레임 {len(missing_track_frames)}건"
    )

    failed_groups = [
        f"정렬 어긋남: {', '.join(alignment_failures)}" if alignment_failures else "",
        f"로딩 이동: {', '.join(jump_failures)}" if jump_failures else "",
        f"글자 잘림: {', '.join(sorted({item['capture'] for item in clipping_failures}))}" if clipping_failures else "",
        f"막대 높이 부족: {', '.join(sorted({item['capture'] for item in track_height_failures}))}"
        if track_height_failures else "",
        f"막대 없음: {', '.join(missing_track_frames)}" if missing_track_frames else "",
        f"공급자 이름 선택 가능: {', '.join(sorted({item['capture'] for item in provider_selection_failures}))}"
        if provider_selection_failures else "",
        f"공급자 이름 없음: {', '.join(missing_provider_names)}" if missing_provider_names else "",
        f"계정 이메일 선택 불가: {', '.join(sorted({item['capture'] for item in account_selection_failures}))}"
        if account_selection_failures else "",
        f"계정 이메일 없음: {', '.join(missing_account_emails)}" if missing_account_emails else "",
    ]
    messages = [message for message in failed_groups if message]
    messages.extend(capture_unconfigured(base, out))
    if messages:
        print("\n".join(messages), file=sys.stderr)
        return 1
    print(
        f"판정: 프레임 {len(frames_out)}건에서 한도 칸 글자 잘림 없음, "
        f"게이지 막대 높이 {MIN_TRACK_HEIGHT_PX}px 이상, "
        f"공급자 이름 선택 차단·계정 이메일 선택 허용, "
        f"열 시작선과 막대 위쪽이 {TOLERANCE_PX}px 안"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

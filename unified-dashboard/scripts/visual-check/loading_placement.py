#!/usr/bin/env python3
"""프레임 로딩 배치 시각 검수.

대표 화면의 로딩 상태를 Playwright 로 붙잡아 두고 넓은 폭(1440)과 좁은 폭(390)에서
캡처한 뒤, 로딩 덩어리(스피너+글자)의 중심이 프레임의 내용 상자 중심에서 1px 안에
있는지 잰다. 높이가 내용으로 정해지는 자리(content)는 가로 중심과 위/아래 여백이
같은지를 잰다.

준비

    # 저장소 루트에서 (워크트리 기준)
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/loading_placement.py \
        http://127.0.0.1:5173 /path/to/output

    # 기준본(origin/main) 캡처: 같은 스크립트로 --baseline
    python3 -P unified-dashboard/scripts/visual-check/loading_placement.py \
        http://127.0.0.1:5173 /path/to/output-before --baseline

산출물

    {출력}/loading-{화면}-{폭}[-before].png
    {출력}/measurements.json   (프레임·로딩 덩어리 좌표와 판정)
    {출력}/report.json         (화면별 판정과 종합 판정)

표준 출력에는 캡처마다 한 줄, 마지막에 판정 요약을 남긴다. --baseline 이 아니면
가로/세로 중심이 1px 를 넘게 어긋나거나, 높이 고정 프레임을 채우지 못하거나,
로딩 덩어리가 보이지 않으면 종료 코드 1로 끝난다.

기준본 캡처에는 두 표본 경로가 아직 없으므로(런타임 첫 로딩 표본, 문서 리더 로딩
표본) 기준본 체크아웃에 표본 파일만 얹어 같은 주소로 찍는다. 표본은 검수용 껍데기이고
재는 대상은 기준본 부품이다.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

TOLERANCE_PX = 1.0
WIDTHS = (1440, 390)
VIEWPORT_HEIGHTS = {1440: 1000, 390: 844}

AUTH_CONFIG = {"authEnabled": True, "devModeEnabled": False}
AUTH_STATUS = {
    "authenticated": True,
    "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True},
}
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
FOLDERS = {
    "folders": [{
        "id": "folder-1",
        "name": "검수 폴더",
        "sortOrder": 1,
        "parentFolderId": None,
        "projectPageId": "page-1",
        "status": "open",
        "version": 1,
        "archived": False,
        "settings": {},
    }],
    "sessions": {},
}
STARRED = {"items": [], "nextCursor": None}
PAS_LIST = {
    "sessions": [],
    "total": 0,
    "create_defaults": {"node_id": "eiaserinnys", "preferred_agent_id": "default"},
}
PAGE = {
    "id": "page-1",
    "title": "검수 폴더",
    "daily_date": None,
    "version": 1,
    "archived": False,
    "metadata": {},
    "created_at": "2026-11-01T00:00:00Z",
    "updated_at": "2026-11-01T00:00:00Z",
}
PROJECT_AGGREGATE = {
    "folder": FOLDERS["folders"][0],
    "page": PAGE,
    "blocks": [],
    "cards": [],
    "subfolders": {"items": [], "nextCursor": None},
    "sessions": {"items": [], "nextCursor": None},
}
PAGE_READ = {"page": PAGE, "blocks": [], "state_vector": ""}
BOARD_ITEMS = {"boardItems": [{
    "id": "item-1",
    "itemType": "markdown",
    "itemId": "doc-1",
    "container": {"kind": "folder", "id": "folder-1"},
    "metadata": {"title": "검수 문서"},
    "sortOrder": 0,
}]}

INIT_SCRIPT = """
localStorage.setItem('soul-dashboard-theme', '__THEME__');
// 소프트웨어 렌더링 WebGL 캔버스가 측정을 느리게 하고 포인터를 가로챈다. 유리 효과를 끈다.
localStorage.setItem('ls.webglGlass', '0');
Object.defineProperty(navigator.serviceWorker, 'register', {
  configurable: true,
  value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
});
Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
"""

MEASURE_SCRIPT = """
({ frameSelector, text }) => {
  const round = (value) => Math.round(value * 10) / 10;
  // 회전 중인 스피너의 외접 상자는 각도에 따라 커진다. 잠깐 애니메이션을 끄고
  // 배치 상자를 잰 뒤 즉시 되돌린다.
  const style = document.createElement('style');
  style.textContent = '[data-slot="frame-loading"] * { animation: none !important; }';
  document.head.appendChild(style);
  void document.body.offsetHeight;
  const union = (rects) => rects.reduce((acc, rect) => acc ? ({
    left: Math.min(acc.left, rect.left),
    top: Math.min(acc.top, rect.top),
    right: Math.max(acc.right, rect.right),
    bottom: Math.max(acc.bottom, rect.bottom),
  }) : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, null);
  const frame = document.querySelector(frameSelector);
  const fail = (error) => { style.remove(); return { error }; };
  if (!frame) return fail('frame not found');
  const fr = frame.getBoundingClientRect();
  const cs = getComputedStyle(frame);
  const frameContent = {
    left: fr.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
    right: fr.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
    top: fr.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
    bottom: fr.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth),
  };
  const slot = frame.querySelector('[data-slot="frame-loading"]');
  let target = slot;
  let kind = 'slot';
  if (!target) {
    kind = 'text';
    const nodes = Array.from(frame.querySelectorAll('*')).filter((element) =>
      (element.textContent ?? '').trim() === text && element.getClientRects().length > 0);
    nodes.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length
      || a.children.length - b.children.length);
    target = nodes[0] ?? null;
  }
  if (!target) return fail('loading element not found');
  const rects = kind === 'slot'
    ? Array.from(target.children)
        .filter((child) => child.getClientRects().length > 0)
        .map((child) => child.getBoundingClientRect())
    : [target.getBoundingClientRect()];
  const cluster = union(rects);
  if (!cluster) return fail('loading cluster not found');
  const targetRect = target.getBoundingClientRect();
  const targetStyle = getComputedStyle(target);
  const slotContent = kind === 'slot' ? {
    top: targetRect.top + parseFloat(targetStyle.paddingTop) + parseFloat(targetStyle.borderTopWidth),
    bottom: targetRect.bottom - parseFloat(targetStyle.paddingBottom) - parseFloat(targetStyle.borderBottomWidth),
    left: targetRect.left + parseFloat(targetStyle.paddingLeft) + parseFloat(targetStyle.borderLeftWidth),
    right: targetRect.right - parseFloat(targetStyle.paddingRight) - parseFloat(targetStyle.borderRightWidth),
  } : null;
  const clusterCenter = {
    x: (cluster.left + cluster.right) / 2,
    y: (cluster.top + cluster.bottom) / 2,
  };
  const frameCenter = {
    x: (frameContent.left + frameContent.right) / 2,
    y: (frameContent.top + frameContent.bottom) / 2,
  };
  const result = {
    kind,
    visible: targetRect.width > 0 && targetRect.height > 0,
    slot: {
      width: round(targetRect.width),
      height: round(targetRect.height),
    },
    cluster: {
      width: round(cluster.right - cluster.left),
      height: round(cluster.bottom - cluster.top),
      centerX: round(clusterCenter.x),
      centerY: round(clusterCenter.y),
      text: (target.textContent ?? '').trim(),
    },
    frameContent: {
      width: round(frameContent.right - frameContent.left),
      height: round(frameContent.bottom - frameContent.top),
      centerX: round(frameCenter.x),
      centerY: round(frameCenter.y),
    },
    slotContent: slotContent ? {
      top: round(slotContent.top),
      bottom: round(slotContent.bottom),
    } : null,
    dx: round(clusterCenter.x - frameCenter.x),
    dy: round(clusterCenter.y - frameCenter.y),
    padTop: kind === 'slot' ? round(cluster.top - slotContent.top) : null,
    padBottom: kind === 'slot' ? round(slotContent.bottom - cluster.bottom) : null,
  };
  style.remove();
  return result;
}
"""


def load_json(context, pattern: str, payload) -> None:
    body = payload if isinstance(payload, str) else json.dumps(payload)
    context.route(
        pattern,
        lambda route: route.fulfill(status=200, content_type="application/json", body=body),
    )


def hold(context, pattern) -> None:
    """응답을 붙잡아 둔다. Playwright 가 라우트를 처리하지 않아 요청이 끝나지 않는다."""
    context.route(pattern, lambda route: None)


def install_page(context, theme: str) -> None:
    context.add_init_script(INIT_SCRIPT.replace("__THEME__", theme))
    # 구체 경로가 나중에 등록되어 우선한다. 나머지 API 는 즉시 빈 응답으로 끝낸다.
    load_json(context, "**/api/**", "{}")
    load_json(context, "**/api/auth/config", AUTH_CONFIG)
    load_json(context, "**/api/auth/status", AUTH_STATUS)
    load_json(context, "**/api/health", HEALTH)
    load_json(context, "**/api/nodes", {"nodes": NODES})
    context.route(
        "**/api/nodes/stream",
        lambda route: route.fulfill(status=200, content_type="text/event-stream", body=NODES_STREAM),
    )
    # 세션 스트림도 SSE 로 응답해야 EventSource 가 오류를 내지 않고 연결 복구 대화상자가 뜨지 않는다.
    context.route(
        "**/api/sessions/stream*",
        lambda route: route.fulfill(status=200, content_type="text/event-stream", body=""),
    )
    load_json(context, "**/api/folders", FOLDERS)
    # 설정 모달이 배열을 기대하는 응답들 — 빈 배열이라도 모양을 맞춰 준다.
    load_json(context, "**/api/nodes/*/agents", {"agents": []})
    load_json(context, "**/api/nodes/*/agents/default/portrait", "")
    load_json(context, "**/api/config/settings", {"categories": [], "values": {}})
    load_json(context, "**/api/planner/starred-folders*", STARRED)
    load_json(context, "**/api/persistent-sessions", PAS_LIST)
    load_json(context, "**/api/board-items*", BOARD_ITEMS)
    load_json(context, "**/api/planner/folders/folder-1*", PROJECT_AGGREGATE)
    load_json(context, "**/api/pages/page-1", PAGE_READ)
    load_json(context, re.compile(r"/api/cards\?(?![^#]*\bstatus=done\b)"), {"cards": []})


def settle(page: Page) -> None:
    page.wait_for_load_state("load")
    page.wait_for_timeout(300)
    page.evaluate("() => document.fonts.ready")


def wait_shell(page: Page) -> None:
    page.wait_for_selector(".v3-shell", state="visible", timeout=30000)


def wait_loading(page: Page, frame: str, after: str, before: str) -> None:
    page.wait_for_selector(f"{frame} {after}, {frame} {before}", state="visible", timeout=30000)


def open_card_board(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    page.wait_for_selector('.v3-card-inbox[data-card-scope="all"]', state="visible", timeout=30000)


def open_completed_cards(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    page.get_by_role("button", name="일반 보기").click()
    page.get_by_role("switch", name="완료·취소 숨김").click()
    page.wait_for_selector('[data-testid="completed-viewport"]', state="visible", timeout=30000)


def open_folder(page: Page) -> None:
    """넓은 폭은 사이드바 나무, 좁은 폭은 모바일 프로젝트 목록에서 폴더를 고른다."""
    if page.viewport_size["width"] <= 760:
        page.click('[data-testid="v3-mobile-tab-projects"]')
        page.wait_for_selector('[data-testid="v3-mobile-project-list"] button', state="visible", timeout=30000)
        page.evaluate("""() => document.querySelector('[data-testid="v3-mobile-project-list"] button').click()""")
        return
    page.wait_for_selector('[data-testid="v3-project-row-folder-1"]', state="visible", timeout=30000)
    page.evaluate("""() => document.querySelector('[data-testid="v3-project-row-folder-1"] .v3-project-nav-link').click()""")


def open_folder_body(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    open_folder(page)
    # WebGL 배경 캔버스가 포인터를 가로채 Playwright 액션 클릭이 막힌다. DOM 클릭으로 연다.
    page.wait_for_selector('button[aria-label="검수 문서 펼치기"]', state="visible", timeout=30000)
    page.evaluate("""() => document.querySelector('button[aria-label="검수 문서 펼치기"]').click()""")


def open_pas_screen(page: Page) -> None:
    page.goto("/persistent/pas-1")
    wait_shell(page)


def open_settings_tab(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    page.click('[data-testid="config-button"]')
    page.get_by_role("button", name="에이전트", exact=True).click()


def click_menu_item(page: Page, label: str, timeout: int = 30000) -> None:
    """넓은 폭은 base-ui 메뉴(div[role=menuitem]), 좁은 폭은 단추 목록으로 뜬다."""
    page.wait_for_function(
        """(label) => [...document.querySelectorAll('button, [role="menuitem"]')]
             .some((element) => element.textContent.trim() === label)""",
        arg=label,
        timeout=timeout,
    )
    page.evaluate(
        """(label) => {
          const element = [...document.querySelectorAll('button, [role="menuitem"]')]
            .find((candidate) => candidate.textContent.trim() === label);
          element.click();
        }""",
        label,
    )


def open_project_dialog(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    # 좁은 폭에서는 사이드바 나무가 숨어 있지만 행은 마운트돼 있다. 좌표를 실은
    # contextmenu 이벤트를 직접 보내 메뉴를 연다(측정 대상은 대화상자 배치다).
    state = "visible" if page.viewport_size["width"] > 760 else "attached"
    page.wait_for_selector('[data-testid="v3-project-row-folder-1"]', state=state, timeout=30000)
    page.wait_for_timeout(500)
    for attempt in range(3):
        page.evaluate("""() => {
          const row = document.querySelector('[data-testid="v3-project-row-folder-1"]');
          const rect = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: rect.x + 24, clientY: rect.y + 12,
          }));
        }""")
        try:
            click_menu_item(page, "폴더 설정", timeout=5000)
            return
        except PlaywrightTimeoutError:
            if attempt == 2:
                raise


def open_runtime_sample(page: Page) -> None:
    page.goto("/components?sample=runtime-loading")
    page.wait_for_selector('section[data-slot="claude-runtime-schedules-caption"]', state="visible", timeout=30000)


def open_search_modal(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    # 좁은 폭에서는 도구막대 검색 단추가 숨어 있다. 단추는 마운트돼 있으니 DOM 클릭으로 연다.
    page.wait_for_selector('[aria-label="Open session search"]', state="attached", timeout=30000)
    page.evaluate("""() => document.querySelector('[aria-label="Open session search"]').click()""")
    page.get_by_placeholder("검색어를 입력하세요...").fill("검수")


def open_document_reader(page: Page) -> None:
    page.goto("/dialogues?sample=document-reader&loading=1")
    page.wait_for_selector('[data-testid="internal-document-dialog"]', state="visible", timeout=30000)


SCREENS = [
    {
        "key": "card-board",
        "frame": '.v3-card-inbox[data-card-scope="all"]',
        "after": '[data-slot="frame-loading"]',
        "before": 'p.v3-card-board-empty[role="status"]',
        "text": "카드를 불러오는 중…",
        "mode": "fill",
        "hold": re.compile(r"/api/cards\?.*includeCompleted=false"),
        "open": open_card_board,
    },
    {
        "key": "completed-cards",
        "frame": '[data-testid="completed-viewport"]',
        "after": '[data-slot="frame-loading"]',
        "before": 'p.v3-card-board-empty[role="status"]',
        "text": "완료 카드를 불러오는 중…",
        "mode": "content",
        "hold": re.compile(r"/api/cards\?.*\bstatus=done\b"),
        "open": open_completed_cards,
    },
    {
        "key": "folder-body",
        "frame": ".v3-inline-board-item",
        "after": '[data-slot="frame-loading"]',
        "before": "p.v3-detail-empty",
        "text": "본문을 불러오는 중…",
        "mode": "content",
        "hold": re.compile(r"/api/markdown-documents/"),
        "open": open_folder_body,
    },
    {
        "key": "pas-screen",
        "frame": ".persistent-session-main",
        "after": '[data-slot="frame-loading"]',
        "before": 'p[role="status"]',
        "text": "불러오는 중…",
        "mode": "fill",
        "hold": "**/api/persistent-sessions",
        "open": open_pas_screen,
    },
    {
        "key": "settings-tab",
        "frame": ".config-detail",
        "after": '[data-slot="frame-loading"]',
        "before": ".py-8.text-center",
        "text": "프로필을 불러오는 중...",
        "mode": "content",
        "hold": "**/api/agent-profiles",
        "open": open_settings_tab,
    },
    {
        "key": "project-dialog",
        "frame": '.project-purpose-dialog [data-slot="dialog-panel"]',
        "after": '[data-slot="frame-loading"]',
        "before": 'p[aria-busy="true"]',
        "text": "프로젝트 설정을 불러오는 중…",
        "mode": "content",
        "hold": re.compile(r"/api/pages/page-1\?include_blocks=true"),
        "open": open_project_dialog,
    },
    {
        "key": "runtime-schedules",
        # 캡션 껍데기가 아니라 로딩이 실제로 놓이는 스크롤 본문을 프레임으로 잰다.
        "frame": 'section[data-slot="claude-runtime-schedules-caption"] > div:last-child',
        "after": '[data-slot="frame-loading"]',
        "before": ".animate-spin",
        "text": "불러오는 중…",
        "mode": "content",
        "hold": "**/api/sessions/review-runtime-loading/schedules",
        "baseline_url": "/components",
        "baseline_hold": "**/api/sessions/components-review-manuscript/schedules",
        "open": open_runtime_sample,
    },
    {
        "key": "search-modal",
        "frame": '[data-slot="dialog-popup"] [data-slot="dialog-panel"]',
        "after": '[data-slot="frame-loading"]',
        "before": ".py-6 .animate-spin",
        "text": "검색 중...",
        "mode": "content",
        "hold": re.compile(r"/cogito/search\?"),
        "open": open_search_modal,
    },
    {
        "key": "document-reader",
        "frame": '[data-testid="internal-document-dialog"] [data-slot="dialog-panel"]',
        "after": '[data-slot="frame-loading"]',
        "before": ".v3-board-load-state",
        "text": "본문을 불러오는 중…",
        "mode": "content",
        "hold": re.compile(r"/api/markdown-documents/sample-linked-document"),
        "open": open_document_reader,
    },
]


def judge(measurement: dict, mode: str, baseline: bool) -> dict:
    if "error" in measurement:
        return {"passed": baseline, "reason": measurement["error"]}
    if not measurement["visible"]:
        return {"passed": baseline, "reason": "로딩 요소가 보이지 않음"}
    if baseline:
        return {"passed": True, "reason": "기준본 기록"}
    horizontal = abs(measurement["dx"]) <= TOLERANCE_PX
    if mode == "fill":
        vertical = abs(measurement["dy"]) <= TOLERANCE_PX
        passed = horizontal and vertical
        reason = "가로·세로 중심" if passed else "프레임 중심에서 벗어남"
    else:
        symmetric = (measurement["padTop"] is not None
                     and abs(measurement["padTop"] - measurement["padBottom"]) <= TOLERANCE_PX)
        passed = horizontal and symmetric
        reason = "가로 중심·위아래 여백 같음" if passed else "가로 중심 또는 위아래 여백이 어긋남"
    return {
        "passed": passed,
        "reason": reason,
        "horizontal": horizontal,
        **({"vertical": abs(measurement["dy"]) <= TOLERANCE_PX} if mode == "fill" else {
            "paddingSymmetric": abs(measurement["padTop"] - measurement["padBottom"]) <= TOLERANCE_PX
            if measurement["padTop"] is not None else False,
        }),
    }


def capture_screen(browser, base: str, out: Path, screen: dict, width: int, baseline: bool) -> dict:
    context = browser.new_context(
        base_url=base,
        viewport={"width": width, "height": VIEWPORT_HEIGHTS[width]},
        color_scheme="dark",
        reduced_motion="reduce",
    )
    install_page(context, "dark")
    if screen.get("hold") and not baseline:
        hold(context, screen["hold"])
    if baseline and screen.get("baseline_hold"):
        hold(context, screen["baseline_hold"])
    elif baseline and screen.get("hold"):
        hold(context, screen["hold"])
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
    try:
        if baseline and screen.get("baseline_url"):
            page.goto(f"{base}{screen['baseline_url']}")
            page.wait_for_selector('section[data-slot="claude-runtime-schedules-caption"]', state="visible", timeout=30000)
        else:
            screen["open"](page)
        wait_loading(page, screen["frame"], screen["after"], screen["before"])
        settle(page)
        measurement = page.evaluate(MEASURE_SCRIPT, {
            "frameSelector": screen["frame"],
            "text": screen["text"],
        })
        verdict = judge(measurement, screen["mode"], baseline)
        suffix = "-before" if baseline else ""
        path = out / f"loading-{screen['key']}-{width}{suffix}.png"
        page.screenshot(path=str(path), animations="disabled")
        print(f"{screen['key']}-{width}{suffix}: {path.as_posix()}")
        return {
            "screen": screen["key"],
            "width": width,
            "mode": screen["mode"],
            "baseline": baseline,
            "capture": path.name,
            "frame": screen["frame"],
            **measurement,
            **verdict,
        }
    finally:
        context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="프레임 로딩 배치 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument("--baseline", action="store_true", help="기준본 캡처(판정 없이 기록)")
    parser.add_argument("--screen", action="append", choices=[screen["key"] for screen in SCREENS],
                        help="이 화면만 찍는다 (여러 번 지정 가능)")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    screens = [screen for screen in SCREENS if not args.screen or screen["key"] in args.screen]
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in WIDTHS:
                for screen in screens:
                    captures.append(capture_screen(browser, base, out, screen, width, args.baseline))
        finally:
            browser.close()

    failures = [entry for entry in captures if not entry["passed"]]
    report = {
        "baseUrl": base,
        "baseline": args.baseline,
        "tolerancePx": TOLERANCE_PX,
        "widths": list(WIDTHS),
        "captures": captures,
        "assertions": {
            "placement": {
                "passed": not failures,
                "failures": [
                    {"screen": entry["screen"], "width": entry["width"], "reason": entry["reason"]}
                    for entry in failures
                ],
            },
        },
    }
    report["passed"] = all(entry["passed"] for entry in report["assertions"].values())
    (out / "measurements.json").write_text(
        json.dumps({"tolerancePx": TOLERANCE_PX, "captures": captures}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for entry in captures:
        print(
            f"{entry['screen']} {entry['width']}px: dx={entry.get('dx')}px dy={entry.get('dy')}px "
            f"pad=({entry.get('padTop')},{entry.get('padBottom')}) → {entry['reason']}"
        )
    if failures and not args.baseline:
        print("\n".join(
            f"배치 실패: {entry['screen']} {entry['width']}px · {entry['reason']}" for entry in failures
        ), file=sys.stderr)
        return 1
    print(f"판정: {len(captures)}건 · {TOLERANCE_PX}px 기준 통과")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

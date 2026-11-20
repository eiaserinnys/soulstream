#!/usr/bin/env python3
"""중앙 풀 카드와 노드별 「중앙 풀 받기」 스위치 시각 검수.

`/components?sample=claude-central&scene=...`의 실제 `NodePanel`을 넓은 폭(1280)과 좁은
폭(390), 밝은/어두운 테마에서 캡처하고, 중앙 카드가 노드 카드와 같은 틀인지, 노드 목록 맨
위인지, 중앙 계정 목록·로그인 시트·받기 스위치의 상태가 기준본과 맞는지 좌표로 잰다.
ui-design 0절 14~18번(초점, Tab·Esc, 360 넘침, 오류, 창 크기)도 같은 실행에서 조작해 잰다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/central_pool.py \
        http://127.0.0.1:5173 /path/to/output

    # 또는 서버를 함께 띄우는 래퍼로
    unified-dashboard/scripts/visual-check/central_pool_run.sh /path/to/output

산출물

    {출력}/central-pool-{장면}-{폭}-{테마}.png
    {출력}/central-pool-login-focus-{폭}-{테마}.png      코드 칸에 초점이 든 로그인 시트
    {출력}/central-pool-resize-{폭}-{테마}.png           1280에서 390으로 줄인 뒤
    {출력}/central-pool-overflow-360-{테마}.png          360 폭 넘침 검사
    {출력}/measurements.json   장면별 좌표·글·초점·Tab 순서
    {출력}/report.json         단언별 판정과 종합 결과

중앙 카드가 없거나 노드 목록 맨 위가 아니거나, 틀·머리 높이·좌우 끝선이 노드 카드와
1px 넘게 다르거나, 머리 끝 ▲▼가 키보드 단추가 아니거나, 계정 이메일이 잘리거나,
받기 스위치의 값·비활성·되돌림과 실패 뒤 스위치 유지가 기준본과 다르거나, 로그인 시트
상태가 다르거나, 360/390에서 가로 넘침이 있거나, 초점·Tab·Enter·Esc·창 크기 조작 결과가
기대와 다르면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

THEMES = ("dark", "light")
WIDTHS = (1280, 390)
OVERFLOW_WIDTH = 360
TOLERANCE_PX = 1.0
CARD_GAP_PX = 8.0

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

# 장면 이름, 주소의 scene, 여는 방법. receive-on은 계정 장면에서 노드 카드를 펼친 모습이다.
SCENES: tuple[tuple[str, str, str], ...] = (
    ("central-empty", "empty", "central"),
    ("central-accounts", "accounts", "central"),
    ("central-login-url-ready", "login-url-ready", "login"),
    ("central-login-verifying", "login-verifying", "login"),
    ("central-login-failed", "login-failed", "login"),
    ("central-loading", "loading", "loading"),
    ("central-failure", "failure", "failure"),
    ("receive-on", "accounts", "receive"),
    ("receive-off", "receive-off", "receive"),
    ("receive-pending", "receive-pending", "receive"),
    ("receive-failure", "receive-failure", "receive"),
    ("receive-settings-error", "receive-settings-error", "receive"),
    ("node-card-invariant", "accounts", "node-invariant"),
)

LONG_EMAIL = "eiaserinnys.central.archive.long.address@example.invalid"

INIT_SCRIPT = """
localStorage.setItem('soul-dashboard-theme', '__THEME__');
// 헤드리스의 소프트웨어 렌더링 WebGL 유리 배경이 캡처와 클릭마다 수십 초를 쓰고
// 요소 안정 대기를 막는다. 검수 표본 판정에는 필요 없어 끈다(loading_placement.py와 같은 방식).
localStorage.setItem('ls.webglGlass', '0');
Object.defineProperty(navigator.serviceWorker, 'register', {
  configurable: true,
  value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
});
Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
"""

MEASURE_SCRIPT = """
() => {
  const round = (value) => Math.round(value * 10) / 10;
  const text = (element) => (element?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return {
      x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height),
      left: round(box.left), right: round(box.right), top: round(box.top), bottom: round(box.bottom),
    };
  };
  const frameStyle = (element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: style.borderRadius,
      borderTopWidth: style.borderTopWidth,
      borderTopColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
    };
  };
  const panel = document.querySelector('[data-testid="node-panel-body"]');
  const card = document.querySelector('[data-testid="claude-central-pool-card"]');
  const nodeCard = document.querySelector('[data-testid="node-card"]');
  const nodeList = document.querySelector('[data-testid="node-card-list"]');
  const header = card?.querySelector('[data-testid="claude-central-pool-header"]');
  const nodeHeader = nodeCard?.firstElementChild;
  const accountEmail = '[data-testid="claude-central-pool-card"] .c724-pool-account-item .c724-account-email';
  const emails = Array.from(document.querySelectorAll(accountEmail)).map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      text: text(element),
      userSelect: style.userSelect,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      lineRects: element.getClientRects().length,
      left: round(box.left),
      right: round(box.right),
    };
  });
  const toggleOf = (root) => root
    ? Array.from(root.querySelectorAll('button')).find((item) => ['펼치기', '접기'].includes(item.getAttribute('aria-label') ?? '')) ?? null
    : null;
  const receiveRow = document.querySelector('[data-testid="claude-central-receive"]');
  const receiveBody = receiveRow?.closest('.c724-pool-account-body');
  const accountList = receiveBody?.querySelector('.c724-account-list');
  const receiveSwitch = receiveRow?.querySelector('[data-testid="claude-central-receive-switch"]');
  const receiveLine = receiveRow?.querySelector('.c724-account-top');
  const receiveErrors = receiveRow ? Array.from(receiveRow.querySelectorAll('.c724-pool-error')) : [];
  const sheet = document.querySelector('[data-testid="claude-login-sheet"]');
  const sheetInput = sheet?.querySelector('input[aria-label="Claude 인증 코드"]');
  const pendingRow = card?.querySelector('[data-provider-id="claude"][data-state="pending"]');
  const skeleton = pendingRow?.querySelector('[data-testid="provider-quota-skeleton"]');
  const errorRow = document.querySelector('[data-testid="claude-central-list-error"]');
  const active = document.activeElement;
  const overflow = [];
  if (card) {
    const cardBox = card.getBoundingClientRect();
    card.querySelectorAll('*').forEach((element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1) return;
      if (box.right > cardBox.right + 1 || box.left < cardBox.left - 1) {
        overflow.push({
          tag: element.tagName,
          className: String(element.className).slice(0, 80),
          text: text(element).slice(0, 40),
          left: round(box.left),
          right: round(box.right),
        });
      }
    });
  }
  return {
    hasPanel: !!panel,
    hasCard: !!card,
    hasNodeCard: !!nodeCard,
    firstChildTestId: panel?.firstElementChild?.getAttribute('data-testid') ?? null,
    card: card ? rect(card) : null,
    nodeCard: nodeCard ? rect(nodeCard) : null,
    cardStyle: card ? frameStyle(card) : null,
    nodeCardStyle: nodeCard ? frameStyle(nodeCard) : null,
    header: header ? {
      ...rect(header),
      text: text(header),
      buttons: header.querySelectorAll('button').length,
      expanded: header.getAttribute('aria-expanded'),
      statusDot: !!header.querySelector('.c724-status-dot'),
      toggle: (() => {
        const button = toggleOf(header);
        return button ? {
          tag: button.tagName,
          type: button.getAttribute('type'),
          ariaLabel: button.getAttribute('aria-label'),
          ariaExpanded: button.getAttribute('aria-expanded'),
          text: text(button),
          tabIndex: button.tabIndex,
        } : null;
      })(),
    } : null,
    nodeHeader: nodeHeader ? {
      ...rect(nodeHeader),
      expanded: nodeHeader.getAttribute('aria-expanded'),
      toggle: (() => {
        const button = toggleOf(nodeHeader);
        return button ? {
          tag: button.tagName,
          type: button.getAttribute('type'),
          ariaLabel: button.getAttribute('aria-label'),
          ariaExpanded: button.getAttribute('aria-expanded'),
          text: text(button),
          tabIndex: button.tabIndex,
        } : null;
      })(),
    } : null,
    gapCentralToList: card && nodeList
      ? round(nodeList.getBoundingClientRect().top - card.getBoundingClientRect().bottom)
      : null,
    centralSummary: text(card?.querySelector('.c724-pool-summary')),
    centralRows: card ? card.querySelectorAll('.c724-pool-account-item').length : null,
    centralAddButton: card
      ? Array.from(card.querySelectorAll('button')).some((item) => text(item).includes('계정 추가'))
      : null,
    nodeText: nodeCard ? (nodeCard.innerText ?? '').trim() : '',
    emails,
    receive: receiveRow ? {
      dataReceive: receiveRow.getAttribute('data-receive'),
      firstChild: receiveBody?.firstElementChild === receiveRow,
      beforeAccountList: !!(accountList
        && (receiveRow.compareDocumentPosition(accountList) & Node.DOCUMENT_POSITION_FOLLOWING)),
      label: text(receiveRow.querySelector('.c724-account-email')),
      switchPresent: !!receiveSwitch,
      checked: receiveSwitch?.getAttribute('aria-checked') ?? null,
      disabled: receiveSwitch
        ? receiveSwitch.hasAttribute('disabled') || receiveSwitch.getAttribute('data-disabled') !== null
        : null,
      error: text(receiveRow.querySelector('.c724-pool-error')),
      retryButtons: Array.from(receiveRow.querySelectorAll('button'))
        .filter((item) => text(item).includes('다시 시도')).length,
      accountRows: receiveBody?.querySelectorAll('.c724-pool-account-item').length ?? 0,
      rect: rect(receiveRow),
      topLineHeight: receiveLine ? round(receiveLine.getBoundingClientRect().height) : null,
      errorBelowLine: !!receiveLine && receiveErrors.length > 0 && receiveErrors.every((element) =>
        element.getBoundingClientRect().top >= receiveLine.getBoundingClientRect().bottom - 0.5),
    } : null,
    listError: errorRow ? {
      text: text(errorRow.querySelector('.c724-pool-error')),
      retryButtons: Array.from(errorRow.querySelectorAll('button'))
        .filter((item) => text(item).includes('다시 시도')).length,
    } : null,
    pending: pendingRow ? {
      skeleton: !!skeleton,
      tracks: skeleton?.querySelectorAll('.c724-quota-track').length ?? 0,
      height: round(pendingRow.getBoundingClientRect().height),
    } : null,
    sheet: sheet ? {
      state: sheet.getAttribute('data-login-state'),
      text: text(sheet).slice(0, 200),
      rect: rect(sheet),
      link: sheet.querySelector('.c724-login-open-link')?.getAttribute('href') ?? null,
      inputPresent: !!sheetInput,
      inputDisabled: sheetInput?.disabled ?? null,
      inputValue: sheetInput?.value ?? null,
      error: text(sheet.querySelector('.c724-login-error [data-v3-selectable-content="true"]')),
      alert: text(sheet.querySelector('[role="alert"]')),
      hasRetryCode: Array.from(sheet.querySelectorAll('button'))
        .some((item) => text(item) === '다시 확인'),
      badge: text(sheet.querySelector('.c724-login-state-row .c724-badge')),
    } : null,
    active: active ? {
      tag: active.tagName,
      text: text(active).slice(0, 40),
      ariaLabel: active.getAttribute?.('aria-label') ?? null,
      inCard: !!active.closest?.('[data-testid="claude-central-pool-card"]'),
      inSheet: !!active.closest?.('[data-testid="claude-login-sheet"]'),
      inNodeCard: !!active.closest?.('[data-testid="node-card"]'),
    } : null,
    text: card ? (card.innerText ?? '').trim() : '',
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      scrollY: round(window.scrollY),
    },
    overflow: overflow.slice(0, 12),
  };
}
"""

FOCUS_SCRIPT = """
() => {
  const active = document.activeElement;
  if (!active) return null;
  return {
    tag: active.tagName,
    text: (active.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    ariaLabel: active.getAttribute?.('aria-label') ?? null,
    inCard: !!active.closest?.('[data-testid="claude-central-pool-card"]'),
    inSheet: !!active.closest?.('[data-testid="claude-login-sheet"]'),
    inNodeCard: !!active.closest?.('[data-testid="node-card"]'),
  };
}
"""


def install_page(context, theme: str) -> None:
    context.add_init_script(INIT_SCRIPT.replace("__THEME__", theme))
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


def goto_scene(page: Page, base: str, scene: str) -> None:
    if "/components?sample=claude-central" in page.url:
        # 검수 표본이 주소의 scene을 따라가므로 페이지를 다시 적재하지 않고 장면만 바꾼다.
        page.evaluate(
            """(scene) => {
              const url = new URL(window.location.href);
              url.searchParams.set('sample', 'claude-central');
              url.searchParams.set('scene', scene);
              history.pushState({}, '', url);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }""",
            scene,
        )
    else:
        page.goto(f"{base}/components?sample=claude-central&scene={scene}")
    page.wait_for_selector(f'[data-scene="{scene}"]', state="visible")
    settle(page)
    page.get_by_test_id("claude-central-review").wait_for(state="visible")


def open_central(page: Page) -> None:
    # 카드 머리는 div다. 노드 카드와 같은 틀이라 같은 방식으로 누른다.
    page.get_by_test_id("claude-central-pool-header").click(force=True)


def expand_node(page: Page) -> None:
    page.get_by_test_id("node-card").first.locator("div").first.click(force=True)
    page.get_by_test_id("claude-pool-row").wait_for(state="visible")


def expand_node_pool(page: Page) -> None:
    page.get_by_test_id("node-card").first.get_by_role("button", name="계정 펼치기").click(force=True)
    page.wait_for_selector(".c724-pool-account-body", state="visible")


def measure(page: Page) -> dict:
    return page.evaluate(MEASURE_SCRIPT)


def capture(page: Page, path: Path, key: str, captures: list[dict]) -> dict:
    page.evaluate("() => document.fonts.ready")
    page.screenshot(path=str(path), animations="disabled")
    page.wait_for_timeout(120)
    data = measure(page)
    captures.append({"capture": key, "measure": data})
    print(f"{key}: {path.as_posix()}", flush=True)
    return data


def central_present(page: Page) -> bool:
    return page.locator('[data-testid="claude-central-pool-card"]').count() > 0


def open_scene(page: Page, base: str, scene: str, kind: str) -> None:
    goto_scene(page, base, scene)
    # 고치기 전 코드에서는 카드 자체가 없다. 장면을 그대로 찍고 단언이 실패를 보고하게 둔다.
    if kind in ("central", "loading", "failure", "login") and not central_present(page):
        return
    if kind == "central" or kind == "loading" or kind == "failure":
        open_central(page)
        if kind == "central":
            page.get_by_test_id("claude-pool-row").wait_for(state="visible")
            page.get_by_role("button", name="계정 펼치기").click(force=True)
            page.wait_for_selector(
                '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
            )
        elif kind == "loading":
            page.wait_for_selector('[data-testid="claude-central-pool-card"] [data-state="pending"]', state="visible")
        else:
            page.get_by_test_id("claude-central-list-error").wait_for(state="visible")
    elif kind == "login":
        open_central(page)
        page.get_by_test_id("claude-pool-row").wait_for(state="visible")
        page.get_by_role("button", name="계정 펼치기").click(force=True)
        page.wait_for_selector(
            '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
        )
        page.get_by_role("button", name="계정 추가").click(force=True)
        page.get_by_test_id("claude-login-sheet").wait_for(state="visible")
        if scene != "login-url-ready":
            page.get_by_label("Claude 인증 코드").fill("review-code#review-state")
            page.get_by_role("button", name="확인", exact=True).click(force=True)
            expected = "verifying" if scene == "login-verifying" else "failed"
            page.wait_for_selector(
                f'[data-testid="claude-login-sheet"][data-login-state="{expected}"]', state="visible"
            )
    elif kind == "receive":
        expand_node(page)
        expand_node_pool(page)
        if not page.locator('[data-testid="claude-central-receive"]').count():
            return
        if scene == "receive-settings-error":
            page.wait_for_selector('[data-testid="claude-central-receive"] .c724-pool-error', state="visible")
        else:
            page.wait_for_function(
                """(expected) => document.querySelector('[data-testid="claude-central-receive"]')
                  ?.getAttribute('data-receive') === expected""",
                arg="off" if scene == "receive-off" else "on",
            )
    elif kind == "node-invariant":
        expand_node(page)
        page.get_by_test_id("claude-pool-row").wait_for(state="visible")
    else:
        raise ValueError(kind)


def run_interactions(page: Page, base: str, out: Path, width: int, theme: str, captures: list[dict]) -> dict:
    """ui-design 0절 14·15·18번을 실제 조작으로 잰다."""
    result: dict = {"width": width, "theme": theme}

    # 14·15: 시트를 열면 첫 입력에 초점, Esc로 닫고 연 단추로 초점 복귀.
    goto_scene(page, base, "login-url-ready")
    if not central_present(page):
        result["absent"] = True
        return result
    open_central(page)
    page.get_by_test_id("claude-pool-row").wait_for(state="visible")
    page.get_by_role("button", name="계정 펼치기").click(force=True)
    # 빈 목록에서는 몸통 높이가 0이라 visible을 기다리면 멈춘다. 붙었는지만 본다.
    page.wait_for_selector(
        '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
    )
    opener = page.get_by_role("button", name="계정 추가")
    opener.click(force=True)
    page.get_by_test_id("claude-login-sheet").wait_for(state="visible")
    page.wait_for_timeout(200)
    focus_open = page.evaluate(FOCUS_SCRIPT)
    page.evaluate("() => document.fonts.ready")
    path = out / f"central-pool-login-focus-{width}-{theme}.png"
    page.screenshot(path=str(path), animations="disabled")
    print(f"login-focus-{width}-{theme}: {path.as_posix()}", flush=True)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    focus_close = page.evaluate(FOCUS_SCRIPT)
    result["focus"] = {
        "afterOpen": focus_open,
        "afterEscape": focus_close,
        "sheetOpenAfterEscape": page.locator('[data-testid="claude-login-sheet"]').count(),
    }

    # 15: 펼친 중앙 카드에서 Tab이 카드 안에서 시작하고, 가려진 요소에 초점이 가지 않는다.
    goto_scene(page, base, "accounts")
    open_central(page)
    page.get_by_test_id("claude-pool-row").wait_for(state="visible")
    page.get_by_role("button", name="계정 펼치기").click(force=True)
    # 빈 목록에서는 몸통 높이가 0이라 visible을 기다리면 멈춘다. 붙었는지만 본다.
    page.wait_for_selector(
        '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
    )
    page.evaluate("() => document.activeElement?.blur?.()")
    stops = []
    for _ in range(8):
        page.keyboard.press("Tab")
        stops.append(page.evaluate(FOCUS_SCRIPT))
    result["tabStops"] = stops

    # 머리 끝 ▲▼ 단추가 Tab으로 초점을 받고 Enter로 카드를 펼친다.
    # 이 장면은 중앙 카드가 펼쳐진 채로 시작한다. 키보드로 「펼치는」 것을 재려면 먼저 접는다.
    goto_scene(page, base, "accounts")
    if page.locator('[data-testid="claude-central-pool-header"] button[aria-label="접기"]').count():
        page.get_by_test_id("claude-central-pool-header").get_by_role("button", name="접기").click(force=True)
        page.wait_for_timeout(200)
    page.evaluate("() => document.activeElement?.blur?.()")
    keyboard: dict = {"tabs": None, "focus": None, "after": None, "rowVisible": 0}
    for index in range(1, 26):
        page.keyboard.press("Tab")
        focus = page.evaluate(FOCUS_SCRIPT)
        if focus and focus.get("ariaLabel") in ("펼치기", "접기") and focus.get("inCard"):
            keyboard["tabs"] = index
            keyboard["focus"] = focus
            break
    if keyboard["tabs"] is not None:
        page.evaluate("() => document.fonts.ready")
        path = out / f"central-pool-header-focus-{width}-{theme}.png"
        page.screenshot(path=str(path), animations="disabled")
        print(f"header-focus-{width}-{theme}: {path.as_posix()}", flush=True)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        keyboard["after"] = page.evaluate(
            """() => {
              const header = document.querySelector('[data-testid="claude-central-pool-header"]');
              return {
                expanded: header?.getAttribute('aria-expanded') ?? null,
                button: !!header?.querySelector('button[aria-label="접기"]'),
                focusInCard: !!document.activeElement?.closest?.('[data-testid="claude-central-pool-card"]'),
              };
            }"""
        )
        keyboard["rowVisible"] = page.locator('[data-testid="claude-pool-row"]').count()
    result["keyboard"] = keyboard

    # 18: 입력 중인 글과 배치가 창을 줄여도 유지된다.
    goto_scene(page, base, "login-url-ready")
    open_central(page)
    page.get_by_test_id("claude-pool-row").wait_for(state="visible")
    page.get_by_role("button", name="계정 펼치기").click(force=True)
    # 빈 목록에서는 몸통 높이가 0이라 visible을 기다리면 멈춘다. 붙었는지만 본다.
    page.wait_for_selector(
        '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
    )
    page.get_by_role("button", name="계정 추가").click(force=True)
    page.get_by_test_id("claude-login-sheet").wait_for(state="visible")
    page.get_by_label("Claude 인증 코드").fill("review-code#review-state")
    before = measure(page)
    page.set_viewport_size({"width": 390, "height": 1400})
    page.wait_for_timeout(400)
    page.evaluate("() => document.fonts.ready")
    after = measure(page)
    path = out / f"central-pool-resize-{width}-{theme}.png"
    page.screenshot(path=str(path), animations="disabled")
    print(f"resize-{width}-{theme}: {path.as_posix()}", flush=True)
    result["resize"] = {
        "before": {
            "card": before["card"],
            "document": before["document"],
            "inputValue": before["sheet"]["inputValue"] if before["sheet"] else None,
        },
        "after": {
            "card": after["card"],
            "document": after["document"],
            "inputValue": after["sheet"]["inputValue"] if after["sheet"] else None,
            "firstChildTestId": after["firstChildTestId"],
            "overflow": after["overflow"],
        },
    }
    page.set_viewport_size({"width": width, "height": 1000 if width >= 1280 else 1400})
    return result


def collect_captures(
    page: Page,
    base: str,
    out: Path,
    width: int,
    theme: str,
    captures: list[dict],
) -> None:
    for label, scene, kind in SCENES:
        open_scene(page, base, scene, kind)
        # 고치기 전 코드에는 스위치가 없다. 장면은 찍고 단언이 실패를 보고하게 둔다.
        has_switch = page.locator('[data-testid="claude-central-receive-switch"]').count() > 0
        receive_line_before = None
        if label == "receive-failure" and has_switch:
            # 실패 안내가 줄 아래에 서도 줄 높이는 그대로여야 목록이 밀리지 않는다.
            receive_line_before = page.evaluate(
                """() => {
                  const line = document.querySelector('[data-testid="claude-central-receive"] .c724-account-top');
                  return line ? Math.round(line.getBoundingClientRect().height * 10) / 10 : null;
                }"""
            )
        if label == "receive-pending" and has_switch:
            page.get_by_test_id("claude-central-receive-switch").click(force=True)
            page.wait_for_function(
                """() => {
                  const toggle = document.querySelector('[data-testid="claude-central-receive-switch"]');
                  return !!toggle && toggle.getAttribute('aria-checked') === 'false'
                    && (toggle.hasAttribute('disabled') || toggle.getAttribute('data-disabled') !== null);
                }""",
                timeout=5000,
            )
        elif label == "receive-failure" and has_switch:
            page.get_by_test_id("claude-central-receive-switch").click(force=True)
            page.wait_for_selector('[data-testid="claude-central-receive"] .c724-pool-error', state="visible")
            page.wait_for_timeout(200)
        data = capture(page, out / f"central-pool-{label}-{width}-{theme}.png", f"{label}-{width}-{theme}", captures)
        if receive_line_before is not None:
            data["receiveLineHeightBefore"] = receive_line_before


def run_overflow(page: Page, base: str, out: Path, theme: str, captures: list[dict]) -> dict:
    page.set_viewport_size({"width": OVERFLOW_WIDTH, "height": 1600})
    page.wait_for_timeout(200)
    goto_scene(page, base, "accounts")
    if central_present(page):
        open_central(page)
        page.get_by_test_id("claude-pool-row").wait_for(state="visible")
        page.get_by_role("button", name="계정 펼치기").click(force=True)
        # 빈 목록에서는 몸통 높이가 0이라 visible을 기다리면 멈춘다. 붙었는지만 본다.
        page.wait_for_selector(
            '[data-testid="claude-central-pool-card"] .c724-pool-account-body', state="attached"
        )
    data = capture(
        page,
        out / f"central-pool-overflow-{OVERFLOW_WIDTH}-{theme}.png",
        f"overflow-{OVERFLOW_WIDTH}-{theme}",
        captures,
    )
    return data


def compare_frame(capture: dict) -> list[dict]:
    data = capture["measure"]
    failures = []
    if not data["hasCard"]:
        failures.append({"capture": capture["capture"], "check": "card-present", "detail": "중앙 카드를 찾지 못했습니다."})
        return failures
    if data["firstChildTestId"] != "claude-central-pool-card":
        failures.append({
            "capture": capture["capture"],
            "check": "card-first",
            "detail": f"node-panel-body의 첫 자식이 {data['firstChildTestId']}입니다.",
        })
    if data["cardStyle"] != data["nodeCardStyle"]:
        failures.append({
            "capture": capture["capture"],
            "check": "frame-parity",
            "detail": f"중앙 {data['cardStyle']} / 노드 {data['nodeCardStyle']}",
        })
    if data["card"] and data["nodeCard"]:
        for edge in ("left", "right"):
            delta = abs(data["card"][edge] - data["nodeCard"][edge])
            if delta > TOLERANCE_PX:
                failures.append({
                    "capture": capture["capture"],
                    "check": f"edge-{edge}",
                    "detail": f"차이 {delta}px",
                })
    if data["header"] is None or data["nodeHeader"] is None:
        failures.append({"capture": capture["capture"], "check": "header-present", "detail": "머리를 찾지 못했습니다."})
    else:
        # 노드 카드를 펼치면 그 머리에 요약 줄이 붙어 높이가 커진다. 같은 틀인지는 접힌 머리끼리 잰다.
        if data["nodeHeader"]["expanded"] != "true":
            delta = abs(data["header"]["height"] - data["nodeHeader"]["height"])
            if delta > TOLERANCE_PX:
                failures.append({"capture": capture["capture"], "check": "header-height", "detail": f"차이 {delta}px"})
        expected = "중앙 풀▲" if data["header"]["expanded"] == "true" else "중앙 풀▼"
        if data["header"]["text"] != expected:
            failures.append({
                "capture": capture["capture"],
                "check": "header-title-only",
                "detail": f"머리 글이 {data['header']['text']!r}입니다.",
            })
        if data["header"]["statusDot"]:
            failures.append({
                "capture": capture["capture"],
                "check": "header-no-status-dot",
                "detail": "머리에 상태 점이 있습니다.",
            })
        # 머리 끝 ▲▼는 키보드로 눌리는 단추다. 머리 전체 클릭은 마우스용으로 남는다.
        toggle = data["header"].get("toggle")
        expected_label = "접기" if data["header"]["expanded"] == "true" else "펼치기"
        expected_glyph = "▲" if data["header"]["expanded"] == "true" else "▼"
        if data["header"]["buttons"] != 1:
            failures.append({
                "capture": capture["capture"],
                "check": "header-button-count",
                "detail": f"머리 단추 {data['header']['buttons']}개",
            })
        if not toggle:
            failures.append({
                "capture": capture["capture"],
                "check": "header-toggle",
                "detail": "머리 끝의 펼치기 단추를 찾지 못했습니다.",
            })
        else:
            if toggle["tag"] != "BUTTON" or toggle["type"] != "button":
                failures.append({
                    "capture": capture["capture"],
                    "check": "header-toggle-element",
                    "detail": f"{toggle['tag']} type={toggle['type']}",
                })
            if toggle["ariaLabel"] != expected_label:
                failures.append({
                    "capture": capture["capture"],
                    "check": "header-toggle-label",
                    "detail": f"aria-label {toggle['ariaLabel']!r}",
                })
            if toggle["ariaExpanded"] != data["header"]["expanded"]:
                failures.append({
                    "capture": capture["capture"],
                    "check": "header-toggle-expanded",
                    "detail": f"aria-expanded {toggle['ariaExpanded']!r}",
                })
            if toggle["text"] != expected_glyph:
                failures.append({
                    "capture": capture["capture"],
                    "check": "header-toggle-glyph",
                    "detail": f"글리프 {toggle['text']!r}",
                })
            if toggle["tabIndex"] < 0:
                failures.append({
                    "capture": capture["capture"],
                    "check": "header-toggle-tabindex",
                    "detail": f"tabIndex {toggle['tabIndex']}",
                })
    if data["nodeHeader"] is not None and not data["nodeHeader"].get("toggle"):
        failures.append({
            "capture": capture["capture"],
            "check": "node-header-toggle",
            "detail": "노드 카드 머리에 펼치기 단추가 없습니다.",
        })
    if data["gapCentralToList"] is None or abs(data["gapCentralToList"] - CARD_GAP_PX) > 0.5:
        failures.append({
            "capture": capture["capture"],
            "check": "card-gap",
            "detail": f"카드 사이 {data['gapCentralToList']}px",
        })
    if data["document"]["scrollWidth"] > data["document"]["innerWidth"] + 1:
        failures.append({
            "capture": capture["capture"],
            "check": "no-horizontal-overflow",
            "detail": f"문서 폭 {data['document']['scrollWidth']} > 창 {data['document']['innerWidth']}",
        })
    if data["overflow"]:
        failures.append({
            "capture": capture["capture"],
            "check": "card-inner-overflow",
            "detail": data["overflow"],
        })
    return failures


def email_checks(capture: dict) -> list[dict]:
    failures = []
    emails = capture["measure"]["emails"]
    if not emails:
        failures.append({"capture": capture["capture"], "check": "central-emails", "detail": "계정 이메일이 없습니다."})
        return failures
    lefts = [entry["left"] for entry in emails]
    if max(lefts) - min(lefts) > TOLERANCE_PX:
        failures.append({
            "capture": capture["capture"],
            "check": "email-startline",
            "detail": f"시작선 차이 {round(max(lefts) - min(lefts), 1)}px",
        })
    for entry in emails:
        if entry["userSelect"] != "text":
            failures.append({
                "capture": capture["capture"],
                "check": "email-selectable",
                "detail": f"{entry['text']} user-select={entry['userSelect']}",
            })
        if entry["lineRects"] != 1:
            failures.append({
                "capture": capture["capture"],
                "check": "email-single-line",
                "detail": f"{entry['text']} 줄 상자 {entry['lineRects']}개",
            })
        truncated = entry["scrollWidth"] > entry["clientWidth"] + 1
        if truncated and entry["textOverflow"] != "ellipsis":
            failures.append({
                "capture": capture["capture"],
                "check": "email-ellipsis",
                "detail": f"{entry['text']}가 잘리는데 말줄임이 없습니다.",
            })
        if entry["clientWidth"] <= 0:
            failures.append({
                "capture": capture["capture"],
                "check": "email-width",
                "detail": f"{entry['text']} 폭 0",
            })
    if LONG_EMAIL not in [entry["text"] for entry in emails] and capture["capture"].startswith(("central-accounts-", "central-login-")):
        failures.append({
            "capture": capture["capture"],
            "check": "long-email-fixture",
            "detail": f"허용된 가장 긴 이메일 {LONG_EMAIL}이 목록에 없습니다.",
        })
    return failures


def scene_checks(label: str, capture: dict) -> list[dict]:
    data = capture["measure"]
    failures: list[dict] = []
    name = capture["capture"]

    def fail(check: str, detail) -> None:
        failures.append({"capture": name, "check": check, "detail": detail})

    if label.startswith("central-") or label == "node-card-invariant":
        failures.extend(compare_frame(capture))

    if label == "central-empty":
        if data["centralRows"] != 0:
            fail("empty-rows", f"빈 상태 계정 {data['centralRows']}개")
        if data["centralSummary"] != "0/0 가용":
            fail("empty-summary", f"요약 {data['centralSummary']!r}")
    elif label.startswith("central-") and label not in ("central-loading", "central-failure"):
        if data["centralRows"] != 3:
            fail("account-count", f"계정 {data['centralRows']}개")
        failures.extend(email_checks(capture))
        if not data["centralAddButton"]:
            fail("add-button", "계정 추가 단추가 없습니다.")
    elif label == "central-loading":
        if not data["pending"] or not data["pending"]["skeleton"]:
            fail("loading-skeleton", "중앙 목록 로딩 스켈레톤이 없습니다.")
        elif data["pending"]["tracks"] < 1:
            fail("loading-tracks", "스켈레톤에 게이지 막대가 없습니다.")
        if data["pending"] and data["pending"]["height"] < 24:
            fail("loading-height", f"로딩 행 높이 {data['pending']['height']}px")
    elif label == "central-failure":
        if not data["listError"] or not data["listError"]["text"]:
            fail("failure-copy", "실패 안내 글이 없습니다.")
        elif data["listError"]["retryButtons"] != 1:
            fail("failure-retry", f"다시 시도 단추 {data['listError']['retryButtons']}개")

    if label.startswith("central-login-"):
        expected = label.removeprefix("central-login-")
        sheet = data["sheet"]
        if not sheet:
            fail("sheet-present", "로그인 시트가 없습니다.")
        else:
            if sheet["state"] != expected.replace("-", "_"):
                fail("sheet-state", f"시트 상태 {sheet['state']!r}")
            if sheet["rect"]["left"] < (data["card"]["left"] - TOLERANCE_PX) or sheet["rect"]["right"] > (data["card"]["right"] + TOLERANCE_PX):
                fail("sheet-within-card", f"시트 {sheet['rect']} / 카드 {data['card']}")
            if expected == "url-ready":
                if not sheet["link"]:
                    fail("sheet-link", "인증 페이지 링크가 없습니다.")
                if not sheet["inputPresent"]:
                    fail("sheet-input", "인증 코드 입력이 없습니다.")
            if expected == "verifying":
                if sheet["badge"] != "확인 중":
                    fail("sheet-badge", f"배지 {sheet['badge']!r}")
                if sheet["inputDisabled"] is not True:
                    fail("sheet-input-disabled", "확인 중인데 코드 입력이 눌립니다.")
            if expected == "failed":
                if not sheet["error"]:
                    fail("sheet-error", "실패 안내가 없습니다.")
                if not sheet["hasRetryCode"]:
                    fail("sheet-retry", "다시 확인 단추가 없습니다.")

    if label.startswith("receive-"):
        receive = data["receive"]
        if not receive:
            fail("receive-row", "받기 줄이 없습니다.")
        else:
            if receive["label"] != "중앙 풀 받기":
                fail("receive-label", f"줄 글 {receive['label']!r}")
            if not receive["firstChild"]:
                fail("receive-first", "받기 줄이 목록 맨 위가 아닙니다.")
            if not receive["beforeAccountList"]:
                fail("receive-before-list", "받기 줄이 계정 목록 뒤에 있습니다.")
        if label == "receive-settings-error":
            if receive and receive["switchPresent"]:
                fail("settings-error-switch", "설정을 못 읽는데 스위치가 있습니다.")
            if not receive or not receive["error"]:
                fail("settings-error-copy", "설정 실패 안내가 없습니다.")
            if not receive or receive["retryButtons"] < 1:
                fail("settings-error-retry", "설정 다시 시도가 없습니다.")
        elif label == "receive-on":
            if receive and receive["checked"] != "true":
                fail("receive-checked", f"스위치 {receive['checked']}")
            if receive and receive["accountRows"] != 0:
                fail("receive-local-none", f"로컬 계정 {receive['accountRows']}개")
            # 노드가 준 머리 요약은 중앙 계정까지 셈한 값이어야 한다.
            if "1/3 가용" not in data["nodeText"]:
                fail("receive-server-summary", f"머리 요약이 서버 값이 아닙니다: {data['nodeText'][:60]!r}")
        elif label == "receive-off":
            if receive and receive["checked"] != "false":
                fail("receive-unchecked", f"스위치 {receive['checked']}")
            if receive and receive["accountRows"] != 2:
                fail("receive-local-two", f"로컬 계정 {receive['accountRows']}개")
            if "3/5 가용" not in data["nodeText"]:
                fail("receive-server-summary", "머리 요약이 서버 값이 아닙니다.")
        elif label == "receive-pending":
            if receive and receive["checked"] != "false":
                fail("pending-value", f"기다리는 동안 스위치 {receive['checked']}")
            if receive and receive["disabled"] is not True:
                fail("pending-disabled", "기다리는 동안 스위치가 눌립니다.")
        elif label == "receive-failure":
            # 저장에 실패하면 스위치는 제자리에서 되돌아간 값을 보이며 눌린다. 다시 시도는 그 스위치를 다시 누르는 것이다.
            if receive and receive["dataReceive"] != "on":
                fail("failure-revert", f"실패 뒤 값 {receive['dataReceive']}")
            if not receive or not receive["switchPresent"]:
                fail("failure-switch-kept", "실패 뒤 스위치가 제자리에 없습니다.")
            elif receive["checked"] != "true":
                fail("failure-checked", f"실패 뒤 스위치 {receive['checked']}")
            elif receive["disabled"] is True:
                fail("failure-enabled", "실패 뒤 스위치가 눌리지 않습니다.")
            if receive and not receive["error"]:
                fail("failure-copy", "스위치 실패 안내가 없습니다.")
            if receive and receive["retryButtons"] > 0:
                fail("failure-no-retry", f"다시 시도 단추 {receive['retryButtons']}개")
            if receive and not receive["errorBelowLine"]:
                fail("failure-error-below", "오류 글이 받기 줄 아래에 있지 않습니다.")
            before = data.get("receiveLineHeightBefore")
            if before is not None and receive and receive["topLineHeight"] is not None:
                if abs(before - receive["topLineHeight"]) > 0.5:
                    fail("failure-line-height", f"줄 높이 {before}px → {receive['topLineHeight']}px")

    if label == "node-card-invariant":
        # 노드 카드만 펼친 모습이 지금과 같아야 한다. 중앙 카드는 접힌 채 남고, 노드 풀 줄을
        # 펼치기 전에는 받기 줄이 끼어들지 않는다. 머리 요약도 서버가 준 값 그대로다.
        if data["header"] and data["header"]["expanded"] != "false":
            fail("invariant-central-collapsed", "중앙 카드가 펼쳐져 있습니다.")
        if data["centralRows"] != 0:
            fail("invariant-central-rows", f"중앙 계정 {data['centralRows']}개")
        if data["receive"] is not None:
            fail("node-invariant", "노드 풀 줄을 펼치지 않았는데 받기 줄이 있습니다.")
        if "1/3 가용" not in data["nodeText"]:
            fail("invariant-node-summary", "노드 머리 요약이 서버 값이 아닙니다.")

    return failures


def interaction_checks(result: dict) -> list[dict]:
    failures: list[dict] = []
    key = f"{result['width']}-{result['theme']}"

    def fail(check: str, detail) -> None:
        failures.append({"capture": f"interaction-{key}", "check": check, "detail": detail})

    if result.get("absent"):
        fail("central-absent", "중앙 카드가 없어 조작을 재지 못했습니다.")
        return failures

    focus = result["focus"]
    if not focus["afterOpen"] or not focus["afterOpen"]["inSheet"]:
        fail("focus-open", f"시트를 열어도 초점이 시트에 없습니다: {focus['afterOpen']}")
    elif focus["afterOpen"]["ariaLabel"] != "Claude 인증 코드":
        fail("focus-open-input", f"첫 입력이 아닙니다: {focus['afterOpen']}")
    if focus["sheetOpenAfterEscape"] != 0:
        fail("escape-close", "Esc를 눌러도 시트가 남습니다.")
    after = focus["afterEscape"]
    if not after or after["text"] != "계정 추가" or after["inSheet"]:
        fail("focus-return", f"닫은 뒤 초점이 연 단추로 돌아오지 않았습니다: {after}")

    stops = result["tabStops"]
    for index, stop in enumerate(stops[:3]):
        if not stop or not stop["inCard"]:
            fail("tab-first", f"{index}번째 Tab 초점이 중앙 카드 밖입니다: {stop}")
    for index, stop in enumerate(stops):
        if stop is None:
            fail("tab-stop", f"{index}번째 Tab에서 초점이 사라졌습니다.")
            continue
        if stop["inSheet"]:
            fail("tab-hidden", f"{index}번째 Tab이 닫힌 시트로 들어갔습니다: {stop}")

    keyboard = result.get("keyboard") or {}
    if keyboard.get("tabs") is None:
        fail("header-toggle-tab", "Tab으로 머리 펼치기 단추에 닿지 못했습니다.")
    else:
        focus = keyboard.get("focus") or {}
        if focus.get("tag") != "BUTTON" or focus.get("ariaLabel") != "펼치기":
            fail("header-toggle-focus", f"머리 펼치기 단추가 아닙니다: {focus}")
        after = keyboard.get("after") or {}
        if after.get("expanded") != "true" or not after.get("button"):
            fail("header-toggle-enter", f"Enter로 펼치지 못했습니다: {after}")
        if not keyboard.get("rowVisible"):
            fail("header-toggle-row", "Enter로 펼친 뒤 중앙 목록 줄이 없습니다.")

    resize = result["resize"]
    if resize["before"]["inputValue"] != "review-code#review-state":
        fail("resize-input-before", f"줄이기 전 입력값 {resize['before']['inputValue']!r}")
    if resize["after"]["inputValue"] != "review-code#review-state":
        fail("resize-input-after", f"줄인 뒤 입력값 {resize['after']['inputValue']!r}")
    if resize["after"]["firstChildTestId"] != "claude-central-pool-card":
        fail("resize-order", f"줄인 뒤 첫 카드 {resize['after']['firstChildTestId']!r}")
    if resize["after"]["overflow"]:
        fail("resize-overflow", resize["after"]["overflow"])
    if resize["after"]["document"]["scrollWidth"] > resize["after"]["document"]["innerWidth"] + 1:
        fail("resize-document-overflow", resize["after"]["document"])
    if resize["after"]["card"] is None or resize["after"]["card"]["right"] > 391:
        fail("resize-card-bounds", f"카드 {resize['after']['card']}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="중앙 풀 카드와 받기 스위치 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument(
        "--width",
        type=int,
        choices=WIDTHS,
        help="한 폭만 잰다. 무거운 장면을 나눠 돌릴 때 쓴다. 결과 파일에 폭을 붙인다.",
    )
    parser.add_argument(
        "--theme",
        choices=THEMES,
        help="한 테마만 잰다. 무거운 장면을 나눠 돌릴 때 쓴다. 결과 파일에 테마를 붙인다.",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    captures: list[dict] = []
    interactions: list[dict] = []
    failures: list[dict] = []

    widths = (args.width,) if args.width else WIDTHS
    themes = (args.theme,) if args.theme else THEMES
    suffix = "".join(f"-{part}" for part in (args.width, args.theme) if part is not None)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in widths:
                for theme in themes:
                    context = browser.new_context(
                        viewport={"width": width, "height": 1000 if width >= 1280 else 1400},
                        color_scheme=theme,
                        reduced_motion="reduce",
                    )
                    install_page(context, theme)
                    page = context.new_page()
                    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
                    try:
                        collect_captures(page, base, out, width, theme, captures)
                        interactions.append(run_interactions(page, base, out, width, theme, captures))
                    except Exception as error:  # noqa: BLE001 - 장면 하나가 멈춰도 나머지를 재고 보고한다.
                        failures.append({
                            "capture": f"scene-{width}-{theme}",
                            "check": "scene-run",
                            "detail": str(error),
                        })
                    context.close()
            overflow_themes = (
                tuple(theme for theme in THEMES if args.theme in (None, theme))
                if args.width in (None, 1280) else ()
            )
            for theme in overflow_themes:
                context = browser.new_context(
                    viewport={"width": OVERFLOW_WIDTH, "height": 1600},
                    color_scheme=theme,
                    reduced_motion="reduce",
                )
                install_page(context, theme)
                page = context.new_page()
                try:
                    run_overflow(page, base, out, theme, captures)
                except Exception as error:  # noqa: BLE001
                    failures.append({
                        "capture": f"overflow-{OVERFLOW_WIDTH}-{theme}",
                        "check": "overflow-run",
                        "detail": str(error),
                    })
                context.close()
        finally:
            browser.close()

    for capture in captures:
        label = capture["capture"].rsplit("-", 2)[0]
        failures.extend(scene_checks(label, capture))
    for result in interactions:
        failures.extend(interaction_checks(result))

    # 360 폭 캡처도 같은 구조·넘침 단언을 받는다.
    for capture in captures:
        if capture["capture"].startswith(f"overflow-{OVERFLOW_WIDTH}-"):
            failures.extend(compare_frame(capture))
            failures.extend(email_checks(capture))

    report = {
        "baseUrl": base,
        "tolerancePx": TOLERANCE_PX,
        "captures": [{"capture": capture["capture"], "measure": capture["measure"]} for capture in captures],
        "interactions": interactions,
        "failures": failures,
        "passed": not failures,
    }
    (out / f"measurements{suffix}.json").write_text(
        json.dumps({"tolerancePx": TOLERANCE_PX, "captures": captures, "interactions": interactions},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out / f"report{suffix}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"캡처 {len(captures)}건, 조작 검사 {len(interactions)}건, 단언 실패 {len(failures)}건")
    if failures:
        for item in failures:
            print(f"- {item['capture']} [{item['check']}] {item['detail']}", file=sys.stderr)
        return 1
    print(
        "판정: 중앙 카드가 노드 목록 맨 위에서 노드 카드와 같은 틀·머리 높이·좌우 끝선을 지키고, "
        "계정 이메일이 한 줄 말줄임·선택 가능하며, 받기 스위치와 로그인 시트 상태가 기준본과 같고, "
        "360/390에서 가로 넘침이 없으며, 초점·Esc·창 크기 조작이 기대대로 동작한다"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

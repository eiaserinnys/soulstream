#!/usr/bin/env python3
"""설정 노드 구역 시각 검수 — 스크롤 주인, 노드별 cogito, 반려 1~7 보완 측정.

`/dialogues?sample=settings`의 노드 탭에서

  - 노드 목록 한가운데에 휠을 굴렸을 때 설정 상세 영역(.config-detail) 하나가 스크롤되는지
    (넓은 폭 1280, 좁은 폭 360),
  - 노드를 펼치면 사용량 패널 아래에 그 노드의 cogito 행이 서고, 목록 위 별도 cogito 카드가 없는지,
  - cogito 로딩(`cogitoState=loading`)과 실패(`cogitoState=failure`)가 같은 자리에서 바뀌는지,
  - ui-design 0절 14~18번(누른 뒤 초점, Tab 순서와 Esc, 360 폭 넘침, 오류 상태, 창 크기 바꾸기),
  - 반려 1~7: cogito 행의 점 크기와 시작선, 배지 규칙과 `.c724-badge` 기준값, 경고·진단 값 줄의
    글자 선택, 시각 표기(HH:MM 24시간), 360에서 진단 값 줄바꿈, 노드 구역 테두리 겹침, 360 이름 표시

를 캡처와 좌표로 잰다. 컴포넌트 검수 창(`/components?sample=claude-accounts`)의 NodePanel 실물도
같은 cogito 상태로 캡처한다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/settings_nodes.py \
        http://127.0.0.1:5173 /path/to/output

    # 운영 /cogito/briefs 응답(노드 4개)까지 보려면 settings_nodes_real.py 를 같은 서버로 돌린다.
    python3 -P unified-dashboard/scripts/visual-check/settings_nodes_real.py \
        http://127.0.0.1:5173 /path/to/output-real /path/to/real-cogito-briefs.json

    # 고치기 전(origin/main) 증거: 스크롤이 막혀 있음을 확인한다. 모드는 같은 스크립트로 잰다.
    python3 -P unified-dashboard/scripts/visual-check/settings_nodes.py \
        http://127.0.0.1:5174 /path/to/output-before --mode before

산출물

    {출력}/settings-nodes-collapsed-{1280,360}-{dark,light}.png   노드 탭 첫 화면(목록 위 cogito 카드 없음)
    {출력}/settings-nodes-expanded-{폭}-{테마}.png                 cogito 행을 화면 안으로 들인 펼친 노드
    {출력}/settings-nodes-card-expanded-{폭}-{테마}.png            펼친 노드 카드 전체(머리부터 cogito까지)
    {출력}/settings-nodes-scrolled-{폭}-{테마}.png                 목록 한가운데 휠 뒤 스크롤된 화면
    {출력}/settings-nodes-timeout-{폭}-{테마}.png                  경고(timeout) 행을 화면 안으로 들인 화면
    {출력}/settings-nodes-card-timeout-{폭}-{테마}.png             경고 행이 든 카드 전체
    {출력}/settings-nodes-loading-{폭}-{테마}.png                  cogito 로딩(같은 자리)
    {출력}/settings-nodes-card-loading-{폭}-{테마}.png             로딩 행이 든 카드 전체
    {출력}/settings-nodes-failure-{폭}-{테마}.png                  cogito 실패(같은 자리)
    {출력}/settings-nodes-card-failure-{폭}-{테마}.png             실패 행이 든 카드 전체
    {출력}/settings-nodes-zoom-startline-1280-dark.png            1280에서 cogito 행과 이웃 행의 시작선 확대
    {출력}/provider-review-cogito-{normal,loading,failure}-1280-dark.png  컴포넌트 검수 창
    {출력}/measurements.json   휠 스크롤 전후 scrollTop, 초점, Tab 순서, 넘침, 리사이즈, 1~7 측정
    {출력}/report.json         판정 묶음과 종합 결과

after 모드에서 휠 뒤 scrollTop이 늘지 않거나, 펼친 노드 안에 cogito 행이 없거나, 로딩·실패가 같은
자리에 서지 않거나, 360 폭에서 가로 넘침이 있거나, 1~7 측정이 어긋나면 종료 코드 1로 끝난다.
펼친 상태·로딩·실패 캡처는 cogito 행을 `scrollIntoView({block:'end'})`로 화면 안에 들인 뒤 찍고,
같은 폭·테마에서 세 상태의 캡처 sha256이 서로 달라야 한다. before 모드는 스크롤이 막혀
있음(delta 0)을 확인하면 0으로 끝난다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright

THEMES = ("dark", "light")
WIDE = 1280
NARROW = 360
SAMPLE_NODE = "sample-node"
SAMPLE_TIMEOUT_NODE = "sample-usage-node"
REVIEW_NODE = "sample-provider-pool"
SCROLL_DELTA_MIN_PX = 1.0
START_LABEL_DELTA_MAX_PX = 1.0
# 360에서 머리 줄의 이름이 받아야 하는 최소 폭. 시각 글·배지가 이름 자리를 먹던 23px 상태를 잡는다.
NAME_MIN_WIDTH_NARROW_PX = 100.0
NAME_TRUNCATION_TOLERANCE_PX = 0.2
TIME_PATTERN = re.compile(r"^(?:\S+) / (\d{2}:\d{2})$")
HEAD_TIME_PATTERN = re.compile(r"^(\d{2}:\d{2}) 갱신$")

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

INIT_SCRIPT = """
localStorage.setItem('soul-dashboard-theme', '__THEME__');
Object.defineProperty(navigator.serviceWorker, 'register', {
  configurable: true,
  value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
});
Object.defineProperty(navigator.serviceWorker, 'controller', { configurable: true, get: () => null });
"""

WHEEL_POINT_SCRIPT = """
() => {
  const round = (value) => Math.round(value * 10) / 10;
  const detail = document.querySelector('.config-detail');
  const list = document.querySelector('[data-testid="node-card-list"]');
  const detailBox = detail.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  // 목록 상자와 설정 상세의 보이는 영역이 겹치는 곳에서만 굴린다. 푸터가 덮는 아래쪽은 피한다.
  const top = Math.max(box.top, detailBox.top) + 8;
  const bottom = Math.min(box.bottom, detailBox.bottom, window.innerHeight) - 8;
  const y = Math.min(Math.max((top + bottom) / 2, top), Math.max(top, bottom));
  return {
    scrollTop: round(detail.scrollTop),
    scrollHeight: Math.round(detail.scrollHeight),
    clientHeight: Math.round(detail.clientHeight),
    point: { x: round(box.left + box.width / 2), y: round(y) },
  };
}
"""

SCROLL_TOP_SCRIPT = """
() => Math.round(document.querySelector('.config-detail').scrollTop * 10) / 10
"""

POINT_ELEMENT_SCRIPT = """
([x, y]) => {
  const element = document.elementFromPoint(x, y);
  return {
    tag: element?.tagName ?? null,
    testId: element?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
    text: (element?.textContent ?? '').trim().slice(0, 60),
  };
}
"""

FOCUS_SCRIPT = """
() => {
  const element = document.activeElement;
  if (!element) return null;
  return {
    tag: element.tagName,
    label: element.getAttribute('aria-label'),
    testId: element.getAttribute('data-testid'),
    text: (element.textContent ?? '').trim().slice(0, 40),
    insideDialog: Boolean(element.closest('[role="dialog"]')),
  };
}
"""

TAB_ORDER_SCRIPT = """
() => {
  const scope = document.querySelector('.config-detail');
  if (!scope) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...scope.querySelectorAll(selector)]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        left: Math.round(box.left),
        label: element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30),
      };
    });
}
"""

OVERFLOW_SCRIPT = """
() => {
  const overflow = (element) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
  return {
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    detailOverflowX: overflow(document.querySelector('.config-detail')),
    listOverflowX: overflow(document.querySelector('[data-testid="node-card-list"]')),
  };
}
"""

COGITO_SLOT_SCRIPT = """
() => {
  const rows = [...document.querySelectorAll('[data-testid="cogito-node-health"]')].map((row) => ({
    nodeId: row.getAttribute('data-node-id'),
    state: row.getAttribute('data-node-state'),
    text: (row.textContent ?? '').trim(),
    inCard: Boolean(row.closest('[data-testid="node-card"]')),
    afterProviders: (() => {
      const providers = row.closest('[data-testid="node-card"]')?.querySelector('[data-testid="node-providers-panel"]');
      if (!providers) return null;
      return Boolean(providers.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
  }));
  return {
    rows,
    panel: Boolean(document.querySelector('[data-testid="cogito-health-panel"]')),
    expandedCards: document.querySelectorAll('[data-testid="node-card"] [data-provider-id]').length,
  };
}
"""

# 반려 1~7 측정. 카드 하나를 받아 머리 줄, cogito 행, 이웃 사용량 행, 테두리 겹침을 한 번에 잰다.
DETAIL_JS = """
(card) => {
  const round = (value) => Math.round(value * 10) / 10;
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { x: round(box.left), y: round(box.top), w: round(box.width), h: round(box.height), r: round(box.right) };
  };
  const style = (element) => {
    const computed = getComputedStyle(element);
    return {
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
      fontWeight: computed.fontWeight,
      radius: computed.borderRadius,
      userSelect: computed.userSelect,
      whiteSpace: computed.whiteSpace,
      display: computed.display,
      overflow: computed.overflow,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      borderTopWidth: computed.borderTopWidth,
      borderTopStyle: computed.borderTopStyle,
    };
  };
  const textWidth = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return round(range.getBoundingClientRect().width);
  };

  const head = card.firstElementChild;
  const headChildren = [...head.children].map((element) => ({
    tag: element.tagName,
    cls: (element.className || '').slice(0, 120),
    text: (element.textContent || '').trim().slice(0, 40),
    ...rect(element),
    ...style(element),
    scrollW: element.scrollWidth,
    clientW: element.clientWidth,
  }));
  const nameElement = [...head.children].find((element) => element.tagName === 'SPAN' && element.className.includes('flex-auto')) || null;
  // 수집 지연 배지는 배지를 품은 상자로 감쌀 수 있으므로, 배지를 품지 않은 시각 글만 고른다.
  const timeElement = [...head.children].find((element) =>
    element.tagName === 'SPAN'
    && !element.className.includes('c724-badge')
    && !element.querySelector('.c724-badge')
    && /갱신/.test(element.textContent || '')
  ) || null;

  const row = card.querySelector('[data-testid="cogito-node-health"]');
  let rowData = null;
  if (row) {
    const top = row.querySelector('.c724-account-top');
    const identity = row.querySelector('.c724-account-identity');
    const dot = identity ? identity.firstElementChild : null;
    const label = row.querySelector('.c724-account-email');
    const badge = top ? [...top.querySelectorAll('span')].find((element) => (element.className || '').includes('c724-badge')) : null;
    const metas = [...row.children].filter((element) => element !== top).map((element) => ({
      tag: element.tagName,
      cls: element.className,
      text: (element.textContent || '').trim(),
      ...rect(element),
      ...style(element),
      scrollW: element.scrollWidth,
      clientW: element.clientWidth,
      textW: textWidth(element),
    }));

    // canonical `.c724-badge` 값을 같은 화면에서 만들어 비교한다(토큰이 바뀌어도 함께 움직인다).
    let badgeRef = null;
    if (top) {
      const probe = document.createElement('span');
      probe.className = 'c724-badge';
      probe.textContent = 'Timeout';
      probe.style.visibility = 'hidden';
      probe.style.position = 'absolute';
      top.appendChild(probe);
      badgeRef = {...rect(probe), ...style(probe)};
      probe.remove();
    }

    rowData = {
      state: row.getAttribute('data-node-state'),
      nodeId: row.getAttribute('data-node-id'),
      class: row.className,
      rect: rect(row),
      top: top ? rect(top) : null,
      dot: dot ? {...rect(dot), cls: dot.className} : null,
      label: label ? {...rect(label), text: label.textContent, ...style(label)} : null,
      badge: badge ? {...rect(badge), text: badge.textContent, cls: badge.className, ...style(badge)} : null,
      badgeRef,
      metas,
    };
  }

  const neighbors = [...card.querySelectorAll('[data-provider-id]')].map((neighbor) => {
    const identity = neighbor.querySelector('.c724-account-identity');
    const dot = identity ? identity.firstElementChild : null;
    const label = neighbor.querySelector('.c724-account-email');
    return {
      provider: neighbor.getAttribute('data-provider-id'),
      dot: dot ? {...rect(dot), cls: dot.className} : null,
      label: label ? {...rect(label), text: label.textContent} : null,
    };
  });

  const ancestors = [];
  let element = card.parentElement;
  while (element && !element.classList.contains('config-detail')) {
    const computed = getComputedStyle(element);
    ancestors.push({
      tag: element.tagName,
      cls: (element.className || '').slice(0, 80),
      borderTopWidth: computed.borderTopWidth,
      borderTopStyle: computed.borderTopStyle,
      radius: computed.borderRadius,
    });
    element = element.parentElement;
  }
  const usageRow = card.querySelector('[data-testid="node-providers-panel"] .c724-account-row');

  return {
    head: {
      rect: rect(head),
      children: headChildren,
      name: nameElement ? {
        text: nameElement.textContent,
        ...rect(nameElement),
        scrollW: nameElement.scrollWidth,
        clientW: nameElement.clientWidth,
        textW: textWidth(nameElement),
      } : null,
      time: timeElement ? {
        text: timeElement.textContent,
        ...rect(timeElement),
        ...style(timeElement),
      } : null,
    },
    row: rowData,
    neighbors,
    borders: {
      card: style(card),
      cardWidth: rect(card).w,
      usage: usageRow ? {...rect(usageRow), ...style(usageRow)} : null,
      ancestors,
    },
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


def open_settings_nodes(page: Page, base: str, cogito_state: str | None = None) -> None:
    query = "?sample=settings" + (f"&cogitoState={cogito_state}" if cogito_state else "")
    page.goto(f"{base}/dialogues{query}")
    settle(page)
    page.get_by_role("button", name="노드", exact=True).click()
    page.wait_for_selector('[data-testid="node-card-list"]', state="visible")


def card_for(page: Page, node_id: str) -> Locator:
    return page.get_by_test_id("node-card").filter(has_text=node_id).first


def expand_node(page: Page, node_id: str) -> None:
    # 같은 이름이 펼친 영역에도 있으므로 카드 머리 줄을 직접 누른다.
    card = card_for(page, node_id)
    card.locator("div").first.click()
    page.wait_for_selector("[data-provider-id]", state="visible")


def scroll_cogito_into_view(page: Page) -> None:
    # 이전 캡처가 화면 밖 cogito 행 때문에 같은 sha256이 되던 빈틈을 막는다.
    # 펼친 뒤 공급자 패널이 비동기로 자라면 `block: 'end'`만으로는 행이 푸터 아래로 밀린다.
    # 행 아래 끝이 설정 상세의 아래 끝을 넘은 만큼 scrollTop을 더 밀어 올린다.
    page.evaluate(
        """
        () => {
          const detail = document.querySelector('.config-detail');
          const row = document.querySelector('[data-testid="cogito-node-health"]');
          if (!detail || !row) return;
          row.scrollIntoView({block: 'end'});
          const rowBox = row.getBoundingClientRect();
          const detailBox = detail.getBoundingClientRect();
          const below = rowBox.bottom - detailBox.bottom;
          if (below > 0) detail.scrollTop += below;
        }
        """
    )
    page.wait_for_timeout(350)


def shot(page: Page, out: Path, name: str) -> str:
    page.evaluate("() => document.fonts.ready")
    path = out / f"{name}.png"
    page.screenshot(path=str(path), animations="disabled")
    print(f"{name}: {path.as_posix()}")
    return path.as_posix()


def card_shot(page: Page, out: Path, node_id: str, name: str) -> str:
    page.evaluate("() => document.fonts.ready")
    path = out / f"{name}.png"
    card_for(page, node_id).screenshot(path=str(path), animations="disabled")
    print(f"{name}: {path.as_posix()}")
    return path.as_posix()


def collect_detail(page: Page, node_id: str) -> dict:
    return card_for(page, node_id).evaluate(DETAIL_JS)


def selection_probe(page: Page, locator: Locator, name: str) -> dict:
    page.evaluate("() => window.getSelection().removeAllRanges()")
    count = locator.count()
    if count == 0:
        return {"name": name, "error": "no element"}
    target = locator.first
    box = target.bounding_box()
    if not box:
        return {"name": name, "error": "no box"}
    # 첫 낱말 안쪽을 찍는다. 낱말 사이 공백(예: "caps cogito")을 두 번 누르면 선택이 비어 버린다.
    x = box["x"] + min(6, box["width"] / 4)
    y = box["y"] + box["height"] / 2
    page.mouse.dblclick(x, y)
    page.wait_for_timeout(150)
    dbl = page.evaluate("() => window.getSelection().toString()").strip()
    page.evaluate("() => window.getSelection().removeAllRanges()")
    page.mouse.move(box["x"] + 2, y)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] - 4, y, steps=8)
    page.mouse.up()
    page.wait_for_timeout(150)
    drag = page.evaluate("() => window.getSelection().toString()").strip()
    user_select = target.evaluate("(element) => getComputedStyle(element).userSelect")
    page.evaluate("() => window.getSelection().removeAllRanges()")
    return {
        "name": name,
        "text": target.inner_text()[:80],
        "userSelect": user_select,
        "dblclickSelection": dbl[:80],
        "dragSelection": drag[:80],
    }


def row_locator(page: Page, node_id: str) -> Locator:
    return card_for(page, node_id).locator('[data-testid="cogito-node-health"]').first


def measure_selection(page: Page, node_id: str, detail: dict) -> dict:
    """경고·진단 값·오류 줄은 선택되고, 라벨과 배지는 선택되지 않는지 잰다."""
    row = row_locator(page, node_id)
    result: dict = {"nodeId": node_id, "lines": [], "label": None, "badge": None}
    meta_count = row.locator(".c724-meta-inline, .c724-pool-error").count()
    for index in range(meta_count):
        line = row.locator(".c724-meta-inline, .c724-pool-error").nth(index)
        text = (line.inner_text() or "").strip()
        kind = "error" if "c724-pool-error" in (line.get_attribute("class") or "") else "value"
        result["lines"].append(selection_probe(page, line, f"{kind}:{text[:30]}"))
    result["label"] = selection_probe(page, row.locator(".c724-account-email").first, "label")
    if row.locator(".c724-badge").count():
        result["badge"] = selection_probe(page, row.locator(".c724-badge").first, "badge")
    result["dot"] = row.locator(".c724-status-dot").count()
    return result


def wheel_measure(page: Page) -> dict:
    page.evaluate("() => { document.querySelector('.config-detail').scrollTop = 0; }")
    page.wait_for_timeout(200)
    state = page.evaluate(WHEEL_POINT_SCRIPT)
    point = state["point"]
    under = page.evaluate(POINT_ELEMENT_SCRIPT, [point["x"], point["y"]])
    page.mouse.move(point["x"], point["y"])
    page.wait_for_timeout(80)
    page.mouse.wheel(0, 700)
    page.wait_for_timeout(500)
    after = page.evaluate(SCROLL_TOP_SCRIPT)
    return {
        "before": state["scrollTop"],
        "after": after,
        "delta": round(after - state["scrollTop"], 1),
        "point": point,
        "underPoint": under,
        "scrollHeight": state["scrollHeight"],
        "clientHeight": state["clientHeight"],
    }


def order_ok(items: list[dict]) -> bool:
    for first, second in zip(items, items[1:]):
        if second["top"] < first["top"] - 1:
            return False
        if abs(second["top"] - first["top"]) <= 1 and second["left"] < first["left"] - 1:
            return False
    return True


def focus_check(page: Page) -> dict:
    refresh = page.get_by_role("button", name="사용량 새로 고침").first
    refresh.click()
    page.wait_for_timeout(500)
    focus = page.evaluate(FOCUS_SCRIPT)
    tab_items = page.evaluate(TAB_ORDER_SCRIPT)
    tab_sequence = []
    for _ in range(3):
        page.keyboard.press("Tab")
        page.wait_for_timeout(120)
        tab_sequence.append(page.evaluate(FOCUS_SCRIPT))
    dialog_open_before_escape = page.locator('[role="dialog"]').count() > 0
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    dialog_after_escape = page.locator('[role="dialog"]').count()
    return {
        "refreshFocus": focus,
        "tabOrderItems": tab_items,
        "tabOrderOk": order_ok(tab_items),
        "tabSequence": tab_sequence,
        "dialogOpenBeforeEscape": dialog_open_before_escape,
        "dialogCountAfterEscape": dialog_after_escape,
    }


def resize_check(page: Page) -> dict:
    detail_scrolled = page.evaluate(
        "() => { const detail = document.querySelector('.config-detail'); detail.scrollTop = 260; return detail.scrollTop; }"
    )
    page.wait_for_timeout(200)
    before = page.evaluate(OVERFLOW_SCRIPT)
    wide_slot = page.evaluate(COGITO_SLOT_SCRIPT)
    page.set_viewport_size({"width": NARROW, "height": 900})
    page.wait_for_timeout(600)
    narrow = page.evaluate(OVERFLOW_SCRIPT)
    narrow_slot = page.evaluate(COGITO_SLOT_SCRIPT)
    narrow_scroll = page.evaluate(SCROLL_TOP_SCRIPT)
    page.set_viewport_size({"width": WIDE, "height": 900})
    page.wait_for_timeout(600)
    wide_again = page.evaluate(OVERFLOW_SCRIPT)
    wide_again_slot = page.evaluate(COGITO_SLOT_SCRIPT)
    return {
        "requestedScrollTop": detail_scrolled,
        "wideOverflow": before,
        "narrowOverflow": narrow,
        "narrowScrollTop": narrow_scroll,
        "wideAgainOverflow": wide_again,
        "cogitoRowsWide": len(wide_slot["rows"]),
        "cogitoRowsNarrow": len(narrow_slot["rows"]),
        "cogitoRowsWideAgain": len(wide_again_slot["rows"]),
    }


def new_context(browser, width: int, theme: str):
    height = 900 if width == WIDE else 800
    context = browser.new_context(
        viewport={"width": width, "height": height},
        color_scheme=theme,
        reduced_motion="reduce",
        device_scale_factor=2 if width == NARROW else 1,
    )
    install_page(context, theme)
    return context


def run_after(browser, base: str, out: Path) -> tuple[dict, list[str]]:
    measurements: dict = {"widths": {}, "review": {}, "states": {}, "details": {}, "selection": {}}
    captures: list[str] = []
    state_captures: dict[str, dict[str, dict[str, str]]] = {}

    for width in (WIDE, NARROW):
        for theme in THEMES:
            key = f"{width}-{theme}"
            state_captures[key] = {}
            context = new_context(browser, width, theme)
            page = context.new_page()
            page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))

            open_settings_nodes(page, base)
            initial_focus = page.evaluate(FOCUS_SCRIPT)
            collapsed = page.evaluate(COGITO_SLOT_SCRIPT)
            captures.append(shot(page, out, f"settings-nodes-collapsed-{key}"))

            expand_node(page, SAMPLE_NODE)
            page.wait_for_selector('[data-testid="cogito-node-health"]', state="visible")
            page.wait_for_timeout(700)
            scroll_cogito_into_view(page)
            expanded = page.evaluate(COGITO_SLOT_SCRIPT)
            state_captures[key]["expanded"] = {
                "page": shot(page, out, f"settings-nodes-expanded-{key}"),
                "card": card_shot(page, out, SAMPLE_NODE, f"settings-nodes-card-expanded-{key}"),
            }
            expanded_overflow = page.evaluate(OVERFLOW_SCRIPT)
            measurements["details"].setdefault(key, {})["normal"] = collect_detail(page, SAMPLE_NODE)
            measurements["selection"].setdefault(key, {})["normal"] = measure_selection(page, SAMPLE_NODE, measurements["details"][key]["normal"])
            if width == WIDE and theme == "dark":
                row_box = row_locator(page, SAMPLE_NODE).bounding_box()
                previous_box = card_for(page, SAMPLE_NODE).locator('[data-provider-id]').last.bounding_box()
                if row_box and previous_box:
                    zoom = out / "settings-nodes-zoom-startline-1280-dark.png"
                    page.screenshot(
                        path=str(zoom),
                        clip={
                            "x": row_box["x"] - 4,
                            "y": previous_box["y"] - 4,
                            "width": 300,
                            "height": (row_box["y"] - previous_box["y"]) + 44,
                        },
                        animations="disabled",
                    )
                    captures.append(zoom.as_posix())
                    print(f"settings-nodes-zoom-startline-1280-dark: {zoom.as_posix()}")

            scroll = wheel_measure(page)
            captures.append(shot(page, out, f"settings-nodes-scrolled-{key}"))
            # 18은 창 크기를 바꿔도 펼침·스크롤이 남는지 먼저 재고, 14·15는 마지막에 Esc로 닫는다.
            resize = resize_check(page) if width == WIDE else None
            focus = focus_check(page) if width == WIDE else None
            if resize is not None:
                measurements["states"]["resize"] = resize

            measurements["widths"][key] = {
                "initialDialogFocus": initial_focus,
                "collapsed": collapsed,
                "expanded": expanded,
                "expandedOverflow": expanded_overflow,
                "scroll": scroll,
                "focusAndEscape": focus,
            }
            context.close()

            # 경고(timeout) 행: 배지·선택·줄바꿈·시작선은 이 행에서도 확인한다.
            context = new_context(browser, width, theme)
            page = context.new_page()
            page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
            open_settings_nodes(page, base)
            expand_node(page, SAMPLE_TIMEOUT_NODE)
            page.wait_for_selector(f'[data-testid="cogito-node-health"][data-node-id="{SAMPLE_TIMEOUT_NODE}"]', state="visible")
            page.wait_for_timeout(700)
            scroll_cogito_into_view(page)
            state_captures[key]["timeout"] = {
                "page": shot(page, out, f"settings-nodes-timeout-{key}"),
                "card": card_shot(page, out, SAMPLE_TIMEOUT_NODE, f"settings-nodes-card-timeout-{key}"),
            }
            measurements["details"][key]["timeout"] = collect_detail(page, SAMPLE_TIMEOUT_NODE)
            measurements["selection"][key]["timeout"] = measure_selection(page, SAMPLE_TIMEOUT_NODE, measurements["details"][key]["timeout"])
            context.close()

            for state in ("loading", "failure"):
                context = new_context(browser, width, theme)
                page = context.new_page()
                page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
                open_settings_nodes(page, base, state)
                expand_node(page, SAMPLE_NODE)
                if state == "loading":
                    page.wait_for_selector('[data-node-state="loading"]', state="visible", timeout=15_000)
                else:
                    page.wait_for_selector('[data-node-state="error"]', state="visible", timeout=15_000)
                page.wait_for_timeout(700)
                scroll_cogito_into_view(page)
                slot = page.evaluate(COGITO_SLOT_SCRIPT)
                measurements["states"][f"{state}-{key}"] = slot
                state_captures[key][state] = {
                    "page": shot(page, out, f"settings-nodes-{state}-{key}"),
                    "card": card_shot(page, out, SAMPLE_NODE, f"settings-nodes-card-{state}-{key}"),
                }
                measurements["details"][key][state] = collect_detail(page, SAMPLE_NODE)
                measurements["selection"][key][state] = measure_selection(page, SAMPLE_NODE, measurements["details"][key][state])
                context.close()

    measurements["stateCaptures"] = state_captures

    # 컴포넌트 검수 창(NodePanel 실물): 정상·로딩·실패를 각각 펼친 노드에서 연다.
    context = browser.new_context(
        viewport={"width": WIDE, "height": 900},
        color_scheme="dark",
        reduced_motion="reduce",
    )
    install_page(context, "dark")
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
    for state in ("normal", "loading", "failure"):
        suffix = "" if state == "normal" else f"&cogitoState={state}"
        page.goto(f"{base}/components?sample=claude-accounts&state=pool{suffix}")
        settle(page)
        expand_node(page, REVIEW_NODE)
        if state == "normal":
            page.wait_for_selector('[data-testid="cogito-node-health"]', state="visible")
        elif state == "loading":
            page.wait_for_selector('[data-node-state="loading"]', state="visible")
        else:
            page.wait_for_selector('[data-node-state="error"]', state="visible")
        page.wait_for_timeout(700)
        scroll_cogito_into_view(page)
        slot = page.evaluate(COGITO_SLOT_SCRIPT)
        measurements["review"][state] = slot
        captures.append(shot(page, out, f"provider-review-cogito-{state}-{WIDE}-dark"))
    context.close()

    return measurements, captures


def run_before(browser, base: str, out: Path) -> tuple[dict, list[str]]:
    """origin/main은 펼친 노드에 cogito가 없고 ScrollArea가 휠을 막는다. 스크롤만 잰다."""
    measurements: dict = {"widths": {}}
    captures: list[str] = []
    for width in (WIDE, NARROW):
        for theme in THEMES:
            key = f"{width}-{theme}"
            context = new_context(browser, width, theme)
            page = context.new_page()
            open_settings_nodes(page, base)
            captures.append(shot(page, out, f"settings-nodes-collapsed-{key}"))
            expand_node(page, SAMPLE_NODE)
            captures.append(shot(page, out, f"settings-nodes-expanded-{key}"))
            measurements["widths"][key] = {"scroll": wheel_measure(page)}
            context.close()
    return measurements, captures


def sha256(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def visible_head_time(detail: dict) -> bool:
    time = detail.get("head", {}).get("time")
    return bool(time) and time.get("display") != "none"


def add_detail_assertions(measurements: dict) -> dict:
    details = measurements["details"]
    selection = measurements["selection"]

    start_failures = []
    start_items = {}
    for key, entry in details.items():
        for state in ("normal", "timeout"):
            detail = entry.get(state)
            if not detail or not detail.get("row"):
                start_failures.append({"capture": key, "state": state, "where": "missingRow"})
                continue
            row = detail["row"]
            dot = row.get("dot")
            label = row.get("label")
            neighbors = [neighbor for neighbor in detail["neighbors"] if neighbor.get("label")]
            item = {
                "dot": dot,
                "label": label,
                "neighbors": [{"provider": neighbor["provider"], "dot": neighbor.get("dot"), "label": neighbor.get("label")} for neighbor in neighbors],
            }
            start_items[f"{key}:{state}"] = item
            if not dot or "c724-status-dot" not in (dot.get("cls") or ""):
                start_failures.append({"capture": key, "state": state, "where": "dotClass", "dot": dot})
            if not label:
                start_failures.append({"capture": key, "state": state, "where": "missingLabel"})
            if not neighbors:
                start_failures.append({"capture": key, "state": state, "where": "missingNeighbors"})
                continue
            neighbor_dots = [neighbor["dot"]["w"] for neighbor in neighbors if neighbor.get("dot")]
            if neighbor_dots and dot and any(abs(dot["w"] - width) > 0.1 or abs(dot["h"] - width) > 0.1 for width in [neighbor_dots[0]]):
                start_failures.append({"capture": key, "state": state, "where": "dotSize", "dot": dot, "neighborDotWidth": neighbor_dots[0]})
            deltas = [abs(label["x"] - neighbor["label"]["x"]) for neighbor in neighbors if neighbor.get("label") and label]
            if deltas and min(deltas) > START_LABEL_DELTA_MAX_PX:
                start_failures.append({"capture": key, "state": state, "where": "labelLeft", "labelX": label["x"], "neighborXs": [neighbor["label"]["x"] for neighbor in neighbors if neighbor.get("label")]})
    assertions_start = {"passed": not start_failures, "failures": start_failures, "items": start_items}

    badge_failures = []
    badge_items = {}
    expect_badge = {"normal": None, "timeout": "c724-badge-warn", "loading": None, "failure": "c724-badge-warn"}
    for key, entry in details.items():
        for state, expected in expect_badge.items():
            detail = entry.get(state)
            if not detail or not detail.get("row"):
                badge_failures.append({"capture": key, "state": state, "where": "missingRow"})
                continue
            row = detail["row"]
            badge = row.get("badge")
            ref = row.get("badgeRef")
            badge_items[f"{key}:{state}"] = {"badge": badge, "reference": ref}
            if expected is None:
                if badge is not None:
                    badge_failures.append({"capture": key, "state": state, "where": "unexpectedBadge", "badge": badge})
                continue
            if badge is None:
                badge_failures.append({"capture": key, "state": state, "where": "missingBadge"})
                continue
            if "c724-badge" not in (badge.get("cls") or "") or expected not in (badge.get("cls") or ""):
                badge_failures.append({"capture": key, "state": state, "where": "badgeClass", "badge": badge, "expected": expected})
            if not ref:
                badge_failures.append({"capture": key, "state": state, "where": "missingBadgeReference"})
                continue
            for field in ("radius", "fontSize"):
                if badge.get(field) != ref.get(field):
                    badge_failures.append({"capture": key, "state": state, "where": f"badge{field}", "badge": badge.get(field), "reference": ref.get(field)})
            if abs(badge.get("h", 0) - ref.get("h", 0)) > 0.5:
                badge_failures.append({"capture": key, "state": state, "where": "badgeHeight", "badge": badge.get("h"), "reference": ref.get("h")})
    assertions_badges = {"passed": not badge_failures, "failures": badge_failures, "items": badge_items}

    selection_failures = []
    selection_items = {}
    for key, entry in selection.items():
        for state, probe in entry.items():
            selection_items[f"{key}:{state}"] = probe
            lines = probe.get("lines", [])
            if not lines:
                selection_failures.append({"capture": key, "state": state, "where": "missingLines"})
            for line in lines:
                if line.get("error"):
                    selection_failures.append({"capture": key, "state": state, "where": "lineError", "line": line})
                    continue
                if line.get("userSelect") != "text":
                    selection_failures.append({"capture": key, "state": state, "where": "lineUserSelect", "line": line})
                if not line.get("dblclickSelection") or not line.get("dragSelection"):
                    selection_failures.append({"capture": key, "state": state, "where": "lineNotSelectable", "line": line})
            label = probe.get("label")
            if not label or label.get("error"):
                selection_failures.append({"capture": key, "state": state, "where": "labelMissing", "label": label})
            elif label.get("dblclickSelection") or label.get("dragSelection"):
                selection_failures.append({"capture": key, "state": state, "where": "labelSelectable", "label": label})
            badge = probe.get("badge")
            if badge:
                if badge.get("error"):
                    selection_failures.append({"capture": key, "state": state, "where": "badgeError", "badge": badge})
                elif badge.get("dblclickSelection") or badge.get("dragSelection"):
                    selection_failures.append({"capture": key, "state": state, "where": "badgeSelectable", "badge": badge})
    assertions_selection = {"passed": not selection_failures, "failures": selection_failures, "items": selection_items}

    time_failures = []
    time_items = {}
    for key, entry in details.items():
        for state in ("normal", "timeout"):
            detail = entry.get(state)
            if not detail or not detail.get("row"):
                time_failures.append({"capture": key, "state": state, "where": "missingRow"})
                continue
            metas = detail["row"].get("metas", [])
            service = metas[0]["text"] if metas else ""
            match = TIME_PATTERN.match(service)
            head = detail.get("head", {}).get("time")
            head_match = HEAD_TIME_PATTERN.match((head or {}).get("text", ""))
            item = {"service": service, "head": head, "headMatch": bool(head_match), "headVisible": visible_head_time(detail)}
            time_items[f"{key}:{state}"] = item
            if not match:
                time_failures.append({"capture": key, "state": state, "where": "cogitoTimeFormat", "service": service})
            if "AM" in service or "PM" in service or re.search(r"\d{2}:\d{2}:\d{2}", service):
                time_failures.append({"capture": key, "state": state, "where": "cogitoTimeNot24h", "service": service})
            if head and visible_head_time(detail):
                if not head_match:
                    time_failures.append({"capture": key, "state": state, "where": "headTimeFormat", "head": head})
                if "AM" in head.get("text", "") or "PM" in head.get("text", "") or re.search(r"\d{2}:\d{2}:\d{2}", head.get("text", "")):
                    time_failures.append({"capture": key, "state": state, "where": "headTimeNot24h", "head": head})
    assertions_time = {"passed": not time_failures, "failures": time_failures, "items": time_items}

    wrap_failures = []
    wrap_items = {}
    for key, entry in details.items():
        if not key.startswith(str(NARROW)):
            continue
        for state in ("normal", "timeout"):
            detail = entry.get(state)
            if not detail or not detail.get("row"):
                wrap_failures.append({"capture": key, "state": state, "where": "missingRow"})
                continue
            lines = []
            for meta in detail["row"].get("metas", []):
                line_height = float(meta.get("lineHeight", "0").replace("px", "") or 0)
                rendered_lines = round(meta["h"] / line_height, 1) if line_height else 0
                lines.append({"text": meta["text"], "scrollW": meta["scrollW"], "clientW": meta["clientW"], "whiteSpace": meta["whiteSpace"], "height": meta["h"], "lineHeight": meta.get("lineHeight"), "renderedLines": rendered_lines})
                if meta["whiteSpace"] != "normal":
                    wrap_failures.append({"capture": key, "state": state, "where": "whiteSpace", "meta": meta})
                if meta["scrollW"] - meta["clientW"] > 0.5:
                    wrap_failures.append({"capture": key, "state": state, "where": "horizontalOverflow", "meta": meta})
            wrap_items[f"{key}:{state}"] = lines
            if state == "normal":
                runtime_lines = [line for line in lines if line["text"].startswith("runtime ")]
                if runtime_lines and runtime_lines[0]["renderedLines"] < 2:
                    wrap_failures.append({"capture": key, "state": state, "where": "runtimeDidNotWrap", "line": runtime_lines[0]})
    assertions_wrap = {"passed": not wrap_failures, "failures": wrap_failures, "items": wrap_items}

    border_failures = []
    border_items = {}
    for key, entry in details.items():
        detail = entry.get("normal")
        if not detail:
            border_failures.append({"capture": key, "where": "missingDetail"})
            continue
        borders = detail["borders"]
        border_items[key] = borders
        if borders["card"].get("borderTopWidth") != "1px":
            border_failures.append({"capture": key, "where": "nodeCardBorder", "value": borders["card"]})
        if not borders.get("usage") or borders["usage"].get("borderTopWidth") != "1px":
            border_failures.append({"capture": key, "where": "usageRowBorder", "value": borders.get("usage")})
        bordered_ancestors = [
            ancestor for ancestor in borders["ancestors"]
            if ancestor.get("borderTopStyle") != "none" and ancestor.get("borderTopWidth") not in ("0px", "")
        ]
        if bordered_ancestors:
            border_failures.append({"capture": key, "where": "ancestorFrameBorder", "ancestors": bordered_ancestors})
    assertions_border = {"passed": not border_failures, "failures": border_failures, "items": border_items}

    name_failures = []
    name_items = {}
    for key, entry in details.items():
        # 같은 폭에서 이름이 실제로 받는 최대 자리. 시각 글과 배지가 빠진 뒤의 값이다.
        available = 0.0
        for state_detail in entry.values():
            candidate = ((state_detail or {}).get("head") or {}).get("name")
            if candidate:
                available = max(available, float(candidate.get("w", 0)))
        for state in ("normal", "timeout"):
            detail = entry.get(state)
            name = (detail or {}).get("head", {}).get("name")
            time = (detail or {}).get("head", {}).get("time")
            head_children = (detail or {}).get("head", {}).get("children", [])
            if not name:
                name_failures.append({"capture": key, "state": state, "where": "missingName"})
                continue
            truncated = name.get("textW", 0) > name.get("w", 0) + NAME_TRUNCATION_TOLERANCE_PX
            head_extras = [
                child for child in head_children
                if child.get("display") != "none"
                and (
                    "c724-badge" in (child.get("cls") or "")
                    or (child.get("text") or "").endswith("갱신")
                )
            ]
            name_items[f"{key}:{state}"] = {
                "name": name,
                "time": time,
                "truncated": truncated,
                "availableWidth": available,
                "headVisibleExtras": head_extras,
            }
            if key.startswith(str(WIDE)) and truncated:
                name_failures.append({"capture": key, "state": state, "where": "nameTruncatedAtWide", "name": name})
            if key.startswith(str(NARROW)):
                # 360에서는 이름이 폭을 먼저 갖고, 시각 글과 수집 지연 배지는 머리에서 물러난다.
                if time and time.get("display") != "none":
                    name_failures.append({"capture": key, "state": state, "where": "timeStillVisibleAt360", "time": time})
                if head_extras:
                    name_failures.append({"capture": key, "state": state, "where": "headExtrasVisibleAt360", "extras": head_extras})
                if name.get("w", 0) < available - 0.5:
                    name_failures.append({"capture": key, "state": state, "where": "nameBoxSmallerThanAvailable", "name": name, "availableWidth": available})
                # 이름이 가진 자리 안에 들어가는 이름은 잘리면 안 된다. 그보다 긴 이름만 잘림을 허용한다.
                if truncated and name.get("textW", 0) <= available + NAME_TRUNCATION_TOLERANCE_PX:
                    name_failures.append({"capture": key, "state": state, "where": "nameTruncatedButFits", "name": name, "availableWidth": available})
    assertions_name = {"passed": not name_failures, "failures": name_failures, "items": name_items}

    distinct_failures = []
    distinct_items = {}
    for key, states in measurements.get("stateCaptures", {}).items():
        hashes = {state: {kind: sha256(path) for kind, path in paths.items()} for state, paths in states.items()}
        distinct_items[key] = hashes
        for kind in ("page", "card"):
            values = [hashes[state][kind] for state in hashes if state in ("expanded", "loading", "failure") and kind in hashes[state]]
            if len(values) != 3 or len(set(values)) != 3:
                distinct_failures.append({"capture": key, "kind": kind, "hashes": values})
        card_values = [hashes[state]["card"] for state in hashes if "card" in hashes[state]]
        if len(card_values) != 4 or len(set(card_values)) != 4:
            distinct_failures.append({"capture": key, "kind": "card-all-states", "hashes": card_values})
    assertions_distinct = {"passed": not distinct_failures, "failures": distinct_failures, "items": distinct_items}

    return {
        "cogitoStartLine": assertions_start,
        "cogitoBadges": assertions_badges,
        "cogitoSelection": assertions_selection,
        "cogitoTimeFormat": assertions_time,
        "cogitoWrap": assertions_wrap,
        "nodeFrameBorders": assertions_border,
        "nodeNameVisibility": assertions_name,
        "stateCapturesDistinct": assertions_distinct,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="설정 노드 구역 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument("--mode", choices=("after", "before"), default="after", help="after=고친 뒤 판정, before=origin/main 스크롤 증거")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            if args.mode == "before":
                measurements, captures = run_before(browser, base, out)
            else:
                measurements, captures = run_after(browser, base, out)
        finally:
            browser.close()

    assertions: dict = {}
    if args.mode == "before":
        blocked = []
        for key, entry in measurements["widths"].items():
            scroll = entry["scroll"]
            if scroll["delta"] != 0:
                blocked.append({"capture": key, "delta": scroll["delta"]})
        assertions["scrollBlockedOnOriginMain"] = {
            "passed": not blocked,
            "expected": "휠을 굴려도 .config-detail scrollTop이 늘지 않는다",
            "failures": blocked,
            "measurements": {key: entry["scroll"] for key, entry in measurements["widths"].items()},
        }
    else:
        scroll_failures = []
        for key, entry in measurements["widths"].items():
            scroll = entry["scroll"]
            if scroll["delta"] < SCROLL_DELTA_MIN_PX:
                scroll_failures.append({"capture": key, **scroll})
        assertions["wheelScrollsSettingsDetail"] = {
            "passed": not scroll_failures,
            "minimumDeltaPx": SCROLL_DELTA_MIN_PX,
            "failures": scroll_failures,
        }

        structure_failures = []
        for key, entry in measurements["widths"].items():
            if entry["collapsed"]["panel"] or entry["collapsed"]["rows"]:
                structure_failures.append({"capture": key, "where": "collapsed", "entry": entry["collapsed"]})
            expanded = entry["expanded"]
            if len(expanded["rows"]) != 1:
                structure_failures.append({"capture": key, "where": "expandedRows", "rows": expanded["rows"]})
            elif not expanded["rows"][0]["inCard"] or not expanded["rows"][0]["afterProviders"]:
                structure_failures.append({"capture": key, "where": "expandedPlacement", "row": expanded["rows"][0]})
        assertions["cogitoInsideExpandedNode"] = {
            "passed": not structure_failures,
            "failures": structure_failures,
        }

        state_failures = []
        for key, slot in measurements["states"].items():
            if key == "resize":
                continue
            state = "loading" if key.startswith("loading-") else "error"
            row = slot["rows"][0] if len(slot["rows"]) == 1 else None
            if row is None or row["state"] != state or not row["inCard"] or not row["afterProviders"]:
                state_failures.append({"capture": key, "expectedState": state, "rows": slot["rows"]})
        for state, slot in measurements["review"].items():
            expected = {"normal": None, "loading": "loading", "failure": "error"}[state]
            row = slot["rows"][0] if len(slot["rows"]) == 1 else None
            if row is None or (expected is not None and row["state"] != expected) or not row["inCard"] or not row["afterProviders"]:
                state_failures.append({"capture": f"review-{state}", "expectedState": expected, "rows": slot["rows"]})
        assertions["cogitoStatesInPlace"] = {
            "passed": not state_failures,
            "failures": state_failures,
        }

        focus_failures = []
        for key, entry in measurements["widths"].items():
            initial = entry["initialDialogFocus"] or {}
            if not initial.get("insideDialog"):
                focus_failures.append({"capture": key, "where": "dialogInitialFocus", "focus": initial})
            focus = entry["focusAndEscape"]
            if not focus:
                continue
            refresh_focus = focus["refreshFocus"] or {}
            if refresh_focus.get("label") != "사용량 새로 고침" or not refresh_focus.get("insideDialog"):
                focus_failures.append({"capture": key, "where": "refreshFocus", "focus": refresh_focus})
            if not focus["dialogOpenBeforeEscape"] or focus["dialogCountAfterEscape"] != 0:
                focus_failures.append({"capture": key, "where": "escape", "value": focus})
        assertions["focusAndEscape"] = {
            "passed": not focus_failures,
            "failures": focus_failures,
        }

        order_failures = []
        order_items = {}
        for key, entry in measurements["widths"].items():
            focus = entry["focusAndEscape"]
            if not focus:
                continue
            order_items[key] = focus["tabOrderItems"]
            tabs = [item for item in focus["tabSequence"] if item]
            if not focus["tabOrderOk"]:
                order_failures.append({"capture": key, "where": "readingOrder", "items": focus["tabOrderItems"]})
            if not tabs or not all(item.get("insideDialog") for item in tabs):
                order_failures.append({"capture": key, "where": "tabKeepsFocusInDialog", "tabs": tabs})
        assertions["tabOrder"] = {
            "passed": not order_failures,
            "failures": order_failures,
            "items": order_items,
        }

        overflow_failures = []
        for key, entry in measurements["widths"].items():
            if not key.startswith(str(NARROW)):
                continue
            data = entry["expandedOverflow"]
            if data["pageOverflowX"] > 0 or data["detailOverflowX"] not in (None, 0) or data["listOverflowX"] not in (None, 0):
                overflow_failures.append({"capture": key, "value": data})
        resize = measurements["states"].get("resize")
        if resize is None:
            overflow_failures.append({"where": "resize", "value": "missing"})
        else:
            for where in ("wideOverflow", "narrowOverflow", "wideAgainOverflow"):
                data = resize[where]
                if data["pageOverflowX"] > 0 or data["detailOverflowX"] not in (None, 0):
                    overflow_failures.append({"where": where, "value": data})
            if resize["cogitoRowsWide"] != 1 or resize["cogitoRowsNarrow"] != 1 or resize["cogitoRowsWideAgain"] != 1:
                overflow_failures.append({"where": "expansionRetained", "value": {
                    "wide": resize["cogitoRowsWide"],
                    "narrow": resize["cogitoRowsNarrow"],
                    "wideAgain": resize["cogitoRowsWideAgain"],
                }})
            if resize["narrowScrollTop"] <= 0:
                overflow_failures.append({"where": "scrollKeptAfterResize", "value": resize["narrowScrollTop"]})
        assertions["narrowOverflowAndResize"] = {
            "passed": not overflow_failures,
            "failures": overflow_failures,
        }

        assertions.update(add_detail_assertions(measurements))

    report = {
        "baseUrl": base,
        "mode": args.mode,
        "captures": captures,
        "assertions": assertions,
    }
    report["passed"] = all(entry["passed"] for entry in assertions.values())

    (out / "measurements.json").write_text(
        json.dumps(measurements, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    for key, entry in measurements.get("widths", {}).items():
        scroll = entry["scroll"]
        print(f"휠 scrollTop {key}: {scroll['before']} → {scroll['after']} (delta {scroll['delta']}px, 가리킨 곳 {scroll['underPoint']['testId']})")
    for name, entry in assertions.items():
        print(f"{name}: {'통과' if entry['passed'] else '실패'}")
    if report["passed"]:
        print(f"판정: {args.mode} 모드 통과 (캡처 {len(captures)}장)")
        return 0
    print(json.dumps({name: entry.get("failures") for name, entry in assertions.items() if not entry["passed"]}, ensure_ascii=False, indent=2), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

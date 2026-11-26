#!/usr/bin/env python3
"""프레임 로딩·실패 자리 시각 검수.

대표 화면의 로딩 상태를 Playwright 로 붙잡아 두고 넓은 폭(1440)과 좁은 폭(390)에서
캡처한 뒤, 로딩 덩어리(스피너+글자)가 프레임(내용이 들어올 영역) 안 어디에 서는지 잰다.

  - 채움 프레임: 덩어리 중심과 프레임 내용 상자 중심의 가로·세로 차이(1px 안).
  - 내용 높이 프레임: 가로 중심과, 프레임 위 가장자리에서 덩어리 위까지 / 덩어리
    아래에서 프레임 아래 가장자리까지의 거리 차이(1px 안). 로더 자기 안쪽 여백이
    아니라 프레임 기준으로 잰다.
  - 토큰: 부품의 계산된 간격(gap), 글자 크기, 글자 굵기, 글자 색이 그 자리에서
    풀린 --v3-space-2 / --v3-type-meta / --v3-text-secondary 값과 같은지 단언한다.
    포털 대화상자 안에서도 같은 값이어야 한다.
  - 실패 전환: 로딩에서 실패로 바꾼 뒤 실패 안내 묶음의 중심이 로더 중심과 1px 안에
    있는지, 내용 높이 프레임(폴더 본문)에서는 뒤따르는 구역이 움직이지 않았는지 잰다.
  - 세션 통계: 로더가 막대 프레임 하나뿐인지, 값 자리에 로딩 글자가 없는지 단언한다.
  - 런타임 띠: 첫 로딩 동안 아무것도 그리지 않고, 응답 뒤에만 접힌 머리줄이 나오며,
    데이터 있는 새로고침에는 머리 단추만 도는지 단언한다.

준비

    # 저장소 루트에서 (워크트리 기준)
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/loading_placement.py \
        http://127.0.0.1:5173 /path/to/output

    # 밝은 테마에서 포털 대화상자 토큰까지 확인
    python3 -P unified-dashboard/scripts/visual-check/loading_placement.py \
        http://127.0.0.1:5173 /path/to/output --theme light \
        --screen search-modal --screen ritual-modal

산출물

    {출력}/loading-{화면}-{폭}[-{테마}].png
    {출력}/measurements.json   (프레임·덩어리 좌표, 토큰 계산값, 실패 전환 측정)
    {출력}/report.json         (화면별 판정과 종합 판정)

표준 출력에는 캡처마다 한 줄, 마지막에 판정 요약을 남긴다. 배치·토큰·실패 전환·
추가 단언 중 하나라도 1px/토큰 값을 벗어나면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import inspect
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

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
PAS_CHAT_SESSION = {
    "session_id": "pas-1",
    "display_name": "검수 관제",
    "node_id": "eiaserinnys",
    "folder_id": "folder-1",
    "agent_id": "default",
    "agent_name": "기본",
    "persistent": True,
    "settings": {
        "default_model": {"model_preset": "sample-sol", "reasoning_effort": None},
        "fallback_models": [],
        "show_generation_separator": True,
        "show_character": False,
        "show_jev_candidates": False,
        "show_work_details": False,
        "animate_character": False,
        "turn_usage_mode": "collapsed",
        "show_turn_usage": False,
    },
    "runtime": {
        "current_model": {"model_preset": "sample-sol", "reasoning_effort": None, "model": None},
        "pending": None,
    },
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
RUNTIME_SCHEDULES = {
    "sessionId": "review-runtime-loaded",
    "nextRunAt": "2026-11-19T00:00:00.000Z",
    "schedules": [{
        "scheduleId": "review-schedule-1",
        "kind": "cron",
        "status": "active",
        "prompt": "아침 점검",
        "cronExpression": "0 9 * * *",
        "nextRunAt": "2026-11-19T00:00:00.000Z",
        "recurring": True,
        "timezone": "Asia/Seoul",
    }],
}

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
({ frameSelector, insetTop, insetBottom }) => {
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
  const fcs = getComputedStyle(frame);
  const borderLeft = parseFloat(fcs.borderLeftWidth);
  const borderTop = parseFloat(fcs.borderTopWidth);
  // 스크롤 상자도 실제 내용 폭(스크롤바 제외)을 쓴다. clientWidth/Height 는 패딩 상자에서
  // 스크롤바를 뺀 값이므로 패딩을 다시 빼면 내용 상자가 된다.
  const frameContent = {
    left: fr.left + borderLeft + parseFloat(fcs.paddingLeft),
    right: fr.left + borderLeft + frame.clientWidth - parseFloat(fcs.paddingRight),
    top: fr.top + borderTop + parseFloat(fcs.paddingTop),
    bottom: fr.top + borderTop + frame.clientHeight - parseFloat(fcs.paddingBottom),
  };
  // 제목·머리줄처럼 프레임 위쪽에 늘 남는 것이 있으면 그 아래 남는 영역을 프레임으로 잰다.
  if (insetTop) {
    const inset = frame.querySelector(insetTop);
    if (inset) {
      const insetStyle = getComputedStyle(inset);
      frameContent.top = Math.max(
        frameContent.top,
        inset.getBoundingClientRect().bottom + parseFloat(insetStyle.marginBottom),
      );
    }
  }
  if (insetBottom) {
    const inset = frame.querySelector(insetBottom);
    if (inset) {
      const insetStyle = getComputedStyle(inset);
      frameContent.bottom = Math.min(
        frameContent.bottom,
        inset.getBoundingClientRect().top - parseFloat(insetStyle.marginTop),
      );
    }
  }
  const slots = Array.from(frame.querySelectorAll('[data-slot="frame-loading"]'))
    .filter((element) => element.getClientRects().length > 0);
  const slot = slots[0];
  if (!slot) return fail('loading element not found');
  const rects = Array.from(slot.children)
    .filter((child) => child.getClientRects().length > 0)
    .map((child) => child.getBoundingClientRect());
  const cluster = union(rects);
  if (!cluster) return fail('loading cluster not found');
  const slotRect = slot.getBoundingClientRect();
  const slotStyle = getComputedStyle(slot);
  const svg = slot.querySelector('svg');
  const label = slot.querySelector('.v3-frame-loading-label');
  const labelStyle = label ? getComputedStyle(label) : null;

  // 토큰이 이 자리에서 실제로 풀리는지: 같은 토큰을 적용한 숨은 표본과 계산값을 비교한다.
  const inline = slot.hasAttribute('data-inline');
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;width:0;height:0;gap:var(--v3-space-2);padding:var(--v3-space-4);font:var(--v3-type-meta) var(--v3-font-family);color:var(--v3-text-secondary);';
  const probePad1 = document.createElement('span');
  probePad1.setAttribute('aria-hidden', 'true');
  probePad1.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;width:0;height:0;padding-block:var(--v3-space-1);';
  const tokenRoot = document.querySelector('.v3-shell');
  if (!tokenRoot) return fail('independent token root not found');
  tokenRoot.append(probe, probePad1);
  const rootStyle = getComputedStyle(tokenRoot);
  const probeStyle = getComputedStyle(probe);
  const probePad1Style = getComputedStyle(probePad1);
  const tokens = {
    space1: rootStyle.getPropertyValue('--v3-space-1').trim(),
    space2: rootStyle.getPropertyValue('--v3-space-2').trim(),
    space4: rootStyle.getPropertyValue('--v3-space-4').trim(),
    typeMeta: rootStyle.getPropertyValue('--v3-type-meta').trim(),
    fontFamily: rootStyle.getPropertyValue('--v3-font-family').trim(),
    textSecondary: rootStyle.getPropertyValue('--v3-text-secondary').trim(),
  };
  const metaMatch = tokens.typeMeta.match(/^(\\d+)\\s+([\\d.]+px)\\/([\\d.]+px)$/);
  const expected = {
    gap: probeStyle.columnGap,
    fontSize: metaMatch ? metaMatch[2] : null,
    fontWeight: metaMatch ? metaMatch[1] : null,
    lineHeight: metaMatch ? metaMatch[3] : null,
    color: probeStyle.color,
    paddingTop: inline ? probePad1Style.paddingTop : probeStyle.paddingTop,
    paddingRight: probeStyle.paddingRight,
    paddingBottom: inline ? probePad1Style.paddingBottom : probeStyle.paddingBottom,
    paddingLeft: probeStyle.paddingLeft,
  };
  const actual = {
    gap: slotStyle.columnGap,
    fontSize: slotStyle.fontSize,
    fontWeight: slotStyle.fontWeight,
    lineHeight: slotStyle.lineHeight,
    color: slotStyle.color,
    paddingTop: slotStyle.paddingTop,
    paddingRight: slotStyle.paddingRight,
    paddingBottom: slotStyle.paddingBottom,
    paddingLeft: slotStyle.paddingLeft,
    labelFontSize: labelStyle ? labelStyle.fontSize : null,
    labelFontWeight: labelStyle ? labelStyle.fontWeight : null,
    labelColor: labelStyle ? labelStyle.color : null,
  };
  const spinnerToLabel = svg && label
    ? round(label.getBoundingClientRect().left - svg.getBoundingClientRect().right)
    : null;
  const checks = {
    gap: Boolean(tokens.space2) && actual.gap === expected.gap,
    padding: Boolean(tokens.space4) && actual.paddingTop === expected.paddingTop
      && actual.paddingRight === expected.paddingRight
      && actual.paddingBottom === expected.paddingBottom
      && actual.paddingLeft === expected.paddingLeft,
    fontSize: Boolean(metaMatch) && actual.fontSize === expected.fontSize
      && (actual.labelFontSize === null || actual.labelFontSize === expected.fontSize),
    fontWeight: Boolean(metaMatch) && actual.fontWeight === expected.fontWeight
      && (actual.labelFontWeight === null || actual.labelFontWeight === expected.fontWeight),
    color: Boolean(tokens.textSecondary) && actual.color === expected.color
      && (actual.labelColor === null || actual.labelColor === expected.color),
    spinnerToLabel: spinnerToLabel !== null && Math.abs(spinnerToLabel - parseFloat(expected.gap)) <= 0.6,
  };
  probe.remove();
  probePad1.remove();

  const clusterCenter = {
    x: (cluster.left + cluster.right) / 2,
    y: (cluster.top + cluster.bottom) / 2,
  };
  const frameCenter = {
    x: (frameContent.left + frameContent.right) / 2,
    y: (frameContent.top + frameContent.bottom) / 2,
  };
  const result = {
    inline,
    visible: slotRect.width > 0 && slotRect.height > 0,
    text: (slot.textContent || '').trim(),
    frameSlotCount: slots.length,
    pageSlotCount: Array.from(document.querySelectorAll('[data-slot="frame-loading"]'))
      .filter((element) => element.getClientRects().length > 0).length,
    slot: {
      width: round(slotRect.width),
      height: round(slotRect.height),
    },
    cluster: {
      width: round(cluster.right - cluster.left),
      height: round(cluster.bottom - cluster.top),
      centerX: round(clusterCenter.x),
      centerY: round(clusterCenter.y),
    },
    frameContent: {
      left: round(frameContent.left),
      top: round(frameContent.top),
      right: round(frameContent.right),
      bottom: round(frameContent.bottom),
      width: round(frameContent.right - frameContent.left),
      height: round(frameContent.bottom - frameContent.top),
      centerX: round(frameCenter.x),
      centerY: round(frameCenter.y),
    },
    dx: round(clusterCenter.x - frameCenter.x),
    dy: round(clusterCenter.y - frameCenter.y),
    gapTop: round(cluster.top - frameContent.top),
    gapBottom: round(frameContent.bottom - cluster.bottom),
    tokens,
    expected,
    actual,
    checks,
    spinnerToLabel,
  };
  style.remove();
  return result;
}
"""

NOTICE_SCRIPT = """
(scene) => {
  const round = (value) => Math.round(value * 10) / 10;
  const seat = Array.from(document.querySelectorAll('[data-slot="frame-notice"]'))
    .filter((element) => element.getClientRects().length > 0).pop();
  if (!seat) return { error: 'notice not found' };
  const child = seat.firstElementChild;
  if (!child) return { error: 'notice content not found' };
  const rect = child.getBoundingClientRect();
  // 같은 화면의 자리 바깥에 복제하여 원래 상속과 컴포넌트 고유 스타일을 측정한다.
  const reference = child.cloneNode(true);
  reference.style.position = 'absolute';
  reference.style.visibility = 'hidden';
  reference.style.width = `${rect.width}px`;
  seat.parentElement.appendChild(reference);
  if (scene === 'document-reader') {
    reference.style.font = 'var(--v3-type-body) var(--v3-font-family)';
    reference.style.color = 'var(--muted-foreground)';
    reference.style.textAlign = 'center';
  }
  const describe = (element) => {
    const cs = getComputedStyle(element), box = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), text: (element.textContent || '').trim().slice(0, 80),
      align: cs.textAlign, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      fontWeight: cs.fontWeight, color: cs.color, left: round(box.left), right: round(box.right) };
  };
  const elements = [child, ...child.querySelectorAll('strong, p, details, summary, button')];
  const refs = [reference, ...reference.querySelectorAll('strong, p, details, summary, button')];
  const nodes = elements.map((element, i) => {
    const actual = describe(element), expected = describe(refs[i]);
    return { ...actual, expected, sameStyle: ['align', 'fontSize', 'lineHeight', 'fontWeight', 'color']
      .every((property) => actual[property] === expected[property]) };
  });
  const aligned = child.matches('.v3-error-notice')
    ? ['strong', 'p', 'details', 'button'].every((selector) => {
        const element = child.querySelector(selector);
        return !element || Math.abs(element.getBoundingClientRect().left - child.querySelector('strong').getBoundingClientRect().left) <= 1;
      })
    : true;
  let pasAligned = true;
  if (scene === 'pas-screen') {
    const text = Array.from(child.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const button = child.querySelector('button');
    if (text && button) {
      const range = document.createRange(); range.selectNodeContents(text);
      pasAligned = Math.abs(range.getBoundingClientRect().left - button.getBoundingClientRect().left) <= 1;
    } else pasAligned = false;
  }
  const planner = scene !== 'planner' || (child.matches('.v3-error-notice') &&
    child.querySelector('strong')?.textContent === '플래너를 불러오지 못했습니다.' && !child.querySelector('h1'));
  reference.remove();
  return { text: (child.textContent || '').trim().slice(0, 120), width: round(rect.width),
    height: round(rect.height), centerX: round((rect.left + rect.right) / 2),
    centerY: round((rect.top + rect.bottom) / 2), nodes, aligned, pasAligned, planner,
    stylePassed: nodes.every((node) => node.sameStyle) && aligned && pasAligned && planner };
}
"""

ANCHOR_SCRIPT = """
(text) => {
  const element = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, span'))
    .find((candidate) => (candidate.textContent || '').trim() === text);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: Math.round((rect.top + window.scrollY) * 10) / 10, text };
}
"""

STATS_SCRIPT = """
() => {
  const visible = (element) => element.getClientRects().length > 0;
  const loaders = Array.from(document.querySelectorAll('[data-slot="frame-loading"]')).filter(visible);
  const chart = document.querySelector('.usage-stats-chart');
  const loadingTexts = Array.from(document.querySelectorAll('*'))
    .filter((element) => element.children.length === 0
      && (element.textContent || '').trim() === '불러오는 중…' && visible(element));
  return {
    loaderCount: loaders.length,
    chartLoader: Boolean(chart && chart.querySelector('[data-slot="frame-loading"]')),
    chartTop: chart ? chart.getBoundingClientRect().top : null,
    valueHeights: Array.from(document.querySelectorAll('.usage-stats-summary-metric > strong')).map(e => e.getBoundingClientRect().height),
    loadingTextCount: loadingTexts.length,
    summaryValues: Array.from(document.querySelectorAll('.usage-stats-summary-metric > strong'))
      .map((element) => (element.textContent || '').trim()),
    shareList: Boolean(document.querySelector('.usage-stats-share-list')),
    detailLoader: Boolean(document.querySelector('.usage-stats-input-material [data-slot="frame-loading"]')),
  };
}
"""

RUNTIME_LOADING_SCRIPT = """
() => {
  const panel = document.querySelector('[data-testid="runtime-sample-first-loading"]');
  if (!panel) return { error: 'sample panel not found' };
  return {
    sections: panel.querySelectorAll('section').length,
    hasCount: (panel.textContent || '').includes('예약 0'),
    text: (panel.textContent || '').trim(),
  };
}
"""

RUNTIME_RESPONSE_SCRIPT = """
() => {
  const panel = document.querySelector('[data-testid="runtime-sample-first-loading"]');
  const refresh = document.querySelector('[data-testid="runtime-sample-refresh"]');
  const section = panel ? panel.querySelector('section[data-slot="claude-runtime-schedules-caption"]') : null;
  const toggle = section ? section.querySelector('button[aria-expanded]') : null;
  return {
    firstLoadingSections: panel ? panel.querySelectorAll('section').length : -1,
    firstLoadingText: panel ? (panel.textContent || '').trim() : null,
    collapsed: toggle ? toggle.getAttribute('aria-expanded') : null,
    firstLoadingLoader: panel ? Boolean(panel.querySelector('[data-slot="frame-loading"]')) : null,
    refreshSpinning: refresh
      ? Boolean(refresh.querySelector('button[title="새로고침"] .animate-spin'))
      : null,
  };
}
"""


class Held:
    """응답을 붙잡아 두는 라우트 모음. 실패로 풀거나 일부만 남기고 풀 수 있다."""

    def __init__(self) -> None:
        self.routes = []

    def __call__(self, route) -> None:
        self.routes.append(route)

    def release(self, status: int = 200, body="{}", content_type: str = "application/json",
                only=None, exclude=None) -> int:
        kept = []
        released = 0
        for route in self.routes:
            url = route.request.url
            if (only is not None and not only(url)) or (exclude is not None and exclude(url)):
                kept.append(route)
                continue
            try:
                route.fulfill(
                    status=status,
                    content_type=content_type,
                    body=body if isinstance(body, str) else json.dumps(body),
                )
                released += 1
            except Exception as error:  # noqa: BLE001
                print("release error", error, file=sys.stderr)
        self.routes = kept
        return released


def load_json(context, pattern, payload) -> None:
    body = payload if isinstance(payload, str) else json.dumps(payload)
    context.route(
        pattern,
        lambda route: route.fulfill(status=200, content_type="application/json", body=body),
    )


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


def open_completed_board(page: Page) -> None:
    open_card_board(page)
    page.get_by_role("switch", name="완료·취소 숨김").click()
    page.locator('[data-board-column="done"]').scroll_into_view_if_needed()


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


def open_pas_chat(context, page: Page) -> None:
    """PAS 목록은 받았고 대화 타임라인 첫 요청을 붙잡는다: 대화 0행 첫 로딩."""
    held = Held()
    context.route(re.compile(r"/api/sessions\?.*session_id=pas-1"), held)
    load_json(context, "**/api/persistent-sessions", {
        **PAS_LIST, "sessions": [PAS_CHAT_SESSION], "total": 1,
    })
    page.goto("/persistent/pas-1")
    wait_shell(page)


def open_settings_tab(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    page.click('[data-testid="config-button"]')
    page.get_by_role("button", name="에이전트 프로필", exact=True).click()


def click_settings_tab(page: Page, label: str) -> None:
    page.goto("/")
    wait_shell(page)
    page.click('[data-testid="config-button"]')
    page.get_by_role("button", name=label, exact=True).click()


def open_usage_stats(page: Page) -> None:
    click_settings_tab(page, "세션 통계")


def open_search_modal(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    # 좁은 폭에서는 도구막대 검색 단추가 숨어 있다. 단추는 마운트돼 있으니 DOM 클릭으로 연다.
    page.wait_for_selector('[aria-label="세션 검색 열기"]', state="attached", timeout=30000)
    page.evaluate("""() => document.querySelector('[aria-label="세션 검색 열기"]').click()""")
    page.get_by_placeholder("검색어를 입력하세요...").fill("검수")


def open_document_reader(page: Page) -> None:
    page.goto("/dialogues?sample=document-reader&loading=1")
    page.wait_for_selector('[data-testid="internal-document-dialog"]', state="visible", timeout=30000)


def open_ritual_modal(context, page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    if page.viewport_size["width"] <= 760:
        # 좁은 폭의 "카드" 탭은 카드 보드다. 기록 단추로 일일 플래너를 연다.
        page.click('[data-testid="v3-mobile-tab-today"]')
        page.wait_for_selector('[aria-label="기록"]', state="attached", timeout=30000)
        page.evaluate("""() => document.querySelector('[aria-label="기록"]').click()""")
    else:
        page.get_by_text("(오늘)").first.click()
    page.wait_for_selector('[aria-label="아침 정리"]', state="attached", timeout=30000)
    page.wait_for_timeout(800)
    # 아침 정리 조회가 여러 API 를 부른다. 모두 붙잡아 로딩 상태로 둔다.
    held = Held()
    context.route("**/api/**", held)
    page.evaluate("""() => document.querySelector('[aria-label="아침 정리"]').click()""")


def open_runtime_sample(page: Page) -> None:
    page.goto("/components?sample=runtime-loading")
    page.wait_for_selector('[data-testid="runtime-loading-review"]', state="visible", timeout=60000)


def judge_loading(measurement: dict, mode: str) -> dict:
    if "error" in measurement:
        return {"passed": False, "reason": measurement["error"]}
    tokens_passed = all(measurement["checks"].values())
    if not measurement["visible"]:
        return {"passed": False, "reason": "로딩 요소가 보이지 않음", "tokens": tokens_passed}
    horizontal = abs(measurement["dx"]) <= TOLERANCE_PX
    if mode == "fill":
        vertical = abs(measurement["dy"]) <= TOLERANCE_PX
        placement = horizontal and vertical
        reason = "가로·세로 중심" if placement else "프레임 중심에서 벗어남"
    else:
        symmetric = abs(measurement["gapTop"] - measurement["gapBottom"]) <= TOLERANCE_PX
        placement = horizontal and symmetric
        reason = "가로 중심·프레임 위아래 거리 같음" if placement else "가로 중심 또는 프레임 위아래 거리가 어긋남"
    passed = placement and tokens_passed
    if not passed and placement:
        reason = "토큰 계산값이 다름"
    return {
        "passed": passed,
        "reason": reason,
        "placement": placement,
        "tokensPassed": tokens_passed,
        "horizontal": horizontal,
        **({"vertical": abs(measurement["dy"]) <= TOLERANCE_PX} if mode == "fill" else {
            "gapDifference": round(abs(measurement["gapTop"] - measurement["gapBottom"]), 3),
        }),
    }


def judge_notice(loading: dict, notice: dict) -> dict:
    if "error" in notice:
        return {"passed": False, "reason": notice["error"]}
    dx = round(notice["centerX"] - loading["cluster"]["centerX"], 3)
    dy = round(notice["centerY"] - loading["cluster"]["centerY"], 3)
    passed = abs(dx) <= TOLERANCE_PX and abs(dy) <= TOLERANCE_PX and notice["stylePassed"]
    return {
        "passed": passed,
        "reason": "실패 안내 중심과 글자 모양 일치" if passed else "실패 안내 중심 또는 글자 모양 불일치",
        "dx": dx,
        "dy": dy,
        **notice,
    }


def screenshot_path(out: Path, scene: dict, width: int, theme: str, suffix: str = "") -> Path:
    theme_suffix = "" if theme == "dark" else f"-{theme}"
    return out / f"loading-{scene['key']}-{width}{theme_suffix}{suffix}.png"


def capture_scene(browser, base: str, out: Path, scene: dict, width: int, theme: str) -> dict:
    context = browser.new_context(
        base_url=base,
        viewport={"width": width, "height": VIEWPORT_HEIGHTS[width]},
        color_scheme=theme,
        reduced_motion="reduce",
    )
    install_page(context, theme)
    held = None
    if scene.get("hold"):
        held = Held()
        context.route(scene["hold"], held)
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
    entry = {
        "scene": scene["key"],
        "width": width,
        "theme": theme,
        "frame": scene["frame"],
        "mode": scene["mode"],
        "capture": screenshot_path(out, scene, width, theme).name,
        "passed": False,
    }
    try:
        opener = scene["open"]
        if len(inspect.signature(opener).parameters) >= 2:
            opener(context, page)
        else:
            opener(page)
        wait_selector = scene.get("wait", '[data-slot="frame-loading"]')
        page.wait_for_selector(f'{scene["frame"]} {wait_selector}', state="visible", timeout=30000)
        settle(page)
        measurement = page.evaluate(MEASURE_SCRIPT, {
            "frameSelector": scene["frame"],
            "insetTop": scene.get("insetTop"),
            "insetBottom": scene.get("insetBottom"),
        })
        entry.update(measurement)
        verdict = judge_loading(measurement, scene["mode"])
        entry.update(verdict)
        expected_text = scene.get("expectText")
        if expected_text and measurement.get("text") != expected_text:
            entry["passed"] = False
            entry["reason"] = "로딩 문구가 다름"
        if scene["key"] in ("dashboard-chat-empty", "pas-older"):
            entry["visibleMessages"] = page.locator('text=검수 요청 1').count()
            if scene["key"] == "pas-older" and not entry["visibleMessages"]:
                entry["passed"] = False
                entry["reason"] = "이전 대화 로딩의 기존 대화가 보이지 않음"
        page.screenshot(path=str(screenshot_path(out, scene, width, theme)), animations="disabled")

        if scene["key"] == "completed-board":
            before = page.locator(scene["frame"]).bounding_box()
            if held is None or not held.release(status=200, body={"cards": [], "nextCursor": None}):
                raise RuntimeError("completed request was not held")
            page.get_by_text("선택한 기간에 완료 카드가 없습니다").wait_for(state="visible")
            after = page.locator(scene["frame"]).bounding_box()
            entry["transition"] = {"before": before, "after": after}
            entry["passed"] = bool(entry["passed"] and abs(before["width"] - after["width"]) <= TOLERANCE_PX
                                   and abs(before["height"] - after["height"]) <= TOLERANCE_PX)
            page.screenshot(path=str(screenshot_path(out, scene, width, theme, "-after")), animations="disabled")

        extra = scene.get("extra")
        if extra:
            extra_result = extra(page)
            entry["extra"] = extra_result
            extra_passed = extra_result.get("passed", False)
            entry["passed"] = bool(entry["passed"] and extra_passed)
            if not extra_passed:
                entry["reason"] = extra_result.get("reason", "추가 단언 실패")

        if scene["key"] == "atom-selector":
            if held is None or not held.release(status=200, body=ATOM_NODES):
                raise RuntimeError("atom request was not held")
            page.get_by_text("소울스트림 아키텍처", exact=True).wait_for(state="visible", timeout=30000)
            entry["atomLoaded"] = True
            page.screenshot(path=str(screenshot_path(out, scene, width, theme, "-after")), animations="disabled")

        if scene["key"] == "session-stats":
            before = entry["extra"]
            if held is None or not held.release(status=200, body=stats_overview()):
                raise RuntimeError("statistics request was not held")
            page.wait_for_function("() => !document.querySelector('.usage-stats-chart [data-slot=frame-loading]')", timeout=30000)
            page.wait_for_timeout(300)
            after = page.evaluate(STATS_SCRIPT)
            delta = round(after["chartTop"] - before["chartTop"], 2)
            entry["statsTransition"] = {"before": before, "after": after, "deltaTop": delta,
                                        "passed": abs(delta) <= TOLERANCE_PX}
            page.screenshot(path=str(screenshot_path(out, scene, width, theme, "-after")), animations="disabled")
            if abs(delta) > TOLERANCE_PX:
                entry["passed"] = False
                entry["reason"] = "세션 통계 차트 위 끝 이동"

        if scene.get("fail") and "cluster" in measurement:
            anchor_text = scene.get("anchorText")
            anchor_before = page.evaluate(ANCHOR_SCRIPT, anchor_text) if anchor_text else None
            if held is None:
                raise RuntimeError("fail scene requires a held route")
            held.release(status=500, body={"error": "boom"})
            page.wait_for_selector('[data-slot="frame-notice"]', state="visible", timeout=30000)
            page.wait_for_timeout(500)
            notice = page.evaluate(NOTICE_SCRIPT, scene["key"])
            notice_verdict = judge_notice(measurement, notice)
            anchor_after = page.evaluate(ANCHOR_SCRIPT, anchor_text) if anchor_text else None
            anchor_verdict = {"passed": True}
            if anchor_text and anchor_before and anchor_after:
                delta = round(anchor_after["top"] - anchor_before["top"], 3)
                anchor_verdict = {
                    "passed": abs(delta) <= TOLERANCE_PX,
                    "reason": "뒤 구역 위치 불변" if abs(delta) <= TOLERANCE_PX else "뒤 구역이 움직임",
                    "deltaTop": delta,
                    "text": anchor_text,
                }
            entry["failure"] = {
                **notice_verdict,
                "anchor": anchor_verdict,
            }
            failure_shot = screenshot_path(out, scene, width, theme, "-fail")
            page.screenshot(path=str(failure_shot), animations="disabled")
            entry["failureCapture"] = failure_shot.name
            if not (notice_verdict["passed"] and anchor_verdict["passed"]):
                entry["passed"] = False
                entry["reason"] = notice_verdict["reason"] if not notice_verdict["passed"] else anchor_verdict["reason"]

        print(
            f"{scene['key']}-{width}{'-' + theme if theme != 'dark' else ''}: "
            f"dx={entry.get('dx')} dy={entry.get('dy')} "
            f"gap=({entry.get('gapTop')},{entry.get('gapBottom')}) "
            f"tokens={entry.get('checks')} → {entry.get('reason')}"
        )
        return entry
    finally:
        context.close()


def capture_runtime(browser, base: str, out: Path, scene: dict, width: int, theme: str) -> dict:
    context = browser.new_context(
        base_url=base,
        viewport={"width": width, "height": VIEWPORT_HEIGHTS[width]},
        color_scheme=theme,
        reduced_motion="reduce",
    )
    install_page(context, theme)
    held = Held()
    context.route(re.compile(
        r"/api/sessions/(review-runtime-loading|review-runtime-loaded|review-runtime-refresh)/schedules$"
    ), held)
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
    entry = {
        "scene": scene["key"],
        "width": width,
        "theme": theme,
        "capture": screenshot_path(out, scene, width, theme).name,
        "passed": False,
    }
    try:
        open_runtime_sample(page)
        page.wait_for_timeout(1200)
        settle(page)
        loading = page.evaluate(RUNTIME_LOADING_SCRIPT)
        page.screenshot(path=str(screenshot_path(out, scene, width, theme)), animations="disabled")
        # 앞의 두 패널 요청만 풀고, 새로고침 패널 요청은 붙잡아 단추 회전을 남긴다.
        held.release(
            status=200,
            body=RUNTIME_SCHEDULES,
            exclude=lambda url: "/review-runtime-refresh/schedules" in url,
        )
        page.wait_for_timeout(1200)
        after = page.evaluate(RUNTIME_RESPONSE_SCRIPT)
        failure_shot = screenshot_path(out, scene, width, theme, "-after")
        page.screenshot(path=str(failure_shot), animations="disabled")
        loading_passed = (
            loading.get("sections") == 0
            and not loading.get("hasCount")
            and loading.get("error") is None
        )
        after_passed = (
            after.get("firstLoadingSections") == 1
            and after.get("collapsed") == "false"
            and after.get("firstLoadingLoader") is False
            and after.get("refreshSpinning") is True
        )
        entry.update({
            "loading": loading,
            "after": after,
            "afterCapture": failure_shot.name,
            "passed": loading_passed and after_passed,
            "reason": "첫 로딩 빈 띠 · 응답 뒤 접힌 머리줄 · 새로고침 단추 회전"
            if loading_passed and after_passed else "런타임 띠 동작이 다름",
        })
        print(
            f"{scene['key']}-{width}: loading={loading} after={after} → {entry['reason']}"
        )
        return entry
    finally:
        context.close()


def metrics(total):
    return {
        "input_total": 110, "cache_read": 60, "cache_write": 10, "output_total": 50, "reasoning_output": None,
        "total_tokens": total, "provider_total_tokens": total + 60, "ordinary_input": 40, "reference_cost_usd": 123.45,
        "reference_cost_breakdown": {"cache_read": {"known_cost_usd": 45, "is_partial": False},
                                     "non_cache": {"known_cost_usd": 78.45, "is_partial": False}},
    }


def aggregate(total):
    return {"metrics": metrics(total), "coverage": {
        "usage_complete_events": 1, "usage_partial_events": 0, "terminal_missing_usage": 0, "ended_input_without_usage": 0,
        "missing_usage_turns": 0, "pending_inputs": 0, "priced_events": 1, "unpriced_events": 0,
        "priced_total_tokens": total, "unpriced_total_tokens": None, "unknown_total_token_events": 0,
        "unattributed_missing_usage": False,
        "token_partials": {"total_tokens": False, "provider_total_tokens": False, "ordinary_input": False, "cache_read": False}},
        "is_partial": False}


def stats_overview():
    return {
        "schema_version": 1, "generated_at": "2026-11-18T03:00:00.000Z", "as_of": "2026-11-18T03:00:00.000Z",
        "range": {"period": "week", "since": "2026-11-16", "until": "2026-11-23", "effective_until": "2026-11-19",
                  "timezone": "Asia/Seoul", "bucket": "day"},
        "policies": {"date_attribution": "recorded_terminal", "project_attribution": "current_folder",
                     "price_version": "api-list-usd-2026-10-19-v1"},
        "projection_status": {"state": "ready", "covered_since": "2026-10-01"},
        "totals": aggregate(1_234_567), "by_model": [], "by_project": [],
        "series": [],
        "options": {"providers": [{"provider": "anthropic", "label": "Anthropic"}],
                    "models": [{"provider": "anthropic", "model": "claude-opus", "backend": "claude", "label": "Opus"}],
                    "projects": [], "project_roster": [], "model_rosters": [{"provider": "anthropic", "models": ["claude-opus"]}]},
    }



def stats_extra(page: Page) -> dict:
    result = page.evaluate(STATS_SCRIPT)
    passed = (
        result["loaderCount"] == 1
        and result["chartLoader"]
        and result["loadingTextCount"] == 1
        and all(value == "" for value in result["summaryValues"])
        and not result["shareList"]
    )
    return {
        **result,
        "passed": passed,
        "reason": "막대 프레임 로더 하나 · 값 자리 비움 · 점유 목록 없음"
        if passed else "세션 통계 로딩 표시가 하나가 아님",
    }


ATOM_NODES = {"children": [
    {"id": f"node-{i}", "card_id": f"card-{i}", "card": {"title": title, "card_type": "structure"}}
    for i, title in enumerate(["에이전트", "프로젝트", "소울스트림 아키텍처"])
]}


def open_atom_selector(context, page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    open_folder(page)
    page.wait_for_selector('[aria-label="atom 추가"]', state="visible", timeout=30000)
    page.evaluate("() => document.querySelector('[aria-label=\"atom 추가\"]').click()")
    page.get_by_text("노드 선택...", exact=True).first.wait_for(state="visible", timeout=15000)


def session_summary(session_id: str) -> dict:
    return {"agent_session_id": session_id, "status": "completed", "session_type": "claude",
            "node_id": "eiaserinnys", "folder_id": "folder-1", "agent_id": "default", "event_count": 20,
            "display_name": "검수 세션", "created_at": "2026-11-17T00:00:00.000Z", "updated_at": "2026-11-18T03:00:00.000Z"}


def session_routes(context, session_id: str) -> None:
    load_json(context, re.compile(r"/api/sessions\?.*" + session_id), {"sessions": [session_summary(session_id)], "total": 1})
    context.route(re.compile(r"/api/sessions/" + session_id + r"/events"), lambda route: route.fulfill(
        status=200, content_type="text/event-stream",
        body='event: history_sync\nid: 30\ndata: {"type":"history_sync","last_event_id":30}\n\n'))


def open_dashboard_chat(context, page: Page) -> None:
    session_routes(context, "dash-1")
    if page.viewport_size["width"] <= 760:
        folder_session = {"agentSessionId": "dash-1", "status": "completed", "sessionType": "claude",
                          "nodeId": "eiaserinnys", "folderId": "folder-1", "agentId": "default",
                          "eventCount": 20, "displayName": "검수 세션", "prompt": "로딩 표시를 가운데로",
                          "createdAt": "2026-11-17T00:00:00.000Z", "updatedAt": "2026-11-18T03:00:00.000Z",
                          "completedAt": "2026-11-18T03:00:00.000Z"}
        load_json(context, "**/api/planner/folders/folder-1*", {
            **PROJECT_AGGREGATE, "sessions": {"items": [folder_session], "nextCursor": None},
        })
        page.goto("/")
        wait_shell(page)
        open_folder(page)
        page.get_by_text("검수 세션").first.wait_for(state="visible", timeout=20000)
        page.evaluate("""() => {
          const el = Array.from(document.querySelectorAll('.v3-runs *'))
            .find(e => (e.textContent || '').trim() === '검수 세션');
          (el.closest('button,[role=button],[tabindex]') || el).click();
        }""")
    else:
        page.goto("/?session=dash-1")
        wait_shell(page)


def open_pas_older(context, page: Page) -> None:
    load_json(context, "**/api/persistent-sessions", {**PAS_LIST, "sessions": [PAS_CHAT_SESSION], "total": 1})
    session_routes(context, "pas-1")
    held = Held()
    messages = []
    for i in range(3):
        eid = 10 + i * 2
        messages.extend([
            {"id": eid, "parent_event_id": None, "event_type": "user_message",
             "payload": {"type": "user_message", "text": f"검수 요청 {i + 1}", "user": "qa"},
             "created_at": f"2026-11-18T0{i}:00:00.000Z"},
            {"id": eid + 1, "parent_event_id": eid, "event_type": "assistant_message",
             "payload": {"type": "assistant_message", "content": f"확인 {i + 1}"},
             "created_at": f"2026-11-18T0{i}:00:05.000Z"},
        ])
    def timeline(route):
        if "before=" in route.request.url:
            held(route)
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"messages": messages, "next_cursor": "2026-11-17T00:00:00.000Z"}))
    context.route(re.compile(r"/api/sessions/pas-1/timeline"), timeline)
    page.goto("/persistent/pas-1")
    wait_shell(page)
    page.wait_for_timeout(4000)
    page.evaluate("() => document.querySelectorAll('[data-virtuoso-scroller], .persistent-session-main *').forEach(e => { if (e.scrollHeight > e.clientHeight) e.scrollTop = 0; })")


def search_payload(count: int) -> dict:
    return {"results": [{"session_id": f"sess-{i}", "event_id": 100 + i, "score": 1.0 - i * 0.1,
                         "preview": f"검수 대상 메시지 미리보기 {i}", "event_type": "user_message",
                         "match_source": "message"} for i in range(count)],
            "navigation_results": [], "session_results": [], "search_status": None, "total": count}


def capture_search_states(browser, base: str, out: Path, scene: dict, width: int, theme: str) -> dict:
    context = browser.new_context(base_url=base, viewport={"width": width, "height": VIEWPORT_HEIGHTS[width]},
                                  color_scheme=theme, reduced_motion="reduce")
    install_page(context, theme)
    load_json(context, re.compile(r"/cogito/search\?"), search_payload(2))
    page = context.new_page()
    try:
        page.goto("/")
        wait_shell(page)
        page.wait_for_selector('[aria-label="세션 검색 열기"]', state="attached", timeout=30000)
        page.evaluate("() => document.querySelector('[aria-label=\"세션 검색 열기\"]').click()")
        field = page.get_by_placeholder("검색어를 입력하세요...")
        field.wait_for(state="visible")
        settle(page)
        focus_on_open = field.evaluate("e => document.activeElement === e")
        region = page.locator('[data-slot="search-results-region"]')
        initial_height = region.bounding_box()["height"]
        field.fill("검수")
        page.wait_for_timeout(1300)
        results_height = region.bounding_box()["height"]
        has_results = "검수 대상 메시지" in region.inner_text()
        page.screenshot(path=str(screenshot_path(out, scene, width, theme, "-results")), animations="disabled")
        load_json(context, re.compile(r"/cogito/search\?"), search_payload(0))
        field.fill("빈 결과")
        page.wait_for_timeout(1300)
        empty_height = region.bounding_box()["height"]
        has_empty = "검색 결과" in region.inner_text()
        page.set_viewport_size({"width": 360, "height": 844})
        page.wait_for_timeout(200)
        narrow_overflow = page.evaluate("() => document.documentElement.scrollWidth > document.documentElement.clientWidth")
        page.keyboard.press("Tab")
        tab_inside = page.evaluate("() => !!document.activeElement.closest('[role=dialog]')")
        field.fill("유지할 입력")
        other_width = 390 if width == 1440 else 1440
        page.set_viewport_size({"width": other_width, "height": VIEWPORT_HEIGHTS[other_width]})
        page.wait_for_timeout(300)
        resize = page.evaluate("""() => ({overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          value: document.querySelector('[placeholder="검색어를 입력하세요..."]').value,
          dialog: !!document.querySelector('[role=dialog]')})""")
        page.keyboard.press("Escape")
        page.locator('[data-slot="dialog-popup"]:visible').wait_for(state="hidden", timeout=10000)
        esc_closed = page.locator('[data-slot="dialog-popup"]:visible').count() == 0
        passed = (has_results and has_empty and focus_on_open and tab_inside and esc_closed and not resize["overflow"] and resize["dialog"]
                  and not narrow_overflow and resize["value"] == "유지할 입력" and min(initial_height, results_height, empty_height) >= 159)
        return {"scene": scene["key"], "width": width, "theme": theme, "passed": passed,
                "reason": "검색 상태와 키보드·크기 변경" if passed else "검색 상태 또는 조작 실패",
                "initialHeight": initial_height, "resultsHeight": results_height, "emptyHeight": empty_height,
                "hasResults": has_results, "hasEmpty": has_empty, "narrow360Overflow": narrow_overflow, "focusOnOpen": focus_on_open, "tabInside": tab_inside, "escapeClosed": esc_closed, "resize": resize}
    finally:
        context.close()


SCENES = [
    {
        "key": "card-board",
        "frame": '.v3-card-inbox[data-card-scope="all"]',
        "mode": "fill",
        "open": open_card_board,
        "hold": re.compile(r"/api/cards\?.*includeCompleted=false"),
        "fail": True,
    },
    {
        "key": "completed-cards",
        "frame": '[data-testid="completed-viewport"]',
        "mode": "content",
        "open": open_completed_cards,
        "hold": re.compile(r"/api/cards\?.*\bstatus=done\b"),
    },
    {
        "key": "completed-board",
        "frame": '[data-board-column="done"] [data-testid="completed-viewport"]',
        "mode": "fill",
        "open": open_completed_board,
        "hold": re.compile(r"/api/cards\?.*\bstatus=done\b"),
    },
    {
        "key": "folder-body",
        "frame": ".v3-inline-board-item",
        "insetTop": ".v3-inline-board-row",
        "mode": "content",
        "open": open_folder_body,
        "hold": re.compile(r"/api/markdown-documents/"),
        "fail": True,
        "anchorText": "세션 히스토리",
    },
    {
        "key": "planner",
        "frame": ".v3-planner-loading",
        "mode": "fill",
        "open": lambda page: open_folder_after_home(page),
        "hold": "**/api/planner/folders/folder-1*",
        "fail": True,
    },
    {
        "key": "pas-screen",
        "frame": ".persistent-session-main",
        "mode": "fill",
        "open": open_pas_screen,
        "hold": "**/api/persistent-sessions",
        "fail": True,
    },
    {
        "key": "pas-chat-empty",
        "frame": '[data-slot="chat-transcript-fill"]',
        "mode": "fill",
        "open": open_pas_chat,
        "expectText": "대화를 불러오는 중",
    },
    {
        "key": "settings-tab",
        "frame": ".config-detail",
        "insetTop": ".config-detail-heading",
        "mode": "fill",
        "open": open_settings_tab,
        "hold": "**/api/agent-profiles",
        "fail": True,
    },
    {
        "key": "search-modal",
        "frame": '[data-slot="search-results-region"]',
        "mode": "fill",
        "open": open_search_modal,
        "hold": re.compile(r"/cogito/search\?"),
        "themes": ("dark", "light"),
    },
    {
        "key": "ritual-modal",
        "frame": ".v3-ritual-message",
        "mode": "fill",
        "open": open_ritual_modal,
        "themes": ("dark", "light"),
    },
    {
        "key": "document-reader",
        "frame": '[data-testid="internal-document-dialog"] [data-slot="dialog-panel"]',
        "mode": "fill",
        "open": open_document_reader,
        "hold": re.compile(r"/api/markdown-documents/sample-linked-document"),
        "fail": True,
    },
    {
        "key": "session-stats",
        "frame": ".usage-stats-chart",
        "mode": "fill",
        "open": open_usage_stats,
        "hold": re.compile(r"/api/session-statistics"),
        "wait": '[data-slot="frame-loading"]',
        "extra": stats_extra,
    },
    {"key": "atom-selector", "frame": "div.max-h-48", "mode": "content", "open": open_atom_selector,
     "hold": re.compile(r"/api/atom/nodes")},
    {"key": "pas-older", "frame": '[data-slot="chat-manuscript-list-header"]', "mode": "content",
     "open": open_pas_older, "expectText": "이전 대화를 불러오는 중"},
    {"key": "dashboard-chat-empty", "frame": '[data-slot="chat-transcript-fill"]', "mode": "fill",
     "open": open_dashboard_chat, "hold": re.compile(r"/api/sessions/dash-1/timeline"),
     "expectText": "대화를 불러오는 중"},
    {"key": "search-states", "mode": "search-behavior"},
    {
        "key": "runtime-strips",
        "mode": "behavior",
        "open": open_runtime_sample,
    },
]



def open_folder_after_home(page: Page) -> None:
    page.goto("/")
    wait_shell(page)
    open_folder(page)


def main() -> int:
    parser = argparse.ArgumentParser(description="프레임 로딩·실패 자리 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    parser.add_argument("--theme", choices=("dark", "light", "all"), default="all")
    parser.add_argument("--screen", action="append", choices=[scene["key"] for scene in SCENES],
                        help="이 화면만 찍는다 (여러 번 지정 가능)")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    scenes = [scene for scene in SCENES if not args.screen or scene["key"] in args.screen]
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in WIDTHS:
                for scene in scenes:
                    themes = scene.get("themes", ("dark",))
                    for theme in themes:
                        if args.theme != "all" and theme != args.theme:
                            continue
                        try:
                            if scene.get("mode") == "search-behavior":
                                captures.append(capture_search_states(browser, base, out, scene, width, theme))
                            elif scene.get("mode") == "behavior":
                                captures.append(capture_runtime(browser, base, out, scene, width, theme))
                            else:
                                captures.append(capture_scene(browser, base, out, scene, width, theme))
                        except Exception as error:  # noqa: BLE001 — 장면별 실패를 기록하고 나머지를 계속 잰다.
                            captures.append({"scene": scene["key"], "width": width, "theme": theme,
                                             "passed": False, "reason": str(error)})
        finally:
            browser.close()

    failures = [entry for entry in captures if not entry["passed"]]
    report = {
        "baseUrl": base,
        "theme": args.theme,
        "tolerancePx": TOLERANCE_PX,
        "widths": list(WIDTHS),
        "captures": captures,
        "assertions": {
            "placementAndTokens": {
                "passed": not failures,
                "failures": [
                    {"scene": entry["scene"], "width": entry["width"], "reason": entry["reason"]}
                    for entry in failures
                ],
            },
        },
    }
    report["passed"] = not failures
    (out / "measurements.json").write_text(
        json.dumps({"tolerancePx": TOLERANCE_PX, "captures": captures}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for entry in captures:
        print(
            f"{entry['scene']} {entry['width']}px: dx={entry.get('dx')} dy={entry.get('dy')} "
            f"gap=({entry.get('gapTop')},{entry.get('gapBottom')}) → {entry['reason']}"
        )
    if failures:
        print("\n".join(
            f"실패: {entry['scene']} {entry['width']}px · {entry['reason']}" for entry in failures
        ), file=sys.stderr)
        return 1
    print(f"판정: {len(captures)}건 · 배치 {TOLERANCE_PX}px · 토큰 계산값 통과")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

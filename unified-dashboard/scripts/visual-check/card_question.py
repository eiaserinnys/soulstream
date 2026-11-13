#!/usr/bin/env python3
"""카드 질문 장 시각 검수.

컴포넌트 검수 창(`/components`)의 카드 질문 장 표본을 카드 상세와 PAS 판 두 표면으로
넓은 폭(1440)과 좁은 폭(390), 라이트와 다크에서 찍고, 장면마다 계약이 정한 부품과
글자가 서는지 잰다. PAS 판은 1440x900 좌표의 말풍선 자리에서 접힌 장과 펼친 장을 찍는다.

장면(시안 df63ae1b1의 이름)

    ga      새 선택 질문(그림, 권함, 선택지 설명)
    na      선택 뒤 덧붙이기 대상 줄과 입력창
    da      글타래와 「답을 기다리는 중」, 「고침」
    ra      부탁 장(번호 목록 본문, 선택지 없음, 「했어」가 맨 오른쪽)
    legacy  옛 질문(제목 없음, 선택지 설명 없음). PAS 판에서도 접힌 장을 찍는다.

조작 항목(UI 기준 11, 14~18번)

    11 글자 선택      본문과 글타래 글은 끌어서 골라지고, 선택지·동작 줄 단추 글자는 골라지지 않는다.
    14 누른 뒤 초점    되묻기를 누르면 커멘트 입력창에 초점이 가고, 확대를 누르면 초점이 확대/축소 단추에 남는다.
                       선택지를 한 번 누르면 초점을 입력창으로 옮기지 않고 덧붙이기 대상 줄만 선다(계약 3).
                       펼친 장에서도 선택지를 실제로 눌러 누른 행·덧붙이기 대상이 남고 초점이 BODY로 떨어지지 않는지 잰다.
                       대상 줄의 「해제」를 누르면 입력창으로 초점이 간다.
    15 Tab과 Esc      질문 장 안의 DOM 순서(Tab 순서)가 읽는 순서(머리 → 본문 → 동작 줄)와 같고, 보이지 않는 요소는 빠진다.
                       카드 상세는 한 열이라 좌표 오름차순으로도 함께 잰다. PAS 판은 발치 줄이 붙박이라 구역 순서로 잰다.
                       펼친 장은 대화상자가 아니라 제자리 확장이라 Esc로 닫지 않는다(계약에 없음). Esc를 눌러도 상태가 바뀌지 않는지만 잰다.
    16 좁은 폭 넘침   390 폭에서 페이지, 질문 본문, 선택지에 가로 넘침이 없다.
    17 오류 상태는 해당 없음: 질문 장은 따로 받는 자료가 없고, 보내기 실패는 기존 카드 오류 줄이 맡는다.
    18 창 크기 바꾸기  카드 상세를 1440에서 연 채 390으로 줄여도 제목과 입력 중인 글이 남고 넘치지 않는다.
                       PAS 표본은 1440x900 좌표를 고정한 하네스라 리사이즈는 카드 상세에서만 잰다.
                       시험이 남긴 초안은 지운 뒤 좁은 폭 장면을 찍는다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/card_question.py \
        http://127.0.0.1:5173 /path/to/output

산출물

    {출력}/card-question-{표면}-{장면}-{폭}-{테마}.png             표면별 장면 캡처
    {출력}/card-question-pas-{장면}-expanded-1440-{테마}.png        펼친 장 캡처
    {출력}/card-question-pas-ga-expanded-answered-1440-{테마}.png   펼친 장에서 선택지를 누른 뒤
    {출력}/card-question-pas-ga-expanded-bottom-1440-{테마}.png     펼친 장을 바닥까지 스크롤한 캡처
    {출력}/card-question-pas-card-existing-bottom-1440-{테마}.png   기존 PAS 카드 펼친 장 바닥
    {출력}/card-question-pas-paging-{long,short}-{1440,390}-{테마}.png
                                                                   PAS 판에서 긴 질문 장과 한 줄 카드 장 (카드 #1197)
    {출력}/measurements.json                                        장면별 잰 값과 조작 결과
    {출력}/report.json                                              판정과 실패 목록

표준 출력에는 캡처마다 한 줄, 마지막에 판정 요약을 남긴다.
계약이 정한 부품·글자·동작 줄이 어긋나거나, 넘침이 있거나, 초점이 계약과 다르면
종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

THEMES = ("light", "dark")
WIDE = 1440
NARROW = 390
CARD_SCENES = ("ga", "na", "da", "ra", "legacy")
PAS_COLLAPSED = ("ga", "da", "ra", "legacy")
PAS_EXPANDED = ("ga", "na")
GA_TITLE = "에이전트 접속 비밀값을 숨길까요?"
REQUEST_TITLE = "아이폰 앱을 업데이트해 주십시오"
NA_LABEL = "파일로 옮기기"
NA_DRAFT = "이대로, 열만 맞춰서"

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

CARD_SCRIPT = """
() => {
  const root = document.querySelector('[data-testid="card-question-review"]');
  const body = root.querySelector('.v3-card-question-body');
  const background = body?.querySelector('.v3-card-question-background');
  const choices = root.querySelector('.v3-card-question-choices');
  const actions = root.querySelector('.v3-card-question-actions');
  const overflow = (element) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
  const userSelect = (element) => element ? getComputedStyle(element).userSelect : null;
  const text = root.textContent ?? '';
  return {
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    bodyOverflowX: overflow(body),
    choicesOverflowX: overflow(choices),
    title: root.querySelector('.v3-card-question-title')?.textContent?.trim() ?? null,
    background: background?.textContent?.trim() ?? null,
    backgroundItems: background?.querySelectorAll('ol > li').length ?? 0,
    selection: {
      background: userSelect(background),
      thread: userSelect(root.querySelector('.v3-card-question-turn')),
      choice: userSelect(choices?.querySelector('button')),
      action: userSelect(actions?.querySelector('button')),
    },
    choices: [...root.querySelectorAll('.v3-card-question-choices button')].map((button) => ({
      label: button.textContent.trim(),
      selected: button.getAttribute('data-selected') === 'true',
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled') === 'true',
    })),
    actions: [...root.querySelectorAll('.v3-card-question-actions button')].map((button) => button.textContent.trim()),
    recommendations: root.querySelectorAll('.v3-card-question-recommended').length,
    images: root.querySelectorAll('[data-evidence-type="image"] img').length,
    thread: [...root.querySelectorAll('.v3-card-question-thread > li')].map((item) => ({
      author: item.getAttribute('data-author'),
      waiting: item.getAttribute('data-waiting') === 'true',
      text: item.textContent.trim(),
    })),
    notice: root.querySelector('.v3-card-target-notice')?.textContent?.trim() ?? null,
    placeholder: root.querySelector('textarea')?.getAttribute('placeholder') ?? null,
    draft: root.querySelector('textarea')?.value ?? null,
    // '고침'은 질문 말풍선 머리에만 붙는다. '지금' 패널 본문에도 같은 낱말이 있어
    // 장 전체 글자로 재면 옛 질문 장면이 거짓으로 걸린다.
    hasRevised: Boolean([...root.querySelectorAll('[data-card-entry]')]
      .find((entry) => entry.querySelector('.v3-card-question-body'))
      ?.querySelector('.v3-card-bubble-kind')?.textContent?.includes('고침')),
    hasWaitingText: text.includes('답을 기다리는 중'),
  };
}
"""

SHEET_SCRIPT = """
() => {
  const root = document.querySelector('[data-testid="card-question-review"]');
  const sheet = root.querySelector('.pas-report-sheet[data-current="true"]');
  const content = sheet?.querySelector('.pas-report-content');
  const body = content?.querySelector(':scope > .v3-card-question-body');
  const background = body?.querySelector('.v3-card-question-background');
  const footer = sheet?.querySelector('.pas-report-footer');
  const overflow = (element) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
  const userSelect = (element) => element ? getComputedStyle(element).userSelect : null;
  const answered = (() => {
    const row = footer?.querySelector('.v3-card-question-answered');
    const button = row?.querySelector('[data-slot="button"]');
    if (!footer || !row || !button) return null;
    const style = getComputedStyle(button);
    const answerText = footer.querySelector('.v3-card-question-answer');
    const font = (element) => { const computed = getComputedStyle(element); return computed.fontSize + '/' + computed.lineHeight + ' ' + computed.fontWeight; };
    return {
      paddingLeft: Math.round(parseFloat(style.paddingLeft) * 10) / 10,
      paddingRight: Math.round(parseFloat(style.paddingRight) * 10) / 10,
      rightGap: Math.round((footer.getBoundingClientRect().right - button.getBoundingClientRect().right) * 10) / 10,
      buttonFont: font(button),
      answerFont: answerText ? font(answerText) : null,
    };
  })();
  return {
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    sheetOverflowX: overflow(sheet),
    bodyOverflowX: overflow(body),
    title: sheet?.querySelector('.pas-report-title')?.textContent?.trim() ?? null,
    chip: sheet?.querySelector('[data-slot="status-chip"]')?.textContent?.trim() ?? null,
    meta: sheet?.querySelector('.v3-card-question-meta')?.textContent?.trim() ?? null,
    backgroundItems: background?.querySelectorAll('ol > li').length ?? 0,
    recommendations: body?.querySelectorAll('.v3-card-question-recommended').length ?? 0,
    selection: {
      background: userSelect(background),
      thread: userSelect(body?.querySelector('.v3-card-question-turn')),
      choice: userSelect(body?.querySelector('.v3-card-question-choices button')),
      action: userSelect(footer?.querySelector('button')),
    },
    choices: [...(body?.querySelectorAll('.v3-card-question-choices button') ?? [])].map((button) => ({
      label: button.textContent.trim(),
      selected: button.getAttribute('data-selected') === 'true',
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled') === 'true',
    })),
    actions: [...(sheet?.querySelectorAll('.pas-report-footer button') ?? [])].map((button) => button.textContent.trim()),
    thread: [...(body?.querySelectorAll('.v3-card-question-thread > li') ?? [])].map((item) => ({
      author: item.getAttribute('data-author'),
      waiting: item.getAttribute('data-waiting') === 'true',
      text: item.textContent.trim(),
    })),
    answered,
    notice: sheet?.querySelector('.v3-card-target-notice')?.textContent?.trim() ?? null,
    placeholder: sheet?.querySelector('textarea')?.getAttribute('placeholder') ?? null,
    draft: sheet?.querySelector('textarea')?.value ?? null,
    expanded: Boolean(sheet?.querySelector('.pas-report-card-preview')),
  };
}
"""

FOCUS_SCRIPT = """
() => {
  const element = document.activeElement;
  if (!element) return { tag: null };
  return {
    tag: element.tagName,
    label: element.getAttribute('aria-label'),
    placeholder: element.getAttribute('placeholder'),
    text: (element.textContent ?? '').trim().slice(0, 40),
  };
}
"""

ORDER_SCRIPT = """
(selector) => {
  const scope = document.querySelector(selector);
  if (!scope) return null;
  return [...scope.querySelectorAll('button:not([disabled]), textarea:not([disabled]), a[href]')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: (element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).trim().slice(0, 30),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      };
    });
}
"""

# PAS 판의 발치 줄은 붙박이라 화면 좌표가 본문 위로 떠오른다. 판은 좌표 대신
# 머리 → 본문 → 펼친 미리보기 → 발치 줄 구역 순서로 Tab 순서를 잰다.
SHEET_ORDER_SCRIPT = """
(selector) => {
  const scope = document.querySelector(selector);
  if (!scope) return null;
  const section = (element) => {
    if (element.closest('.pas-report-heading')) return 0;
    if (element.closest('.pas-report-card-preview')) return 2;
    if (element.closest('.pas-report-content')) return 1;
    if (element.closest('.pas-report-footer')) return 3;
    return 4;
  };
  return [...scope.querySelectorAll('button:not([disabled]), textarea:not([disabled]), a[href]')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: (element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).trim().slice(0, 30),
        section: section(element),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      };
    });
}
"""

# 펼친 장은 스크롤 영역 바닥 여백이 없으면 입력창 초점 링과 그림자가 잘린다.
# 스크롤 영역을 바닥까지 내린 뒤 입력창 아래 간격과 바닥 여백을 함께 잰다.
BOTTOM_SCRIPT = """
(sheetSelector) => {
  const sheet = document.querySelector(sheetSelector);
  if (!sheet) return null;
  const scroller = sheet.querySelector('.pas-report-reading') ?? [...sheet.querySelectorAll('*')]
    .find((element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 2);
  if (!scroller) return { scroller: null };
  scroller.scrollTop = scroller.scrollHeight;
  const rect = scroller.getBoundingClientRect();
  const dock = sheet.querySelector('.v3-card-comment-dock');
  const dockRect = dock?.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  return {
    scroller: true,
    scrollerClass: scroller.className.toString().slice(0, 80),
    scrollerPadBottom: Math.round(parseFloat(style.paddingBottom) * 10) / 10,
    composerGap: dockRect ? Math.round((rect.bottom - dockRect.bottom) * 10) / 10 : null,
  };
}
"""

# 고른 뒤 잠긴 선택지(흐린 행·고른 행)의 cursor와 hover 테두리. 단추를 실제로 눌러 잰다.
CHOICE_STYLE_SCRIPT = """
(selector) => {
  const root = document.querySelector(selector);
  return [...(root?.querySelectorAll('.v3-card-question-choices button') ?? [])].map((button) => {
    const style = getComputedStyle(button);
    return {
      label: button.textContent.trim().slice(0, 20),
      selected: button.getAttribute('data-selected') === 'true',
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled') === 'true',
      cursor: style.cursor,
      border: style.borderTopColor,
      opacity: style.opacity,
    };
  });
}
"""

# 장 둘짜리 표본 판: 답을 저장하면 판이 질문 장을 먼저 빼는지, 보이는 장은 답한 그 장인지.
BOARD_SCRIPT = """
() => {
  const root = document.querySelector('[data-testid="card-question-review"]');
  const screen = root?.querySelector('.persistent-session-screen');
  const sheets = [...(root?.querySelectorAll('.pas-report-sheet') ?? [])];
  const current = root?.querySelector('.pas-report-sheet[data-current="true"]');
  return {
    board: screen?.getAttribute('data-board') ?? null,
    sheets: sheets.length,
    current: current?.getAttribute('data-testid') ?? null,
    answered: current?.getAttribute('data-answered') ?? null,
  };
}
"""

# 카드 #1197: 판 높이는 가장 긴 장이 아니라 지금 보이는 장을 따른다. 장을 넘기기 전과 뒤에
# 판 높이, 지금 장의 내용 높이, 아래 단추 줄과 넘기기 줄의 화면 좌표(문서 기준)를 잰다.
PAGING_SCRIPT = """
() => {
  const root = document.querySelector('[data-testid="card-question-review"]');
  const deck = root?.querySelector('.pas-report');
  const sheet = root?.querySelector('.pas-report-sheet[data-current="true"]');
  const content = sheet?.querySelector('.pas-report-content');
  const reading = sheet?.querySelector('.pas-report-reading');
  const footer = sheet?.querySelector('.pas-report-footer');
  const nav = root?.querySelector('.pas-report-nav');
  const track = root?.querySelector('.pas-report-track');
  const buttons = [...(footer?.querySelectorAll('button') ?? [])];
  const round = (value) => Math.round(value * 10) / 10;
  const box = (element) => element ? element.getBoundingClientRect() : null;
  const pageTop = (element, edge) => element ? round(box(element)[edge] + window.scrollY) : null;
  return {
    page: sheet?.getAttribute('aria-label') ?? null,
    sheet: sheet?.getAttribute('data-testid') ?? null,
    deckHeight: deck ? round(box(deck).height) : null,
    deckTop: pageTop(deck, 'top'),
    deckBottom: pageTop(deck, 'bottom'),
    contentHeight: content ? round(box(content).height) : null,
    contentScrollHeight: reading ? Math.round(reading.scrollHeight) : null,
    footerTop: pageTop(footer, 'top'),
    footerBottom: pageTop(footer, 'bottom'),
    buttonRowTop: buttons.length ? round(Math.min(...buttons.map(button => box(button).top + window.scrollY))) : null,
    buttonRowBottom: buttons.length ? round(Math.max(...buttons.map(button => box(button).bottom + window.scrollY))) : null,
    navTop: pageTop(nav, 'top'),
    scrollLeft: track ? Math.round(track.scrollLeft) : null,
    trackWidth: track ? Math.round(track.clientWidth) : null,
    scrollY: Math.round(window.scrollY),
  };
}
"""

# 검수 창 전체 목록에서 카드 상세 질문 표본 다섯이 함께 떠도 각자 제 질문을 그리는지.
GALLERY_SCRIPT = """
() => [...document.querySelectorAll('[data-testid="card-question-card-sample"]')].map((sample) => ({
  body: Boolean(sample.querySelector('.v3-card-question-body')),
  error: sample.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
}))
"""

DRAG_BOX_SCRIPT = """
({ selector, index }) => {
  const element = document.querySelectorAll(selector)[index];
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x0: rect.left + 2, x1: rect.right - 2, y: rect.top + rect.height / 2 };
}
"""

CARD_SCOPE = '[data-testid="card-question-card-sample"]'
SHEET_SCOPE = '[data-testid="card-question-review"] .pas-report-sheet[data-current="true"]'
SCREEN_SCOPE = '[data-testid="card-question-review"] .persistent-session-screen'
EXISTING_SHEET_SCOPE = '.pas-report-sheet[data-current="true"]'

# 대시보드 배경의 WebGL 캔버스가 캡처마다 15~30초를 쓰고, 도는 애니메이션은 요소 상자를
# 계속 움직여 요소 스크린샷의 안정화 대기가 끝나지 않는다. 표본 판정에는 둘 다 필요 없어
# 페이지를 연 뒤 캔버스를 숨기고 애니메이션을 멈춘다.
FREEZE_SCRIPT = """
() => {
  for (const canvas of document.querySelectorAll('canvas')) canvas.style.display = 'none';
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.append(style);
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
    page.evaluate(FREEZE_SCRIPT)
    page.wait_for_timeout(150)


def open_card(page: Page, base: str, scene: str, label: str = "") -> None:
    page.goto(f"{base}/components?sample=card-question&surface=card&scene={scene}")
    settle(page)
    page.wait_for_selector(f'{CARD_SCOPE} .v3-card-question-body', state="visible")
    print(f"card {scene} ready {label}", flush=True)


def open_sheet(page: Page, base: str, scene: str, bubble: bool, label: str = "") -> None:
    suffix = "bubble=1" if bubble else "bubble=0"
    page.goto(f"{base}/components?sample=card-question&surface=pas&scene={scene}&{suffix}")
    settle(page)
    page.wait_for_selector(f'{SHEET_SCOPE} .v3-card-question-body', state="visible")
    print(f"sheet {scene} bubble={bubble} ready {label}", flush=True)


def shot(page: Page, out: Path, name: str, selector: str) -> str:
    # 카드 상세는 스크롤을 따라가는 효과가 있어 요소 상자 좌표가 계속 움직인다.
    # 요소 스크린샷의 안정화 대기 대신 문서 좌표로 잘라 찍는다.
    path = out / f"{name}.png"
    page.evaluate("() => document.fonts.ready")
    locator = page.locator(selector).first
    locator.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    box = locator.evaluate(
        "(element) => { const rect = element.getBoundingClientRect();"
        " return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }; }"
    )
    page.screenshot(path=str(path), clip=box)
    print(f"{name}: {path.as_posix()}", flush=True)
    return path.as_posix()


def drag_select(page: Page, selector: str, index: int = 0) -> str:
    """요소 위를 왼쪽에서 오른쪽으로 끌어 고른 글자를 돌려준다."""
    box = page.evaluate(DRAG_BOX_SCRIPT, {"selector": selector, "index": index})
    if box is None:
        return ""
    page.mouse.move(box["x0"], box["y"])
    page.mouse.down()
    page.mouse.move((box["x0"] + box["x1"]) / 2, box["y"], steps=4)
    page.mouse.move(box["x1"], box["y"], steps=4)
    page.mouse.up()
    page.wait_for_timeout(150)
    return page.evaluate("() => String(getSelection() ?? '')")


def board_state(page: Page) -> dict:
    return page.evaluate(BOARD_SCRIPT)


def choice_hover_state(page: Page, root_selector: str, button_selector: str) -> dict:
    """고른 뒤 흐린 행과 고른 행 위에 마우스를 올려 cursor와 테두리를 잰다."""
    page.mouse.move(5, 5)
    page.wait_for_timeout(150)
    rest = page.evaluate(CHOICE_STYLE_SCRIPT, root_selector) or []
    selected_index = next((index for index, item in enumerate(rest) if item["selected"]), None)
    dim_index = next((index for index, item in enumerate(rest) if not item["selected"]), None)
    data = {"rest": rest, "selectedIndex": selected_index, "dimIndex": dim_index, "dimHover": None, "selectedHover": None}
    buttons = page.locator(button_selector)
    if dim_index is not None:
        buttons.nth(dim_index).hover()
        page.wait_for_timeout(150)
        data["dimHover"] = next((item for item in (page.evaluate(CHOICE_STYLE_SCRIPT, root_selector) or []) if not item["selected"]), None)
    if selected_index is not None:
        buttons.nth(selected_index).hover()
        page.wait_for_timeout(150)
        data["selectedHover"] = next((item for item in (page.evaluate(CHOICE_STYLE_SCRIPT, root_selector) or []) if item["selected"]), None)
    page.mouse.move(5, 5)
    page.wait_for_timeout(100)
    return data


def order_ok(items: list[dict]) -> bool:
    for current, following in zip(items, items[1:]):
        if following["top"] < current["top"] - 4:
            return False
        if abs(following["top"] - current["top"]) <= 4 and following["left"] < current["left"] - 4:
            return False
    return True


def sheet_order_ok(items: list[dict]) -> bool:
    ranks = [item["section"] for item in items]
    return all(following >= current for current, following in zip(ranks, ranks[1:]))


def judge_card(scene: str, data: dict, width: int) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "scene": scene, "width": width, "detail": detail})

    if data["pageOverflowX"] > 1:
        fail("noPageHorizontalOverflow", data["pageOverflowX"])
    if data["bodyOverflowX"] is None or data["bodyOverflowX"] > 1:
        fail("questionBodyNoOverflow", data["bodyOverflowX"])
    if data["choicesOverflowX"] is not None and data["choicesOverflowX"] > 1:
        fail("choicesNoOverflow", data["choicesOverflowX"])

    selection = data["selection"]
    if selection["background"] != "text":
        fail("backgroundTextSelectable", selection["background"])
    if data["choices"] and selection["choice"] != "none":
        fail("choiceTextNotSelectable", selection["choice"])
    if data["actions"] and selection["action"] != "none":
        fail("actionTextNotSelectable", selection["action"])

    choices = data["choices"]
    labels = [choice["label"].split("권함")[0].strip() for choice in choices]
    if scene == "ga":
        if data["title"] != GA_TITLE:
            fail("title", data["title"])
        if len(choices) != 3:
            fail("threeChoices", labels)
        if data["recommendations"] != 1:
            fail("oneRecommendation", data["recommendations"])
        if data["images"] != 1:
            fail("imageEvidence", data["images"])
        if data["actions"] != ["되묻기"]:
            fail("composerVisibleHidesFreeAnswer", data["actions"])
        if any(choice["selected"] for choice in choices):
            fail("openQuestionHasNoSelectedChoice", labels)
        if data["placeholder"] != "다르게 답하기":
            fail("openPlaceholder", data["placeholder"])
    if scene == "na":
        if data["notice"] is None or "덧붙이기: " + NA_LABEL not in data["notice"]:
            fail("appendTargetNotice", data["notice"])
        if data["placeholder"] != "덧붙일 말":
            fail("appendPlaceholder", data["placeholder"])
        if data["draft"] != NA_DRAFT:
            fail("appendDraftKept", data["draft"])
        selected = [choice for choice in choices if choice["selected"]]
        if len(selected) != 1 or not selected[0]["label"].startswith(NA_LABEL):
            fail("onePressLeavesSelectedRow", labels)
        elif selected[0]["disabled"] or not selected[0]["ariaDisabled"]:
            fail("chosenRowUsesAriaDisabled", selected[0])
        if sum(1 for choice in choices if choice["disabled"]) != len(choices) - 1:
            fail("otherChoicesDimmed", labels)
        if data["actions"]:
            fail("answeredQuestionHasNoOpenActions", data["actions"])
    if scene == "da":
        waiting = [turn for turn in data["thread"] if turn["waiting"]]
        if len(waiting) != 1 or "답을 기다리는 중" not in waiting[0]["text"]:
            fail("waitingRow", data["thread"])
        if len(data["thread"]) != 4:
            fail("threadOrder", [turn["author"] for turn in data["thread"]])
        if not data["hasRevised"]:
            fail("revisedHeader")
        if data["actions"] != ["되묻기"]:
            fail("composerVisibleHidesFreeAnswer", data["actions"])
        if selection["thread"] != "text":
            fail("threadTextSelectable", selection["thread"])
    if scene == "ra":
        if data["title"] != REQUEST_TITLE:
            fail("requestTitle", data["title"])
        if choices:
            fail("requestHasNoChoices", labels)
        if data["actions"] != ["되묻기", "했어"]:
            fail("requestActions", data["actions"])
        if data["backgroundItems"] != 3:
            fail("requestNumberedList", data["backgroundItems"])
    if scene == "legacy":
        if data["title"] is not None:
            fail("legacyHasNoTitle", data["title"])
        if len(choices) != 3:
            fail("legacyChoices", labels)
        if data["recommendations"]:
            fail("legacyHasNoRecommendation", data["recommendations"])
        if data["images"]:
            fail("legacyHasNoEvidence", data["images"])
        if data["hasRevised"]:
            fail("legacyHasNoRevision")
    return failures


def judge_sheet(scene: str, data: dict, expanded: bool) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "scene": scene, "expanded": expanded, "detail": detail})

    if data["pageOverflowX"] > 1:
        fail("noPageHorizontalOverflow", data["pageOverflowX"])
    if data["sheetOverflowX"] is not None and data["sheetOverflowX"] > 1:
        fail("sheetNoHorizontalOverflow", data["sheetOverflowX"])
    if data["bodyOverflowX"] is not None and data["bodyOverflowX"] > 1:
        fail("questionBodyNoOverflow", data["bodyOverflowX"])

    selection = data["selection"]
    if selection["background"] != "text":
        fail("backgroundTextSelectable", selection["background"])
    if data["choices"] and selection["choice"] != "none":
        fail("choiceTextNotSelectable", selection["choice"])
    if data["actions"] and selection["action"] != "none":
        fail("actionTextNotSelectable", selection["action"])

    choices = data["choices"]
    if scene == "ga" and not expanded:
        if data["title"] != GA_TITLE:
            fail("title", data["title"])
        if data["chip"] != "카드 질문":
            fail("questionChip", data["chip"])
        if data["actions"] != ["다르게 답하기", "되묻기"]:
            fail("collapsedActions", data["actions"])
        if data["placeholder"] is not None:
            fail("collapsedHasNoComposer", data["placeholder"])
        if len(choices) != 3:
            fail("threeChoices", [choice["label"] for choice in choices])
    if scene == "da" and not expanded:
        if data["meta"] is None or not re.search(r"\d{2}:\d{2}에 고침$", data["meta"]):
            fail("revisedMeta", data["meta"])
        if not any(turn["waiting"] for turn in data["thread"]):
            fail("waitingRow", data["thread"])
        if data["actions"] != ["다르게 답하기", "되묻기"]:
            fail("collapsedActions", data["actions"])
        if selection["thread"] != "text":
            fail("threadTextSelectable", selection["thread"])
    if scene == "ra" and not expanded:
        if data["chip"] != "카드 부탁":
            fail("requestChip", data["chip"])
        if choices:
            fail("requestHasNoChoices", [choice["label"] for choice in choices])
        if data["actions"] != ["다르게 답하기", "되묻기", "했어"]:
            fail("requestActions", data["actions"])
        if data["backgroundItems"] != 3:
            fail("requestNumberedList", data["backgroundItems"])
    if scene == "legacy" and not expanded:
        if data["chip"] != "카드 질문":
            fail("legacyQuestionChip", data["chip"])
        if len(choices) != 3:
            fail("legacyChoices", [choice["label"] for choice in choices])
        if data["recommendations"]:
            fail("legacyHasNoRecommendation", data["recommendations"])
        if data["actions"] != ["다르게 답하기", "되묻기"]:
            fail("legacyActions", data["actions"])
    if scene == "na":
        answered = data["answered"]
        if not answered:
            fail("answeredRowVisible")
        else:
            if answered["paddingLeft"] <= 0 or answered["paddingRight"] <= 0:
                fail("answeredButtonKeepsInlinePadding", answered)
            if abs(answered["rightGap"]) > 1:
                fail("answeredButtonAlignsRightEdge", answered)
            if answered["answerFont"] and answered["buttonFont"] != answered["answerFont"]:
                fail("answeredButtonFontMatchesAnswer", answered)
    if expanded and scene == "ga":
        if not data["expanded"]:
            fail("sheetExpanded")
        if data["placeholder"] != "다르게 답하기":
            fail("expandedPlaceholder", data["placeholder"])
        if data["actions"] != ["되묻기"]:
            fail("expandedHidesFreeAnswer", data["actions"])
    if expanded and scene == "na":
        if not data["expanded"]:
            fail("sheetExpanded")
        if data["notice"] is None or "덧붙이기: " + NA_LABEL not in data["notice"]:
            fail("appendTargetNotice", data["notice"])
        if data["placeholder"] != "덧붙일 말":
            fail("appendPlaceholder", data["placeholder"])
        if data["draft"] != NA_DRAFT:
            fail("appendDraftKept", data["draft"])
    return failures


def capture_card(page: Page, base: str, out: Path, scene: str, width: int, theme: str) -> dict:
    open_card(page, base, scene, f"{width}-{theme}")
    data = page.evaluate(CARD_SCRIPT)
    path = shot(page, out, f"card-question-card-{scene}-{width}-{theme}", CARD_SCOPE)
    return {"capture": f"card-{scene}-{width}-{theme}", "path": path, "data": data,
            "failures": judge_card(scene, data, width)}


def capture_sheet(page: Page, base: str, out: Path, scene: str, expanded: bool, theme: str) -> dict:
    open_sheet(page, base, scene, bubble=True, label=f"1440-{theme}")
    if expanded:
        page.get_by_role("button", name="확대").click()
        page.wait_for_selector(f'{SHEET_SCOPE} .pas-report-card-preview', state="visible")
        page.wait_for_timeout(200)
    data = page.evaluate(SHEET_SCRIPT)
    suffix = "-expanded" if expanded else ""
    path = shot(page, out, f"card-question-pas-{scene}{suffix}-1440-{theme}", SCREEN_SCOPE)
    return {"capture": f"pas-{scene}{suffix}-1440-{theme}", "path": path, "data": data,
            "failures": judge_sheet(scene, data, expanded)}


def capture_narrow_sheet(page: Page, base: str, out: Path, scene: str, theme: str) -> dict:
    open_sheet(page, base, scene, bubble=False, label=f"390-{theme}")
    data = page.evaluate(SHEET_SCRIPT)
    path = shot(page, out, f"card-question-pas-{scene}-390-{theme}", SCREEN_SCOPE)
    return {"capture": f"pas-{scene}-390-{theme}", "path": path, "data": data,
            "failures": judge_sheet(scene, data, False)}


def paging_state(page: Page) -> dict:
    return page.evaluate(PAGING_SCRIPT)


def wait_paging_settled(page: Page) -> dict:
    """판 높이와 스크롤이 두 번 연속 같은 값으로 읽힐 때까지 기다린다."""
    page.wait_for_timeout(400)
    settled = paging_state(page)
    for _ in range(20):
        page.wait_for_timeout(150)
        again = paging_state(page)
        if again == settled:
            return again
        settled = again
    return settled


def capture_paging(page: Page, base: str, out: Path, bubble: bool, theme: str) -> dict:
    """긴 질문 장에서 한 줄 카드 장으로 넘기며 판 높이와 아래 줄 좌표를 잰다."""
    width = WIDE if bubble else NARROW
    open_sheet(page, base, "ga", bubble=bubble, label=f"paging-{width}-{theme}")
    before = wait_paging_settled(page)
    long_path = shot(page, out, f"card-question-pas-paging-long-{width}-{theme}", SCREEN_SCOPE)
    if bubble:
        # 이동 단추가 있는 넓은 말풍선은 제 단추로 넘긴다.
        page.get_by_role("button", name="다음 장").click()
    else:
        # 767px 이하에서는 이동 단추를 숨기므로 트랙을 실제로 스크롤한다.
        page.evaluate("() => { const track = document.querySelector('[data-testid=\"card-question-review\"] .pas-report-track');"
                      " track.scrollTo({ left: track.clientWidth, behavior: 'smooth' }); }")
    after = wait_paging_settled(page)
    short_path = shot(page, out, f"card-question-pas-paging-short-{width}-{theme}", SCREEN_SCOPE)
    return {
        "capture": f"pas-paging-{width}-{theme}",
        "surface": "bubble" if bubble else "band",
        "paths": {"long": long_path, "short": short_path},
        "before": before,
        "after": after,
        "failures": judge_paging(bubble, before, after),
    }


def judge_paging(bubble: bool, before: dict, after: dict) -> list[dict]:
    failures: list[dict] = []
    surface = "bubble" if bubble else "band"

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "surface": surface, "detail": detail})

    if before["sheet"] is None or after["sheet"] is None:
        fail("sheetVisible", {"before": before["sheet"], "after": after["sheet"]})
        return failures
    numeric = ("deckHeight", "contentHeight", "deckBottom", "navTop", "buttonRowTop")
    missing = [key for key in numeric if before[key] is None or after[key] is None]
    if missing:
        fail("pagingMeasured", {"missing": missing})
        return failures
    if before["sheet"] == after["sheet"]:
        fail("pageChanged", {"before": before["sheet"], "after": after["sheet"]})
    # 짧은 장이 보이면 판 높이와 내용 높이가 그 장을 따라 줄어야 한다.
    if after["deckHeight"] > before["deckHeight"] - 20:
        fail("shortSheetShrinksDeck", {"before": before["deckHeight"], "after": after["deckHeight"]})
    if after["contentHeight"] > before["contentHeight"] - 20:
        fail("shortSheetShorterContent", {"before": before["contentHeight"], "after": after["contentHeight"]})
    if bubble:
        # 말풍선은 아래가 붙박이라 판 바닥과 그 위의 아래 줄 좌표가 그대로여야 한다.
        if abs(after["deckBottom"] - before["deckBottom"]) > 1:
            fail("bubbleDeckBottomHeld", {"before": before["deckBottom"], "after": after["deckBottom"]})
        if abs(after["navTop"] - before["navTop"]) > 1:
            fail("bubbleNavTopHeld", {"before": before["navTop"], "after": after["navTop"]})
        if abs(after["buttonRowTop"] - before["buttonRowTop"]) > 2:
            fail("bubbleButtonRowTopHeld", {"before": before["buttonRowTop"], "after": after["buttonRowTop"]})
    else:
        # 띠에서는 판이 짧아진 만큼 아래 줄이 위로 올라온다.
        if after["navTop"] >= before["navTop"]:
            fail("bandNavTopRises", {"before": before["navTop"], "after": after["navTop"]})
        if after["buttonRowTop"] >= before["buttonRowTop"]:
            fail("bandButtonRowTopRises", {"before": before["buttonRowTop"], "after": after["buttonRowTop"]})
    return failures


def gallery_check(browser, base: str, theme: str) -> dict:
    """검수 창 전체 목록: 카드 상세 질문 표본 다섯이 한 화면에 함께 떠도 각자 제 질문을 그린다."""
    context = browser.new_context(viewport={"width": WIDE, "height": 1600}, color_scheme=theme, reduced_motion="reduce")
    install_page(context, theme)
    page = context.new_page()
    errors: list[str] = []
    page.set_default_timeout(60000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(f"{base}/components")
        settle(page)
        page.wait_for_selector("#components-question", state="visible")
        page.wait_for_timeout(2500)
        samples = page.evaluate(GALLERY_SCRIPT) or []
        print(f"gallery {len(samples)} card samples {theme}", flush=True)
        return {"samples": samples, "errors": errors}
    finally:
        context.close()


def interaction_checks(page: Page, base: str, out: Path, theme: str) -> dict:
    results: dict = {}

    # 14: 선택지를 한 번 누르면 입력창으로 초점을 옮기지 않고 덧붙이기 대상 줄이 선다.
    open_card(page, base, "ga", f"choice-focus-{theme}")
    page.get_by_role("button", name="파일로 옮기기").first.click()
    page.wait_for_timeout(200)
    results["choiceClick"] = {
        "focus": page.evaluate(FOCUS_SCRIPT),
        "notice": page.evaluate("() => document.querySelector('[data-testid=\"card-question-card-sample\"] .v3-card-target-notice')?.textContent?.trim() ?? null"),
        "placeholder": page.evaluate("() => document.querySelector('[data-testid=\"card-question-card-sample\"] textarea')?.getAttribute('placeholder') ?? null"),
    }
    # 잠긴 선택지(흐린 행·고른 행)의 cursor와 hover 테두리.
    results["choiceStyleCard"] = choice_hover_state(page, CARD_SCOPE, f"{CARD_SCOPE} .v3-card-question-choices button")

    # 14: 펼친 장에서 선택지를 실제로 누른다. 누른 행과 덧붙이기 대상이 남고 초점은 BODY로 떨어지지 않는다.
    open_sheet(page, base, "ga", bubble=True, label=f"expanded-choice-{theme}")
    page.get_by_role("button", name="확대").click()
    page.wait_for_selector(f'{SHEET_SCOPE} .pas-report-card-preview', state="visible")
    page.wait_for_timeout(200)
    page.locator(f'{SHEET_SCOPE} .v3-card-question-choices button').first.click()
    page.wait_for_timeout(400)
    answered_sheet = page.evaluate(SHEET_SCRIPT)
    results["expandedChoice"] = {
        "focus": page.evaluate(FOCUS_SCRIPT),
        "choices": answered_sheet["choices"],
        "notice": answered_sheet["notice"],
        "placeholder": answered_sheet["placeholder"],
        "answered": answered_sheet["answered"],
    }
    # 서버 순서: 답 저장 커밋이 판에서 질문 장을 먼저 빼고, 보이는 장은 답한 그 장으로 남는다.
    results["expandedChoice"]["board"] = board_state(page)
    results["choiceStyleSheet"] = choice_hover_state(page, SHEET_SCOPE, f'{SHEET_SCOPE} .v3-card-question-choices button')
    shot(page, out, f"card-question-pas-ga-expanded-answered-1440-{theme}", SCREEN_SCOPE)
    page.locator(f'{SHEET_SCOPE} .v3-card-target-notice button').first.click()
    page.wait_for_timeout(300)
    results["expandedChoiceClear"] = {
        "focus": page.evaluate(FOCUS_SCRIPT),
        "notice": page.evaluate("() => document.querySelector('[data-testid=\"card-question-review\"] .pas-report-sheet[data-current=\"true\"] .v3-card-target-notice')?.textContent?.trim() ?? null"),
    }

    # 판 둘: 접힌 장에서 답하면 판이 먼저 질문 장을 빼고, 잠정 붙들기가 답한 장을 같은 자리에 남긴다.
    open_sheet(page, base, "ga", bubble=True, label=f"board-collapsed-{theme}")
    before = board_state(page)
    page.locator(f'{SHEET_SCOPE} .v3-card-question-choices button').first.click()
    page.wait_for_timeout(600)
    results["collapsedBoard"] = {"before": before, "after": board_state(page)}

    # 14: 되묻기는 커멘트 입력창으로 초점을 옮긴다.
    open_card(page, base, "ga", f"ask-focus-{theme}")
    page.get_by_role("button", name="되묻기", exact=True).click()
    page.wait_for_timeout(200)
    results["askFocus"] = {
        "focus": page.evaluate(FOCUS_SCRIPT),
        "notice": page.evaluate("() => document.querySelector('[data-testid=\"card-question-card-sample\"] .v3-card-target-notice')?.textContent?.trim() ?? null"),
    }

    # 15: DOM 순서가 화면의 위에서 아래, 왼쪽에서 오른쪽 순서와 같다.
    items = page.evaluate(ORDER_SCRIPT, CARD_SCOPE) or []
    results["tabOrderCard"] = {"items": items, "ok": order_ok(items)}

    # 14/15: 펼친 장의 확대 단추 초점 유지와 Esc 뒤 상태.
    open_sheet(page, base, "ga", bubble=True, label=f"expand-focus-{theme}")
    page.get_by_role("button", name="확대").click()
    page.wait_for_selector(f'{SHEET_SCOPE} .pas-report-card-preview', state="visible")
    page.wait_for_timeout(200)
    results["expandFocus"] = {"focus": page.evaluate(FOCUS_SCRIPT), "expanded": page.evaluate(SHEET_SCRIPT)["expanded"]}
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    results["escape"] = {"expanded": page.evaluate(SHEET_SCRIPT)["expanded"]}
    sheet_items = page.evaluate(SHEET_ORDER_SCRIPT, SHEET_SCOPE) or []
    results["tabOrderSheet"] = {"items": sheet_items, "ok": sheet_order_ok(sheet_items)}

    # 14: 펼친 장의 되묻기는 장 안 입력창으로 초점을 옮긴다.
    page.get_by_role("button", name="되묻기", exact=True).first.click()
    page.wait_for_timeout(250)
    results["askFocusExpanded"] = {"focus": page.evaluate(FOCUS_SCRIPT)}
    return results


def selection_checks(page: Page, base: str) -> dict:
    """11: 읽는 글은 끌어서 골라지고, 누르는 단추 글자는 골라지지 않는다."""
    results: dict = {}

    open_sheet(page, base, "ga", bubble=True, label="select-background")
    results["sheetBackgroundDrag"] = drag_select(page, f'{SHEET_SCOPE} .v3-card-question-background p')
    page.mouse.click(5, 5)

    open_card(page, base, "na", label="select-answered-choice")
    box = page.locator(f'{CARD_SCOPE} .v3-card-question-choices button').nth(1).bounding_box()
    page.mouse.dblclick(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(150)
    results["answeredChoiceDoubleClick"] = page.evaluate("() => String(getSelection() ?? '')")
    page.mouse.click(5, 5)
    results["answeredChoiceDrag"] = drag_select(page, f'{CARD_SCOPE} .v3-card-question-choices button', 1)
    page.mouse.click(5, 5)

    open_card(page, base, "ga", label="select-open-choice")
    results["openChoiceDrag"] = drag_select(page, f'{CARD_SCOPE} .v3-card-question-choices button', 2)
    page.mouse.click(5, 5)

    open_card(page, base, "ra", label="select-action")
    box = page.locator(f'{CARD_SCOPE} .v3-card-question-actions button').first.bounding_box()
    page.mouse.dblclick(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(150)
    results["actionDoubleClick"] = page.evaluate("() => String(getSelection() ?? '')")
    page.mouse.click(5, 5)

    open_card(page, base, "da", label="select-thread")
    results["threadDrag"] = drag_select(page, f'{CARD_SCOPE} .v3-card-question-turn p', 1)
    page.mouse.click(5, 5)
    return results


def bottom_checks(page: Page, base: str, out: Path, theme: str) -> dict:
    """6-4: 펼친 장 스크롤 영역 바닥 여백. 기존 PAS 카드 펼친 장도 같은 부품이라 함께 잰다."""
    results: dict = {}

    page.goto(f"{base}/components?sample=pas-card")
    settle(page)
    page.wait_for_selector(f'{EXISTING_SHEET_SCOPE} .pas-report-content', state="visible")
    expand = page.locator(f'{EXISTING_SHEET_SCOPE} [aria-label="확대"]')
    if expand.count():
        expand.first.click()
        page.wait_for_selector(f'{EXISTING_SHEET_SCOPE} .pas-report-card-preview', state="visible")
        page.wait_for_timeout(300)
    results["existingSheetBottom"] = page.evaluate(BOTTOM_SCRIPT, EXISTING_SHEET_SCOPE)
    shot(page, out, f"card-question-pas-card-existing-bottom-1440-{theme}", EXISTING_SHEET_SCOPE)
    # 14: 항목 대상 줄의 「해제」도 입력창으로 초점을 돌려준다.
    page.get_by_role("button", name="고칠 점 남기기").first.click()
    page.wait_for_timeout(200)
    results["itemNotice"] = page.evaluate("() => document.querySelector('.pas-report-sheet[data-current=\"true\"] .v3-card-target-notice')?.textContent?.trim() ?? null")
    page.locator(f'{EXISTING_SHEET_SCOPE} [aria-label="커멘트 대상 해제"]').first.click()
    page.wait_for_timeout(300)
    results["itemNoticeClear"] = {
        "focus": page.evaluate(FOCUS_SCRIPT),
        "notice": page.evaluate("() => document.querySelector('.pas-report-sheet[data-current=\"true\"] .v3-card-target-notice')?.textContent?.trim() ?? null"),
    }

    open_sheet(page, base, "ga", bubble=True, label=f"bottom-{theme}")
    page.get_by_role("button", name="확대").click()
    page.wait_for_selector(f'{SHEET_SCOPE} .pas-report-card-preview', state="visible")
    page.wait_for_timeout(300)
    results["questionSheetBottom"] = page.evaluate(BOTTOM_SCRIPT, SHEET_SCOPE)
    shot(page, out, f"card-question-pas-ga-expanded-bottom-1440-{theme}", SCREEN_SCOPE)
    return results


def resize_check(page: Page, base: str) -> dict:
    """18: 카드 상세를 1440에서 연 채 390으로 줄인다. 입력 중인 글이 남아야 한다."""
    open_card(page, base, "ga", "resize")
    page.locator(f'{CARD_SCOPE} textarea').first.fill(NA_DRAFT)
    page.wait_for_timeout(100)
    page.set_viewport_size({"width": NARROW, "height": 1600})
    page.wait_for_timeout(400)
    data = page.evaluate(CARD_SCRIPT)
    result = {
        "pageOverflowX": data["pageOverflowX"],
        "bodyOverflowX": data["bodyOverflowX"],
        "title": data["title"],
        "draft": data["draft"],
        "imageViewer": page.evaluate("() => Boolean(document.querySelector('[data-testid=\"card-question-card-sample\"] .v3-card-image-viewer'))"),
    }
    # 초안은 localStorage에 영속하므로 이 시험이 남긴 글을 지우지 않으면 뒤의 390 장면에 다시 나타난다.
    page.evaluate("() => window.__SOULSTREAM_STORE__?.getState().clearDraft('composer:card-comment:card-ga')")
    page.wait_for_timeout(100)
    return result


def judge_choice_style(surface: str, data: dict | None, fail) -> None:
    """답한 뒤 잠긴 선택지는 누를 수 있는 단추처럼 보이지 않고, hover가 테두리를 바꾸지 않는다."""
    if not data:
        fail(f"{surface}ChoiceStyleMeasured", None)
        return
    rest = data["rest"]
    if data["selectedIndex"] is None:
        fail(f"{surface}ChoiceStyleSelectedRow", rest)
        return
    for item in rest:
        if not (item["disabled"] or item["ariaDisabled"]):
            fail(f"{surface}ChoiceStyleLockedRow", item)
        elif item["cursor"] != "default":
            fail(f"{surface}LockedChoiceCursorDefault", item)
    dim_index, selected_index = data["dimIndex"], data["selectedIndex"]
    if dim_index is not None and data["dimHover"] and data["dimHover"]["border"] != rest[dim_index]["border"]:
        fail(f"{surface}DimChoiceHoverKeepsBorder", {"rest": rest[dim_index], "hover": data["dimHover"]})
    if data["selectedHover"] and data["selectedHover"]["border"] != rest[selected_index]["border"]:
        fail(f"{surface}ChosenChoiceHoverKeepsBorder", {"rest": rest[selected_index], "hover": data["selectedHover"]})


def judge_board(fail, label: str, before: dict | None, after: dict) -> None:
    """답 저장 커밋이 판에서 질문 장을 먼저 빼고, 보이는 장은 답한 그 장으로 남는다."""
    if before is not None and (not before["board"] or "cq_" not in before["board"]):
        fail(f"{label}BoardHasQuestionSheet", before)
    if after["board"] is None or "cq_" in after["board"]:
        fail(f"{label}BoardDropsQuestionSheetBeforeAck", after)
    if after["sheets"] < 2:
        fail(f"{label}BoardKeepsTwoSheets", after)
    if after["current"] is None or not after["current"].startswith("report-sheet-cq_"):
        fail(f"{label}AnsweredSheetStaysCurrent", after)
    if after["answered"] != "true":
        fail(f"{label}AnsweredSheetShowsAnswer", after)


def judge_gallery(results: dict) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "detail": detail})

    samples = results["samples"]
    if len(samples) != 5:
        fail("galleryFiveCardSamples", len(samples))
    for index, sample in enumerate(samples):
        if not sample["body"]:
            fail(f"galleryCardSample{index}Body", sample)
    crashes = [error for error in results["errors"] if "reading 'version'" in error]
    if crashes:
        fail("galleryNoSampleFetchCrash", crashes)
    return failures


def judge_interactions(results: dict) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "detail": detail})

    choice = results["choiceClick"]
    if choice["notice"] is None or "덧붙이기: " + NA_LABEL not in choice["notice"]:
        fail("choiceRaisesAppendTarget", choice["notice"])
    if choice["placeholder"] != "덧붙일 말":
        fail("choiceKeepsAppendPlaceholder", choice["placeholder"])
    if choice["focus"]["tag"] == "TEXTAREA":
        fail("choiceDoesNotStealFocus", choice["focus"])
    if choice["focus"]["tag"] in (None, "BODY"):
        fail("choiceKeepsFocusOffBody", choice["focus"])

    expanded_choice = results["expandedChoice"]
    expanded_selected = [item for item in expanded_choice["choices"] if item["selected"]]
    if len(expanded_selected) != 1 or not expanded_selected[0]["label"].startswith(NA_LABEL):
        fail("expandedChoiceKeepsSelectedRow", expanded_choice["choices"])
    else:
        if expanded_selected[0]["disabled"] or not expanded_selected[0]["ariaDisabled"]:
            fail("expandedChoiceUsesAriaDisabled", expanded_selected[0])
        if sum(1 for item in expanded_choice["choices"] if item["disabled"]) != len(expanded_choice["choices"]) - 1:
            fail("expandedChoiceLocksOtherRows", expanded_choice["choices"])
    if expanded_choice["notice"] is None or "덧붙이기: " + NA_LABEL not in expanded_choice["notice"]:
        fail("expandedChoiceRaisesAppendTarget", expanded_choice["notice"])
    if expanded_choice["placeholder"] != "덧붙일 말":
        fail("expandedChoiceKeepsAppendPlaceholder", expanded_choice["placeholder"])
    if expanded_choice["focus"]["tag"] in (None, "BODY"):
        fail("expandedChoiceFocusStaysOffBody", expanded_choice["focus"])
    answered_row = expanded_choice["answered"]
    if not answered_row or answered_row["paddingLeft"] <= 0 or answered_row["paddingRight"] <= 0:
        fail("expandedAnsweredKeepsInlinePadding", answered_row)
    elif abs(answered_row["rightGap"]) > 1:
        fail("expandedAnsweredAlignsRightEdge", answered_row)
    if answered_row and answered_row["answerFont"] and answered_row["buttonFont"] != answered_row["answerFont"]:
        fail("expandedAnsweredFontMatchesAnswer", answered_row)

    cleared = results["expandedChoiceClear"]
    if cleared["notice"] is not None:
        fail("clearRemovesQuestionTarget", cleared["notice"])
    if cleared["focus"]["tag"] != "TEXTAREA" or cleared["focus"]["placeholder"] != "커멘트":
        fail("clearFocusesComposer", cleared["focus"])

    ask = results["askFocus"]
    if ask["focus"]["tag"] != "TEXTAREA" or ask["focus"]["placeholder"] != "물어볼 것":
        fail("askBackFocusesComposer", ask["focus"])
    if ask["notice"] is None or "되묻기" not in ask["notice"]:
        fail("askBackRaisesTarget", ask["notice"])

    if not results["tabOrderCard"]["ok"]:
        fail("cardTabOrderMatchesReadingOrder", results["tabOrderCard"]["items"])

    expand = results["expandFocus"]
    if not expand["expanded"]:
        fail("expandOpensSheet")
    if expand["focus"]["label"] != "축소":
        fail("expandKeepsFocusOnToggle", expand["focus"])
    if not results["tabOrderSheet"]["ok"]:
        fail("sheetTabOrderMatchesReadingOrder", results["tabOrderSheet"]["items"])

    ask_expanded = results["askFocusExpanded"]
    if ask_expanded["focus"]["tag"] != "TEXTAREA" or ask_expanded["focus"]["placeholder"] != "물어볼 것":
        fail("expandedAskBackFocusesComposer", ask_expanded["focus"])

    # 고른 뒤 흐린 행·고른 행의 cursor와 hover 테두리.
    judge_choice_style("card", results.get("choiceStyleCard"), fail)
    judge_choice_style("sheet", results.get("choiceStyleSheet"), fail)
    # 장 둘 판: 펼친 장과 접힌 장 모두 판이 먼저 질문 장을 빼고 답한 장이 남는다.
    judge_board(fail, "expanded", None, expanded_choice["board"])
    collapsed = results.get("collapsedBoard")
    if not collapsed:
        fail("collapsedBoardMeasured", None)
    else:
        judge_board(fail, "collapsed", collapsed["before"], collapsed["after"])
    return failures


def judge_resize(data: dict) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "detail": detail})

    if data["pageOverflowX"] > 1:
        fail("resizeNoPageHorizontalOverflow", data["pageOverflowX"])
    if data["bodyOverflowX"] is None or data["bodyOverflowX"] > 1:
        fail("resizeQuestionBodyNoOverflow", data["bodyOverflowX"])
    if data["title"] != GA_TITLE:
        fail("resizeKeepsTitle", data["title"])
    if data["draft"] != NA_DRAFT:
        fail("resizeKeepsDraft", data["draft"])
    if data["imageViewer"]:
        fail("resizeLeavesNoViewer")
    return failures


def judge_selection(results: dict) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "detail": detail})

    if not results["sheetBackgroundDrag"]:
        fail("backgroundDragSelectsText", results["sheetBackgroundDrag"])
    if results["answeredChoiceDoubleClick"]:
        fail("answeredChoiceDoubleClickSelectsNothing", results["answeredChoiceDoubleClick"])
    if results["answeredChoiceDrag"]:
        fail("answeredChoiceDragSelectsNothing", results["answeredChoiceDrag"])
    if results["openChoiceDrag"]:
        fail("openChoiceDragSelectsNothing", results["openChoiceDrag"])
    if results["actionDoubleClick"]:
        fail("actionDoubleClickSelectsNothing", results["actionDoubleClick"])
    if not results["threadDrag"]:
        fail("threadDragSelectsText", results["threadDrag"])
    return failures


def judge_bottom(results: dict) -> list[dict]:
    failures: list[dict] = []

    def fail(check: str, detail=None) -> None:
        failures.append({"check": check, "detail": detail})

    for name in ("existingSheetBottom", "questionSheetBottom"):
        data = results[name]
        if not data or not data.get("scroller"):
            fail(f"{name}Scroller", data)
            continue
        if data["scrollerPadBottom"] <= 0:
            fail(f"{name}BottomPadding", data)
        gap = data["composerGap"]
        if gap is None or gap <= 0 or gap < data["scrollerPadBottom"] - 1:
            fail(f"{name}ComposerGap", data)

    if not results["itemNotice"] or "대상: " not in results["itemNotice"]:
        fail("itemTargetNotice", results["itemNotice"])
    item_clear = results["itemNoticeClear"]
    if item_clear["notice"] is not None:
        fail("itemTargetClearRemovesNotice", item_clear["notice"])
    if item_clear["focus"]["tag"] != "TEXTAREA":
        fail("itemTargetClearFocusesComposer", item_clear["focus"])
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="카드 질문 장 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 measurements.json 을 둘 폴더")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    frames: list[dict] = []
    failures: list[dict] = []
    interactions: dict = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--disable-gpu", "--disable-software-rasterizer"])
        try:
            # 검수 창 전체 목록에서 카드 상세 질문 표본 다섯이 함께 떠도 각자 제 질문을 그린다.
            gallery = gallery_check(browser, base, "light")
            interactions["gallery"] = gallery
            failures.extend({"capture": "gallery", **failure} for failure in judge_gallery(gallery))

            for theme in THEMES:
                # 넓은 폭: 카드 상세(1440)와 PAS 판(1440x900).
                context = browser.new_context(
                    viewport={"width": WIDE, "height": 1600},
                    color_scheme=theme,
                    reduced_motion="reduce",
                )
                install_page(context, theme)
                page = context.new_page()
                # dev 서버 첫 화면은 모듈 변환 때문에 20초 안팎 걸린다.
                page.set_default_timeout(60000)
                page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr, flush=True))

                for scene in CARD_SCENES:
                    frame = capture_card(page, base, out, scene, WIDE, theme)
                    frames.append(frame)
                    failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])

                page.set_viewport_size({"width": WIDE, "height": 900})
                for scene in PAS_COLLAPSED:
                    frame = capture_sheet(page, base, out, scene, False, theme)
                    frames.append(frame)
                    failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])
                for scene in PAS_EXPANDED:
                    frame = capture_sheet(page, base, out, scene, True, theme)
                    frames.append(frame)
                    failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])

                # 카드 #1197: 긴 질문 장에서 한 줄 카드 장으로 넘길 때 판 높이가 지금 장을 따른다.
                frame = capture_paging(page, base, out, True, theme)
                frames.append(frame)
                failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])

                theme_interactions = interaction_checks(page, base, out, theme)
                interactions[theme] = theme_interactions
                failures.extend({"capture": f"interaction-{theme}", **failure} for failure in judge_interactions(theme_interactions))

                # 11: 읽는 글은 골라지고 단추 글자는 골라지지 않는다.
                page.set_viewport_size({"width": WIDE, "height": 1600})
                theme_interactions["selection"] = selection_checks(page, base)
                failures.extend({"capture": f"selection-{theme}", **failure} for failure in judge_selection(theme_interactions["selection"]))

                # 펼친 장 바닥 여백과 스크롤 하단 캡처, 항목 대상 줄 「해제」 초점.
                page.set_viewport_size({"width": WIDE, "height": 900})
                theme_interactions["bottom"] = bottom_checks(page, base, out, theme)
                failures.extend({"capture": f"bottom-{theme}", **failure} for failure in judge_bottom(theme_interactions["bottom"]))

                # 18: 카드 상세를 넓은 폭으로 연 채 좁은 폭으로 줄인다.
                page.set_viewport_size({"width": WIDE, "height": 1600})
                resized = resize_check(page, base)
                interactions[theme]["resize"] = resized
                failures.extend({"capture": f"resize-{theme}", **failure} for failure in judge_resize(resized))

                # 좁은 폭: 카드 상세(390)와 PAS 판 인라인(390).
                page.set_viewport_size({"width": NARROW, "height": 1800})
                for scene in CARD_SCENES:
                    frame = capture_card(page, base, out, scene, NARROW, theme)
                    frames.append(frame)
                    failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])
                page.set_viewport_size({"width": NARROW, "height": 1200})
                for scene in ("ga", "da"):
                    frame = capture_narrow_sheet(page, base, out, scene, theme)
                    frames.append(frame)
                    failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])
                # 좁은 띠에서도 같은 두 장을 트랙 스크롤로 넘긴다.
                frame = capture_paging(page, base, out, False, theme)
                frames.append(frame)
                failures.extend({"capture": frame["capture"], **failure} for failure in frame["failures"])

                context.close()
        finally:
            browser.close()

    report = {
        "baseUrl": base,
        "expected": {
            "gaTitle": GA_TITLE,
            "requestTitle": REQUEST_TITLE,
            "appendLabel": NA_LABEL,
            "appendDraft": NA_DRAFT,
        },
        "frames": frames,
        "interactions": interactions,
        "assertions": {"passed": not failures, "failures": failures},
    }
    (out / "measurements.json").write_text(
        json.dumps({"frames": frames, "interactions": interactions}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    verdict = "통과" if not failures else f"실패 {len(failures)}건"
    print(f"판정: {verdict}")
    for failure in failures:
        print(json.dumps(failure, ensure_ascii=False))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""카드 질문 장 시각 검수.

컴포넌트 검수 창(`/components`)의 카드 질문 장 표본을 카드 상세와 PAS 판 두 표면으로
넓은 폭(1440)과 좁은 폭(390), 라이트와 다크에서 찍고, 장면마다 계약이 정한 부품과
글자가 서는지 잰다. PAS 판은 1440x900 좌표의 말풍선 자리에서 접힌 장과 펼친 장을 찍는다.

장면(시안 df63ae1b1의 이름)

    ga      새 선택 질문(그림, 권함, 선택지 설명)
    na      선택 뒤 덧붙이기 대상 줄과 입력창
    da      글타래와 「답을 기다리는 중」, 「고침」
    ra      부탁 장(선택지 없음, 「했어」가 맨 오른쪽)
    legacy  옛 질문(제목 없음, 선택지 설명 없음)

조작 항목(UI 기준 14~18번)

    14 누른 뒤 초점    되묻기를 누르면 커멘트 입력창에 초점이 가고, 확대를 누르면 초점이 확대/축소 단추에 남는다.
                       선택지를 한 번 누르면 초점을 입력창으로 옮기지 않고 덧붙이기 대상 줄만 선다(계약 3).
    15 Tab과 Esc      질문 장 안의 DOM 순서(Tab 순서)가 읽는 순서(머리 → 본문 → 동작 줄)와 같고, 보이지 않는 요소는 빠진다.
                       카드 상세는 한 열이라 좌표 오름차순으로도 함께 잰다. PAS 판은 발치 줄이 붙박이라 구역 순서로 잰다.
                       펼친 장은 대화상자가 아니라 제자리 확장이라 Esc로 닫지 않는다(계약에 없음). Esc를 눌러도 상태가 바뀌지 않는지만 잰다.
    16 좁은 폭 넘침   390 폭에서 페이지, 질문 본문, 선택지에 가로 넘침이 없다.
    17 오류 상태는 해당 없음: 질문 장은 따로 받는 자료가 없고, 보내기 실패는 기존 카드 오류 줄이 맡는다.
    18 창 크기 바꾸기  카드 상세를 1440에서 연 채 390으로 줄여도 제목과 입력 중인 글이 남고 넘치지 않는다.
                       PAS 표본은 1440x900 좌표를 고정한 하네스라 리사이즈는 카드 상세에서만 잰다.

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
PAS_COLLAPSED = ("ga", "da", "ra")
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
  const choices = root.querySelector('.v3-card-question-choices');
  const overflow = (element) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
  const text = root.textContent ?? '';
  return {
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    bodyOverflowX: overflow(body),
    choicesOverflowX: overflow(choices),
    title: root.querySelector('.v3-card-question-title')?.textContent?.trim() ?? null,
    background: body?.querySelector('.v3-card-question-background')?.textContent?.trim() ?? null,
    choices: [...root.querySelectorAll('.v3-card-question-choices button')].map((button) => ({
      label: button.textContent.trim(),
      selected: button.getAttribute('data-selected') === 'true',
      disabled: button.disabled,
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
  const overflow = (element) => element ? Math.max(0, element.scrollWidth - element.clientWidth) : null;
  return {
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    sheetOverflowX: overflow(sheet),
    bodyOverflowX: overflow(body),
    title: sheet?.querySelector('.pas-report-title')?.textContent?.trim() ?? null,
    chip: sheet?.querySelector('[data-slot="status-chip"]')?.textContent?.trim() ?? null,
    meta: sheet?.querySelector('.v3-card-question-meta')?.textContent?.trim() ?? null,
    choices: [...(body?.querySelectorAll('.v3-card-question-choices button') ?? [])].map((button) => ({
      label: button.textContent.trim(),
      selected: button.getAttribute('data-selected') === 'true',
      disabled: button.disabled,
    })),
    actions: [...(sheet?.querySelectorAll('.pas-report-footer button') ?? [])].map((button) => button.textContent.trim()),
    thread: [...(body?.querySelectorAll('.v3-card-question-thread > li') ?? [])].map((item) => ({
      author: item.getAttribute('data-author'),
      waiting: item.getAttribute('data-waiting') === 'true',
      text: item.textContent.trim(),
    })),
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

CARD_SCOPE = '[data-testid="card-question-card-sample"]'
SHEET_SCOPE = '[data-testid="card-question-review"] .pas-report-sheet[data-current="true"]'

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
        if not any(choice["disabled"] for choice in choices):
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
    if scene == "ra":
        if data["title"] != REQUEST_TITLE:
            fail("requestTitle", data["title"])
        if choices:
            fail("requestHasNoChoices", labels)
        if data["actions"] != ["되묻기", "했어"]:
            fail("requestActions", data["actions"])
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
    if scene == "ra" and not expanded:
        if data["chip"] != "카드 부탁":
            fail("requestChip", data["chip"])
        if choices:
            fail("requestHasNoChoices", [choice["label"] for choice in choices])
        if data["actions"] != ["다르게 답하기", "되묻기", "했어"]:
            fail("requestActions", data["actions"])
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
    path = shot(page, out, f"card-question-pas-{scene}{suffix}-1440-{theme}", '[data-testid="card-question-review"] .persistent-session-screen')
    return {"capture": f"pas-{scene}{suffix}-1440-{theme}", "path": path, "data": data,
            "failures": judge_sheet(scene, data, expanded)}


def capture_narrow_sheet(page: Page, base: str, out: Path, scene: str, theme: str) -> dict:
    open_sheet(page, base, scene, bubble=False, label=f"390-{theme}")
    data = page.evaluate(SHEET_SCRIPT)
    path = shot(page, out, f"card-question-pas-{scene}-390-{theme}", '[data-testid="card-question-review"] .persistent-session-screen')
    return {"capture": f"pas-{scene}-390-{theme}", "path": path, "data": data,
            "failures": judge_sheet(scene, data, False)}


def interaction_checks(page: Page, base: str, theme: str) -> dict:
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


def resize_check(page: Page, base: str) -> dict:
    """18: 카드 상세를 1440에서 연 채 390으로 줄인다. 입력 중인 글이 남아야 한다."""
    open_card(page, base, "ga", "resize")
    page.locator(f'{CARD_SCOPE} textarea').first.fill(NA_DRAFT)
    page.wait_for_timeout(100)
    page.set_viewport_size({"width": NARROW, "height": 1600})
    page.wait_for_timeout(400)
    data = page.evaluate(CARD_SCRIPT)
    return {
        "pageOverflowX": data["pageOverflowX"],
        "bodyOverflowX": data["bodyOverflowX"],
        "title": data["title"],
        "draft": data["draft"],
        "imageViewer": page.evaluate("() => Boolean(document.querySelector('[data-testid=\"card-question-card-sample\"] .v3-card-image-viewer'))"),
    }


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

                theme_interactions = interaction_checks(page, base, theme)
                interactions[theme] = theme_interactions
                failures.extend({"capture": f"interaction-{theme}", **failure} for failure in judge_interactions(theme_interactions))

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

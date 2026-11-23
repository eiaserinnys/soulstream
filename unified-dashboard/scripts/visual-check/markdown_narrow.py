#!/usr/bin/env python3
"""마크다운 줄바꿈 시각 검수 — 좁은 폭의 한글 낱말 끊김과 가로 넘침 (카드 #1342).

`scripts/visual-check/markdown-narrow-fixture.html`이 세우는 표면 여덟을 360과 1440에서
찍고 잰다.

  - attachment: 첨부 보기 창 문서(한글 본문, 한글 칸과 코드 해시 칸과 맨글 해시 칸,
    링크와 긴 주소가 든 칸이 있는 표)
  - document-reader: 문서 읽기 창
  - chat: 채팅 답 메시지(긴 주소 포함)
  - user: 사용자 말풍선(긴 주소 포함)
  - stream: 스트리밍·완료 본문 네 조합(줄 시작 위치 비교)
  - siblings: 마크다운 앞뒤 형제(대체 표시, 질문 철회 본문, 세 줄 자르기)
  - notes: 카드 인계 요약과 노트
  - question: 질문 장 배경

측정은 넷이다.

  1. 가로 넘침: 문서와 표면 뿌리의 scrollWidth가 clientWidth를 넘지 않는가.
     문서 표는 자기 상자(overflow-auto) 안에서만 가로 스크롤해야 한다.
  2. 한글 낱말 끊김: 본문 텍스트 노드에서 한글 음절이 이어진 구간(낱말)을 찾아, 한 낱말이
     둘 이상의 줄 조각으로 갈라진 곳을 센다. `word-break: normal`(고치기 전)은 한글 음절
     사이에서 끊는다. 해시처럼 붙은 라틴 낱말의 글자 단위 끊김은 세지 않는다.
  3. 스트리밍 줄 위치: 같은 글을 스트리밍 중에 그린 본문과 완료 뒤에 그린 본문에서 줄이
     시작하는 글자 자리가 같은가.
  4. 스트리밍 블록 자리(카드 #1808): 같은 원문을 스트리밍(@pierre/words)과 완료
     (MarkdownContent)로 그렸을 때 맨 위 블록마다 위쪽 끝, 왼쪽 시작선, 높이의 차이가
     2px 이하인가. 미완성 지점(굵게 중간, 링크 중간, 열린 코드 펜스, 표 중간) 장면도 찍는다.
  5. ui-design 0절 14~18번: 대화상자 초점, Tab과 Esc, 좁은 폭 넘침, 오류 상태,
     창 크기 바꾸기(문서 읽기 창).

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \\
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/markdown_narrow.py \\
        http://127.0.0.1:5173 /path/to/after --mode after

    # 고치기 전(origin/main) 증거: 같은 스크립트로 같은 표본을 찍는다. before 모드는
    # 360에서 한글 낱말이 끊기는 증상이 실제로 보이는지 확인해야 0으로 끝난다.
    python3 -P unified-dashboard/scripts/visual-check/markdown_narrow.py \\
        http://127.0.0.1:5174 /path/to/before --mode before

산출물

    {출력}/markdown-narrow-{표면}-{폭}-{mode}.png      표면 캡처
    {출력}/markdown-narrow-stream-{장면}-{폭}-{mode}.png   미완성 지점 장면 캡처
    {출력}/markdown-narrow-document-reader-error-{폭}-{mode}.png   오류 상태 캡처
    {출력}/markdown-narrow-document-reader-resize-360-{mode}.png   창 크기 바꾸기 캡처
    {출력}/measurements.json                            표면별 측정
    {출력}/report.json                                 0절 14~18번 판정과 종합 결과

after 모드에서 한글 낱말이 끊기거나 가로 넘침이 있거나 스트리밍과 완료의 블록 자리가
2px를 넘게 다르거나 대화상자 초점·Esc가 어긋나면 종료 코드 1로 끝난다. before 모드에서는
360에서 낱말 끊김이 보이지 않으면 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

WIDTHS = ((360, 800), (1440, 1000))
SURFACES = (
    ("attachment", ".chat-image-viewer-popup .chat-attachment-markdown"),
    ("document-reader", '[data-testid="internal-document-dialog"] .v3-folder-board-document-copy'),
    ("chat", '[data-slot="chat-body"]'),
    ("user", '[data-sel="root"] [data-slot="chat-body"]'),
    ("stream", '[data-slot="chat-root"]'),
    ("siblings", '[data-sel="root"]'),
    ("notes", ".v3-card-notes"),
    ("question", ".v3-card-question-background"),
)
STREAM_PAIRS = (("streaming", "completed"), ("streaming-m", "completed-m"))
STREAM_INCOMPLETE_SCENES = ("incomplete-bold", "incomplete-link", "incomplete-fence", "incomplete-table")
DIALOG_SURFACES = {"attachment", "document-reader"}
EVIDENCE_TOLERANCE_PX = 1
BLOCK_TOLERANCE_PX = 2

MEASURE_SCRIPT = """
(selector) => {
  const root = document.querySelector(selector);
  if (!root) return { found: false };
  // 한글 낱말은 한글 음절이 이어진 구간이다(조사는 앞말에 붙어 쓰므로 조사도 같은 구간).
  // 해시처럼 붙어 있는 긴 라틴 낱말은 글자 단위로 끊겨도 한글 낱말 끊김이 아니므로 재지 않는다.
  const run = /[\\uAC00-\\uD7A3]{2,}/g;
  const brokenKorean = [];
  let koreanWordCount = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('pre, code')) continue;
    const text = node.nodeValue ?? '';
    let match;
    run.lastIndex = 0;
    while ((match = run.exec(text))) {
      koreanWordCount += 1;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length > 1) brokenKorean.push({ token: match[0], lines: rects.length });
    }
  }
  const table = root.querySelector('table');
  const tableBox = table?.parentElement ?? null;
  return {
    found: true,
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: root.scrollWidth,
    rootClientWidth: root.clientWidth,
    koreanWordCount,
    brokenKorean,
    table: tableBox ? { scrollWidth: tableBox.scrollWidth, clientWidth: tableBox.clientWidth } : null,
  };
}
"""

LINES_SCRIPT = """
(selector) => {
  // 본문 글자마다 줄 위치를 재서 줄이 시작하는 글자 자리를 돌려준다.
  // 강조 표시(코드 하이라이트)는 글자를 여러 텍스트 노드로 나누므로, 노드 경계를 넘어
  // 같은 줄의 앞 여섯 글자를 이어 붙여 견준다. 공백과 줄바꿈은 세지 않는다.
  const body = document.querySelector(selector);
  if (!body) return null;
  const nodes = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const chars = [];
  for (const textNode of nodes) {
    const text = textNode.nodeValue ?? '';
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === ' ' || character === '\\n' || character === '\\t') continue;
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = [...range.getClientRects()].find((item) => item.width > 0);
      if (rect) chars.push({ character, top: Math.round(rect.top) });
    }
  }
  const starts = [];
  let lastTop = null;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    if (lastTop !== null && Math.abs(current.top - lastTop) <= 4) continue;
    let prefix = '';
    for (let next = index; next < chars.length && prefix.length < 6; next += 1) {
      if (Math.abs(chars[next].top - current.top) > 4) break;
      prefix += chars[next].character;
    }
    starts.push(prefix);
    lastTop = current.top;
  }
  return starts;
}
"""

BLOCKS_SCRIPT = """
(selector) => {
  // 맨 위 블록(스트리밍이면 words 뿌리의 자식, 완료면 본문의 자식)의 자리를 본문 기준으로 잰다.
  const body = document.querySelector(selector);
  if (!body) return null;
  const root = body.querySelector('[data-markdown="root"]') ?? body;
  const bodyRect = body.getBoundingClientRect();
  return [...root.children].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      top: Math.round((rect.top - bodyRect.top) * 100) / 100,
      left: Math.round((rect.left - bodyRect.left) * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  });
}
"""

FOCUS_SCRIPT = """
() => {
  const active = document.activeElement;
  if (!(active instanceof Element)) return { tag: null, text: null, inside: false, visible: false };
  const box = active.getBoundingClientRect();
  return {
    tag: active.tagName.toLowerCase(),
    text: (active.textContent ?? '').trim().slice(0, 40),
    label: active.getAttribute('aria-label'),
    inside: Boolean(active.closest('[role="dialog"]')),
    // Base UI 초점 고리는 대화상자 밖에 두는 초점 보초(span)를 한 번 거친다. 보초는
    // 화면의 조작 요소가 아니므로 Tab 판정에서 대화상자 안과 같이 본다.
    guard: active.hasAttribute('data-base-ui-focus-guard'),
    visible: box.width > 0 && box.height > 0,
  };
}
"""


def open_surface(
    page: Page,
    base: str,
    surface: str,
    width: int,
    height: int,
    state: str = "auto",
    wait_selector: str | None = None,
) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(
        f"{base}/scripts/visual-check/markdown-narrow-fixture.html"
        f"?surface={surface}&state={state}&theme=dark",
        wait_until="load",
    )
    selector = wait_selector or dict(SURFACES)[surface]
    page.wait_for_selector(selector, state="visible", timeout=15_000)
    if surface == "stream":
        # 스트리밍 본문이 words 모듈을 받아 마크다운으로 바뀔 때까지 기다린다.
        # 고치기 전 코드(평문 스트리밍)에서는 이 요소가 없으므로 기다리지 않고 잰다.
        try:
            page.wait_for_selector(
                '[data-sel="streaming"] [data-markdown="root"]', state="visible", timeout=8_000,
            )
        except PlaywrightTimeoutError:
            pass
    if surface in DIALOG_SURFACES:
        popup = page.locator('[data-slot="dialog-popup"]').first
        popup.wait_for(state="visible")
        page.wait_for_function(
            "() => !document.querySelector('[data-slot=\\\"dialog-popup\\\"]')?.hasAttribute('data-starting-style')",
            timeout=10_000,
        )
    page.evaluate("() => document.fonts.ready")


def capture(page: Page, output: Path, name: str) -> None:
    page.screenshot(path=str(output / f"{name}.png"), animations="disabled", timeout=15_000)


def measure_surface(page: Page, selector: str) -> dict:
    return page.evaluate(MEASURE_SCRIPT, selector)


def dialog_checks(page: Page, surface: str, width: int, height: int, base: str) -> dict:
    """0절 14·15번: 연 뒤 초점, Tab, Esc, 닫은 뒤 초점 복귀."""
    open_surface(page, base, surface, width, height, state="auto")
    opened_focus = page.evaluate(FOCUS_SCRIPT)
    tab_focus = []
    for _ in range(3):
        page.keyboard.press("Tab")
        tab_focus.append(page.evaluate(FOCUS_SCRIPT))
    page.keyboard.press("Escape")
    page.wait_for_selector('[data-slot="dialog-popup"]', state="detached", timeout=10_000)
    page.wait_for_timeout(120)
    restored_focus = page.evaluate(FOCUS_SCRIPT)
    return {
        "openedFocus": opened_focus,
        "tabFocus": tab_focus,
        "restoredFocus": restored_focus,
    }


def run(args: argparse.Namespace) -> int:
    base = args.base.rstrip("/")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    mode = args.mode

    measurements: dict[str, dict] = {}
    problems: list[str] = []
    before_defect_seen = False

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(device_scale_factor=1)
        page = context.new_page()

        for surface, selector in SURFACES:
            for width, height in WIDTHS:
                open_surface(page, base, surface, width, height)
                data = measure_surface(page, selector)
                if surface == "stream":
                    data["lines"] = {
                        variant: page.evaluate(
                            LINES_SCRIPT, f'[data-sel="{variant}"] [data-slot="chat-body"]',
                        )
                        for pair in STREAM_PAIRS
                        for variant in pair
                    }
                    data["blocks"] = {
                        variant: page.evaluate(
                            BLOCKS_SCRIPT, f'[data-sel="{variant}"] [data-slot="chat-body"]',
                        )
                        for pair in STREAM_PAIRS
                        for variant in pair
                    }
                    data["wordsRoot"] = page.evaluate(
                        "() => Boolean(document.querySelector('[data-sel=\\\"streaming\\\"] [data-markdown=\\\"root\\\"]'))"
                    )
                    for scene in STREAM_INCOMPLETE_SCENES:
                        row = page.locator(f'[data-sel="{scene}"]')
                        if row.count() > 0:
                            row.first.screenshot(
                                path=str(output / f"markdown-narrow-stream-{scene}-{width}-{mode}.png"),
                                animations="disabled",
                                timeout=15_000,
                            )
                data.update({"surface": surface, "width": width, "height": height})
                measurements[f"{surface}-{width}"] = data
                capture(page, output, f"markdown-narrow-{surface}-{width}-{mode}")
                if not data.get("found"):
                    problems.append(f"{surface}/{width}: 표면을 찾지 못했습니다")
                    continue
                if width == 360 and data["brokenKorean"]:
                    before_defect_seen = True
                if mode == "after":
                    if data["pageScrollWidth"] > data["pageClientWidth"] + EVIDENCE_TOLERANCE_PX:
                        problems.append(f"{surface}/{width}: 문서 가로 넘침")
                    if data["rootScrollWidth"] > data["rootClientWidth"] + EVIDENCE_TOLERANCE_PX:
                        problems.append(f"{surface}/{width}: 표면 가로 넘침")
                    if data["brokenKorean"]:
                        tokens = ", ".join(item["token"] for item in data["brokenKorean"][:5])
                        problems.append(f"{surface}/{width}: 한글 낱말이 끊겼습니다 ({tokens})")
                    if surface == "stream":
                        if not data.get("wordsRoot"):
                            problems.append(
                                f"stream/{width}: 스트리밍 본문이 words 마크다운으로 바뀌지 않았습니다"
                            )
                        for streaming, completed in STREAM_PAIRS:
                            streaming_lines = data["lines"].get(streaming)
                            completed_lines = data["lines"].get(completed)
                            if streaming_lines and completed_lines and streaming_lines != completed_lines:
                                problems.append(
                                    f"stream/{width}: 스트리밍과 완료의 줄 시작이 다릅니다 "
                                    f"({streaming} vs {completed})"
                                )
                            streaming_blocks = data["blocks"].get(streaming) or []
                            completed_blocks = data["blocks"].get(completed) or []
                            if not streaming_blocks:
                                problems.append(
                                    f"stream/{width}: {streaming} 본문에서 맨 위 블록을 찾지 못했습니다"
                                )
                            elif len(streaming_blocks) != len(completed_blocks):
                                problems.append(
                                    f"stream/{width}: {streaming}와 {completed}의 맨 위 블록 수가 "
                                    f"다릅니다 ({len(streaming_blocks)} vs {len(completed_blocks)})"
                                )
                            else:
                                for index, (one, two) in enumerate(
                                    zip(streaming_blocks, completed_blocks, strict=True), start=1,
                                ):
                                    for field, label in (("top", "위쪽 끝"), ("left", "왼쪽 시작선"), ("height", "높이")):
                                        difference = abs(one[field] - two[field])
                                        if difference > BLOCK_TOLERANCE_PX:
                                            problems.append(
                                                f"stream/{width}: {streaming} {index}번째 블록({one['tag']})의 "
                                                f"{label} 차이 {difference:.2f}px (스트리밍 {one[field]}, 완료 {two[field]})"
                                            )
                if surface == "attachment" and data.get("table"):
                    if width == 360 and data["table"]["scrollWidth"] <= data["table"]["clientWidth"]:
                        problems.append("attachment/360: 표가 자기 상자 안에서 가로 스크롤하지 않습니다")

        # 0절 14·15번 — 대화상자 초점과 Tab·Esc (두 표면, 좁은 폭).
        dialog_results = {}
        for surface in sorted(DIALOG_SURFACES):
            result = dialog_checks(page, surface, 360, 800, base)
            dialog_results[surface] = result
            if not result["openedFocus"]["inside"]:
                problems.append(f"{surface}: 연 뒤 초점이 대화상자 안에 없습니다")
            if not all(item["visible"] and (item["inside"] or item["guard"]) for item in result["tabFocus"]):
                problems.append(f"{surface}: Tab 초점이 대화상자 밖이나 보이지 않는 곳으로 갔습니다")
            if result["restoredFocus"]["tag"] != "button":
                problems.append(f"{surface}: 닫은 뒤 초점이 연 단추로 돌아가지 않았습니다")
        measurements["dialogs"] = dialog_results

        # 0절 17번 — 문서 읽기 창의 실패 상태가 같은 자리에서 안내로 바뀐다.
        open_surface(
            page,
            base,
            "document-reader",
            360,
            800,
            state="error",
            wait_selector='[data-testid="internal-document-dialog"] [data-slot="dialog-panel"]',
        )
        error_text = page.locator('[data-testid="internal-document-dialog"]').inner_text()
        error_ok = "문서를 찾을 수 없습니다" in error_text
        capture(page, output, f"markdown-narrow-document-reader-error-360-{mode}")
        if not error_ok:
            problems.append("document-reader: 실패 상태가 같은 자리 안내로 바뀌지 않았습니다")
        measurements["documentReaderError"] = {"text": error_text, "ok": error_ok}

        # 0절 18번 — 문서 읽기 창을 연 채 1440에서 360으로 줄여도 다시 선다.
        open_surface(page, base, "document-reader", 1440, 1000)
        page.set_viewport_size({"width": 360, "height": 800})
        page.wait_for_timeout(250)
        resized = page.evaluate(MEASURE_SCRIPT, dict(SURFACES)["document-reader"])
        capture(page, output, f"markdown-narrow-document-reader-resize-360-{mode}")
        resize_ok = (
            resized.get("found", False)
            and resized["pageScrollWidth"] <= resized["pageClientWidth"] + EVIDENCE_TOLERANCE_PX
            and resized["rootScrollWidth"] <= resized["rootClientWidth"] + EVIDENCE_TOLERANCE_PX
        )
        if not resize_ok:
            problems.append("document-reader: 창을 줄인 뒤 가로 넘침이 생겼습니다")
        measurements["documentReaderResize"] = resized

        browser.close()

    report = {
        "mode": mode,
        "base": base,
        "surfaces": [surface for surface, _ in SURFACES],
        "widths": [width for width, _ in WIDTHS],
        "measurements": measurements,
        "uiDesignItems": {
            "14-focus-after-press": "pass" if not any("초점" in item for item in problems) else "fail",
            "15-tab-and-escape": "pass" if not any("Tab" in item or "Esc" in item for item in problems) else "fail",
            "16-narrow-overflow": "pass" if not any("가로 넘침" in item or "가로 스크롤" in item for item in problems) else "fail",
            "17-error-state": "pass" if error_ok else "fail",
            "18-window-resize": "pass" if resize_ok else "fail",
        },
        "problems": problems,
    }
    (output / "measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if mode == "before":
        if not before_defect_seen:
            print("before: 360에서 한글 낱말 끊김 증상을 재현하지 못했습니다", file=sys.stderr)
            return 1
        print("before: 360에서 한글 낱말 끊김 증상을 확인했습니다")
        return 0
    if problems:
        for problem in problems:
            print(f"after: {problem}", file=sys.stderr)
        return 1
    print("after: 한글 낱말 끊김과 가로 넘침이 없고 0절 14~18번 측정을 통과했습니다")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="마크다운 줄바꿈 시각 검수 (카드 #1342)")
    parser.add_argument("base", help="개발 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output", help="캡처와 측정을 남길 폴더")
    parser.add_argument("--mode", choices=("after", "before"), default="after")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())

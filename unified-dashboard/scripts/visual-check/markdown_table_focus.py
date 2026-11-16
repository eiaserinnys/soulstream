#!/usr/bin/env python3
"""마크다운 표 스크롤 상자 초점 고리 시각 검수 (카드 #1461).

가로로 넘치는 마크다운 표의 래퍼는 Chromium에서 키보드 Tab으로 들어간다. 래퍼에
초점 규칙이 없으면 브라우저 기본 흰 둥근 외곽선이 그려진다(고치기 전). 고친 뒤에는
soul-ui 스크롤 상자와 같은 공용 초점 토큰(ring)의 고리가 그려져야 하고, 마우스로
표를 눌렀을 때는 고리가 생기지 않아야 한다.

표면은 셋이다(기존 마크다운 좁은 폭 픽스처 화면).

  - chat: 채팅 답 메시지. 기존 픽스처의 채팅 본문에는 표가 없고 픽스처는 다른 카드가
    정비 중이라 고치지 않는다. 같은 픽스처 화면(?surface=chat) 위에 실제
    AssistantMessage를 표 본문으로 다시 세워 잰다. 픽스처 파일은 건드리지 않는다.
  - attachment: 첨부 보기 창 문서
  - document-reader: 문서 읽기 창

폭은 1440과 360이다. 대화상자는 넓은 폭에서 표가 넘치지 않아 스크롤 상자가 아니고
Tab 초점도 받지 않는다(해당 없음으로 기록). 채팅 말풍선은 최대 520px이라 넓은
폭에서도 표가 넘친다.

측정은 넷이다.

  1. Tab을 눌러 표 래퍼에 초점이 들어가는지, document.activeElement가 그 래퍼인지.
  2. 계산된 outlineStyle·outlineWidth·boxShadow. 합격은 outline이 없거나 폭 0이고,
     boxShadow에 --tw-ring-color(없으면 --ring) 고리 색이 있는 것.
  3. 초점 고리가 조상 상자의 overflow에 잘리는지(래퍼와 조상의 getBoundingClientRect와
     clientWidth/clientHeight로 ring 바깥 3px을 견준다). 래퍼가 focus-visible:ring-inset을
     쓰면 고리가 상자 안쪽이라 잘리지 않는다.
  4. 초점을 빼고 마우스로 표를 눌렀을 때 boxShadow에 고리가 생기지 않는지.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \\
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/markdown_table_focus.py \\
        http://127.0.0.1:5173 .local/visual-check/card1461/after

산출물

    {출력}/markdown-table-focus-{표면}-{폭}-after.png   초점 상태 캡처
    {출력}/measurements.json                            표면·폭별 측정
    {출력}/report.json                                  0절 14~18번 판정과 종합 결과

한 화면이라도 미달이면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

FIXTURE = "/scripts/visual-check/markdown-narrow-fixture.html"
WIDTHS = ((360, 800), (1440, 1000))
SURFACES = ("chat", "attachment", "document-reader")
DIALOG_SURFACES = {"attachment", "document-reader"}
# 초점 고리는 ring-offset 1px + ring 2px = 래퍼 바깥 3px까지 그려진다.
FOCUS_RING_PX = 3
EVIDENCE_TOLERANCE_PX = 1
TAB_LIMIT = 30

# 기존 픽스처의 문서 본문 표와 같은 모양(한글 칸 + 긴 해시 칸)으로 채팅 표를 세운다.
CHAT_TABLE_MARKDOWN = "\n".join([
    "표가 든 답 메시지입니다. 좁은 폭에서도 한글 낱말은 낱말 단위로 접힙니다.",
    "",
    "| 항목 | 상태 | 해시 |",
    "| --- | --- | --- |",
    "| 줄바꿈을 확인합니다 | 확인합니다 | `8c05d01e24f96b70a612750a4f45795bacdab636` |",
    "| 표 넘침을 확인합니다 | 확인합니다 | 8c05d01e24f96b70a612750a4f45795bacdab636 |",
])

RENDER_CHAT_SCRIPT = """
async (payload) => {
  const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
  const reactUrl = resources.find((url) => /\\/node_modules\\/\\.vite\\/deps\\/react\\.js\\?v=/.test(url));
  const domUrl = resources.find((url) => /\\/node_modules\\/\\.vite\\/deps\\/react-dom_client\\.js\\?v=/.test(url));
  if (!reactUrl || !domUrl) {
    return { error: 'Vite가 최적화한 react 모듈 주소를 찾지 못했습니다. 픽스처를 ?surface=chat으로 먼저 열어야 합니다.' };
  }
  const reactModule = await import(reactUrl);
  const React = reactModule.default ?? reactModule;
  const domModule = await import(domUrl);
  const createRoot = domModule.createRoot ?? domModule.default?.createRoot;
  const { AssistantMessage } = await import(payload.assistantUrl);
  const previous = document.getElementById('root');
  if (previous) previous.remove();
  const host = document.createElement('div');
  host.className = 'w-full max-w-[520px] bg-background p-3';
  host.setAttribute('data-probe-chat', 'true');
  document.body.appendChild(host);
  createRoot(host).render(React.createElement(AssistantMessage, { msg: payload.msg }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const table = host.querySelector('[data-markdown-block] > table');
  return { rendered: Boolean(table) };
}
"""

WRAPPER_INFO_SCRIPT = """
() => {
  const wrap = [...document.querySelectorAll('[data-markdown-block]')]
    .find((el) => el.querySelector(':scope > table'));
  if (!wrap) return { found: false };
  return {
    found: true,
    className: wrap.className,
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
    overflowing: wrap.scrollWidth > wrap.clientWidth,
  };
}
"""

FOCUS_INFO_SCRIPT = """
() => {
  const wrap = [...document.querySelectorAll('[data-markdown-block]')]
    .find((el) => el.querySelector(':scope > table'));
  if (!wrap) return { found: false };
  const active = document.activeElement;
  const style = getComputedStyle(wrap);
  const rect = wrap.getBoundingClientRect();
  const inset = (style.boxShadow || '').includes('inset');
  // 래퍼 바깥으로 그려질 ring 영역을 조상의 overflow 클립 상자와 견준다.
  const ring = {
    left: rect.left - (inset ? 0 : 3),
    right: rect.right + (inset ? 0 : 3),
    top: rect.top - (inset ? 0 : 3),
    bottom: rect.bottom + (inset ? 0 : 3),
  };
  const clippedBy = [];
  for (let node = wrap.parentElement; node && node !== document.body; node = node.parentElement) {
    const nodeStyle = getComputedStyle(node);
    if (nodeStyle.overflowX === 'visible' && nodeStyle.overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    const left = box.left + node.clientLeft;
    const top = box.top + node.clientTop;
    const clip = { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight };
    const overflow = {
      left: clip.left - ring.left,
      top: clip.top - ring.top,
      right: ring.right - clip.right,
      bottom: ring.bottom - clip.bottom,
    };
    if (overflow.left > 0.5 || overflow.top > 0.5 || overflow.right > 0.5 || overflow.bottom > 0.5) {
      clippedBy.push({
        tag: node.tagName.toLowerCase(),
        slot: node.getAttribute('data-slot'),
        overflow,
        clip,
      });
    }
  }
  const viewportClipped = ring.left < 0 || ring.top < 0
    || ring.right > window.innerWidth || ring.bottom > window.innerHeight;
  const ringColor = (style.getPropertyValue('--tw-ring-color') || '').trim()
    || getComputedStyle(document.documentElement).getPropertyValue('--ring').trim();
  // --tw-ring-color는 'oklch(55.6% 0 0)'처럼 계산되고 boxShadow는 'oklch(0.556 0 0)'이나
  // 'rgb(200, 205, 215)'로 계산된다. 색을 브라우저가 직렬화한 꼴로 맞춰 견준다.
  const resolveColor = (value) => {
    if (!value) return '';
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };
  const resolvedRingColor = resolveColor(ringColor);
  const boxShadow = style.boxShadow;
  const ringPresent = boxShadow !== 'none' && resolvedRingColor !== ''
    && (boxShadow.includes(resolvedRingColor) || boxShadow.includes(ringColor));
  return {
    found: true,
    focusedIsWrapper: active === wrap,
    activeTag: active instanceof Element ? active.tagName.toLowerCase() : null,
    activeSlot: active instanceof Element ? active.getAttribute('data-slot') : null,
    activeIsBody: active === document.body,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    boxShadow,
    inset,
    ringColor,
    resolvedRingColor,
    ringPresent,
    rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    clippedBy,
    viewportClipped,
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
  };
}
"""

MOUSE_INFO_SCRIPT = """
() => {
  const wrap = [...document.querySelectorAll('[data-markdown-block]')]
    .find((el) => el.querySelector(':scope > table'));
  if (!wrap) return { found: false };
  const active = document.activeElement;
  const boxShadow = getComputedStyle(wrap).boxShadow;
  return {
    found: true,
    focusedIsWrapper: active === wrap,
    activeTag: active instanceof Element ? active.tagName.toLowerCase() : null,
    activeIsBody: active === document.body,
    // 대화상자 안에서 초점받을 수 없는 내용을 누르면 Base UI가 팝업으로 초점을 되돌린다.
    inDialog: active instanceof Element ? Boolean(active.closest('[role="dialog"]')) : false,
    boxShadow,
    ringPresent: boxShadow !== 'none' && /(?:rgb|oklch|color)\\(/.test(boxShadow),
  };
}
"""

PAGE_OVERFLOW_SCRIPT = """
() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight,
})
"""

ESCAPE_INFO_SCRIPT = """
() => {
  const active = document.activeElement;
  return {
    tag: active instanceof Element ? active.tagName.toLowerCase() : null,
    label: active instanceof Element ? active.getAttribute('aria-label') : null,
    text: active instanceof Element ? (active.textContent ?? '').trim().slice(0, 30) : null,
    inDialog: active instanceof Element ? Boolean(active.closest('[role="dialog"]')) : false,
  };
}
"""


def open_surface(page: Page, base: str, surface: str, width: int, height: int, repo_root: Path) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(
        f"{base}{FIXTURE}?surface={surface}&state=auto&theme=dark",
        wait_until="load",
    )
    if surface in DIALOG_SURFACES:
        page.wait_for_selector('[data-slot="dialog-popup"]', state="visible", timeout=15_000)
        page.wait_for_function(
            "() => !document.querySelector('[data-slot=\\\"dialog-popup\\\"]')?.hasAttribute('data-starting-style')",
            timeout=10_000,
        )
    else:
        page.wait_for_selector('[data-slot="chat-body"]', state="visible", timeout=15_000)
    if surface == "chat":
        rendered = page.evaluate(RENDER_CHAT_SCRIPT, {
            "assistantUrl": f"/@fs{repo_root}/packages/soul-ui/src/components/chat/AssistantMessage.tsx",
            "msg": {
                "id": "card1461-table-focus",
                "role": "assistant",
                "treeNodeId": "card1461-table-focus",
                "treeNodeType": "assistant_message",
                "content": CHAT_TABLE_MARKDOWN,
            },
        })
        if not rendered.get("rendered"):
            raise RuntimeError(rendered.get("error") or "채팅 표본을 세우지 못했습니다")
        page.wait_for_selector('[data-probe-chat] [data-markdown-block] > table', state="visible", timeout=10_000)
    page.evaluate("() => document.fonts.ready")
    page.wait_for_timeout(150)


def wrapper_info(page: Page) -> dict:
    return page.evaluate(WRAPPER_INFO_SCRIPT)


def tab_to_wrapper(page: Page) -> tuple[int | None, dict]:
    info = page.evaluate(FOCUS_INFO_SCRIPT)
    if info.get("focusedIsWrapper"):
        return 0, info
    for index in range(TAB_LIMIT):
        page.keyboard.press("Tab")
        info = page.evaluate(FOCUS_INFO_SCRIPT)
        if info.get("focusedIsWrapper"):
            return index + 1, info
    return None, page.evaluate(FOCUS_INFO_SCRIPT)


def capture(page: Page, output: Path, name: str) -> str:
    path = output / f"{name}.png"
    page.screenshot(path=str(path), animations="disabled", timeout=15_000)
    return str(path)


def check_ring(info: dict) -> list[str]:
    problems = []
    outline_ok = info["outlineStyle"] == "none" or float(info["outlineWidth"].rstrip("px") or 0) == 0
    if not outline_ok:
        problems.append(f"브라우저 기본 outline이 남아 있습니다({info['outlineStyle']} {info['outlineWidth']})")
    if not info["ringPresent"]:
        problems.append("계산된 box-shadow에 초점 고리 색이 없습니다")
    if info["clippedBy"]:
        clipped = ", ".join(f"{item['tag']}[{item['slot']}]" for item in info["clippedBy"])
        problems.append(f"초점 고리가 조상 상자 overflow에 잘립니다({clipped})")
    if info["viewportClipped"]:
        problems.append("초점 고리가 화면(뷰포트) 밖으로 잘립니다")
    return problems


def measure_surface(page: Page, base: str, surface: str, width: int, height: int,
                    repo_root: Path, output: Path) -> tuple[dict, list[str]]:
    problems: list[str] = []
    label = f"{surface}/{width}"
    open_surface(page, base, surface, width, height, repo_root)
    wrapper = wrapper_info(page)
    record = {"surface": surface, "width": width, "height": height, "overflowing": wrapper.get("overflowing", False)}
    if not wrapper.get("found"):
        problems.append(f"{label}: 표 래퍼를 찾지 못했습니다")
        return record, problems

    tab_steps, focus = tab_to_wrapper(page)
    record["tabSteps"] = tab_steps
    record["focus"] = focus
    record["screenshot"] = capture(page, output, f"markdown-table-focus-{surface}-{width}-after")

    if not wrapper["overflowing"]:
        # 넘치지 않으면 스크롤 상자가 아니고 Tab 초점도 받지 않는다(넓은 폭의 대화상자).
        record["applicable"] = False
        if focus.get("focusedIsWrapper"):
            problems.append(f"{label}: 넘치지 않는 표 래퍼가 초점을 받았습니다")
        return record, problems

    record["applicable"] = True
    if not focus.get("focusedIsWrapper"):
        problems.append(f"{label}: Tab {TAB_LIMIT}번 안에 표 래퍼에 초점이 들어가지 않았습니다")
        return record, problems
    problems.extend(f"{label}: {problem}" for problem in check_ring(focus))

    # 마우스로 표를 눌렀을 때는 :focus-visible이 아니므로 고리가 없어야 한다.
    box = focus["rect"]
    page.mouse.click((box["left"] + box["right"]) / 2, (box["top"] + box["bottom"]) / 2)
    page.wait_for_timeout(150)
    mouse = page.evaluate(MOUSE_INFO_SCRIPT)
    record["mouse"] = mouse
    if mouse.get("found") and mouse["ringPresent"]:
        problems.append(f"{label}: 마우스로 눌렀을 때 초점 고리가 생겼습니다")
    return record, problems


def escape_check(page: Page, base: str, surface: str, repo_root: Path) -> dict:
    """0절 15번: 대화상자는 Esc로 닫히고 초점이 연 요소로 돌아간다."""
    open_surface(page, base, surface, 360, 800, repo_root)
    page.keyboard.press("Escape")
    page.wait_for_selector('[data-slot="dialog-popup"]', state="detached", timeout=10_000)
    page.wait_for_timeout(120)
    info = page.evaluate(ESCAPE_INFO_SCRIPT)
    return {"surface": surface, **info}


def resize_check(page: Page, base: str, surface: str, repo_root: Path) -> dict:
    """0절 18번: 연 채 넓은 폭에서 좁은 폭으로 줄여도 그 폭의 모양으로 다시 선다."""
    open_surface(page, base, surface, 1440, 1000, repo_root)
    page.set_viewport_size({"width": 360, "height": 800})
    page.wait_for_timeout(300)
    wrapper = wrapper_info(page)
    overflow = page.evaluate(PAGE_OVERFLOW_SCRIPT)
    return {
        "surface": surface,
        "found": wrapper.get("found", False),
        "overflowing": wrapper.get("overflowing", False),
        "pageScrollWidth": overflow["scrollWidth"],
        "pageClientWidth": overflow["clientWidth"],
    }


def run(args: argparse.Namespace) -> int:
    base = args.base.rstrip("/")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    repo_root = Path(__file__).resolve().parents[3]

    measurements: dict[str, dict] = {}
    problems: list[str] = []
    narrow_overflow_ok = True

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(device_scale_factor=1)
        page = context.new_page()

        for surface in SURFACES:
            for width, height in WIDTHS:
                record, surface_problems = measure_surface(page, base, surface, width, height, repo_root, output)
                measurements[f"{surface}-{width}"] = record
                problems.extend(surface_problems)
                if width == 360:
                    overflow = page.evaluate(PAGE_OVERFLOW_SCRIPT)
                    record["pageOverflow"] = overflow
                    if overflow["scrollWidth"] > overflow["clientWidth"] + EVIDENCE_TOLERANCE_PX:
                        narrow_overflow_ok = False
                        problems.append(f"{surface}/360: 문서에 가로 넘침이 생겼습니다")

        # 0절 15번 — 대화상자 Esc와 초점 복귀(채팅 화면은 닫을 대화상자가 없어 해당 없음).
        escape_results = {}
        for surface in sorted(DIALOG_SURFACES):
            result = escape_check(page, base, surface, repo_root)
            escape_results[surface] = result
            if result["tag"] != "button":
                problems.append(f"{surface}: Esc로 닫은 뒤 초점이 연 단추로 돌아가지 않았습니다")
        measurements["escape"] = escape_results

        # 0절 18번 — 창 크기 바꾸기.
        resize_results = {}
        for surface in SURFACES:
            result = resize_check(page, base, surface, repo_root)
            resize_results[surface] = result
            if not result["found"]:
                problems.append(f"{surface}: 창을 줄인 뒤 표 래퍼가 사라졌습니다")
            if result["pageScrollWidth"] > result["pageClientWidth"] + EVIDENCE_TOLERANCE_PX:
                problems.append(f"{surface}: 창을 줄인 뒤 문서에 가로 넘침이 생겼습니다")
        measurements["resize"] = resize_results

        browser.close()

    # 0절 14번: 마우스로 표를 눌러도 초점이 화면(대화상자) 밖으로 튀지 않는다.
    press_ok = all(
        any(mouse.get(key, False) for key in ("focusedIsWrapper", "activeIsBody", "inDialog"))
        for mouse in (
            record.get("mouse") or {}
            for record in measurements.values()
            if isinstance(record, dict) and record.get("applicable")
        )
    )

    report = {
        "base": base,
        "surfaces": list(SURFACES),
        "widths": [width for width, _ in WIDTHS],
        "measurements": measurements,
        "uiDesignItems": {
            "14-focus-after-press": {
                "result": "pass" if press_ok else "fail",
                "note": "마우스로 표를 눌러도 초점이 화면(대화상자 팝업 포함) 밖으로 튀지 않는다",
            },
            "15-tab-and-escape": {
                "result": "pass" if not any("Esc" in item or "Tab" in item for item in problems) else "fail",
                "note": "Tab이 표 래퍼에 닿고, 대화상자는 Esc로 닫힌 뒤 연 단추로 초점이 돌아온다",
            },
            "16-narrow-overflow": {
                "result": "pass" if narrow_overflow_ok else "fail",
                "note": "360px에서 표는 자기 상자 안에서만 가로 스크롤하고 문서에는 가로 넘침이 없다",
            },
            "17-error-state": {
                "result": "not-applicable",
                "note": "이번 변경은 실패 상태 화면을 만들거나 바꾸지 않는다",
            },
            "18-window-resize": {
                "result": "pass" if not any("창을 줄인" in item for item in problems) else "fail",
                "note": "연 채 1440에서 360으로 줄여도 표 래퍼가 남고 문서에 가로 넘침이 없다",
            },
        },
        "problems": problems,
    }
    (output / "measurements.json").write_text(
        json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if problems:
        for problem in problems:
            print(f"after: {problem}", file=sys.stderr)
        return 1
    print("after: 표 래퍼 초점 고리와 0절 14~18번 측정을 통과했습니다")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="마크다운 표 스크롤 상자 초점 고리 시각 검수 (카드 #1461)")
    parser.add_argument("base", help="개발 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output", help="캡처와 측정을 남길 폴더")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""설정 노드 구역 시각 검수 — 스크롤 주인과 노드별 cogito.

`/dialogues?sample=settings`의 노드 탭에서

  - 노드 목록 한가운데에 휠을 굴렸을 때 설정 상세 영역(.config-detail) 하나가 스크롤되는지
    (넓은 폭 1280, 좁은 폭 360),
  - 노드를 펼치면 사용량 패널 아래에 그 노드의 cogito 행이 서고, 목록 위 별도 cogito 카드가 없는지,
  - cogito 로딩(`cogitoState=loading`)과 실패(`cogitoState=failure`)가 같은 자리에서 바뀌는지,
  - ui-design 0절 14~18번(누른 뒤 초점, Tab 순서와 Esc, 360 폭 넘침, 오류 상태, 창 크기 바꾸기)

를 캡처와 좌표로 잰다. 컴포넌트 검수 창(`/components?sample=claude-accounts`)의 NodePanel 실물도
같은 cogito 상태로 캡처한다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/settings_nodes.py \
        http://127.0.0.1:5173 /path/to/output

    # 고치기 전(origin/main) 증거: 스크롤이 막혀 있음을 확인한다. 모드는 같은 스크립트로 잰다.
    python3 -P unified-dashboard/scripts/visual-check/settings_nodes.py \
        http://127.0.0.1:5174 /path/to/output-before --mode before

산출물

    {출력}/settings-nodes-collapsed-{1280,360}-{dark,light}.png   노드 탭 첫 화면(목록 위 cogito 카드 없음)
    {출력}/settings-nodes-expanded-{폭}-{테마}.png                 펼친 노드의 사용량 아래 cogito
    {출력}/settings-nodes-scrolled-{폭}-{테마}.png                 목록 한가운데 휠 뒤 스크롤된 화면
    {출력}/settings-nodes-cogito-loading-{폭}-{테마}.png           cogito 로딩(같은 자리)
    {출력}/settings-nodes-cogito-failure-{폭}-{테마}.png           cogito 실패(같은 자리)
    {출력}/provider-review-cogito-{normal,loading,failure}-1280-dark.png  컴포넌트 검수 창
    {출력}/measurements.json   휠 스크롤 전후 scrollTop, 초점, Tab 순서, 넘침, 리사이즈 측정
    {출력}/report.json         판정 묶음과 종합 결과

after 모드에서 휠 뒤 scrollTop이 늘지 않거나, 펼친 노드 안에 cogito 행이 없거나, 로딩·실패가 같은
자리에 서지 않거나, 360 폭에서 가로 넘침이 있으면 종료 코드 1로 끝난다. before 모드는 스크롤이
막혀 있음(delta 0)을 확인하면 0으로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

THEMES = ("dark", "light")
WIDE = 1280
NARROW = 360
SAMPLE_NODE = "sample-node"
REVIEW_NODE = "sample-provider-pool"
SCROLL_DELTA_MIN_PX = 1.0

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
  const box = list.getBoundingClientRect();
  const y = Math.min(Math.max(box.top + box.height / 2, box.top + 8), window.innerHeight - 80);
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


def expand_node(page: Page, node_id: str) -> None:
    # 같은 이름이 펼친 영역에도 있으므로 카드 머리 줄을 직접 누른다.
    card = page.get_by_test_id("node-card").filter(has_text=node_id).first
    card.locator("div").first.click()
    page.wait_for_selector("[data-provider-id]", state="visible")


def shot(page: Page, out: Path, name: str) -> str:
    page.evaluate("() => document.fonts.ready")
    path = out / f"{name}.png"
    page.screenshot(path=str(path), animations="disabled")
    print(f"{name}: {path.as_posix()}")
    return path.as_posix()


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


def run_after(browser, base: str, out: Path) -> tuple[dict, list[dict]]:
    measurements: dict = {"widths": {}, "review": {}, "states": {}}
    captures: list[str] = []

    for width in (WIDE, NARROW):
        height = 900
        for theme in THEMES:
            key = f"{width}-{theme}"
            context = browser.new_context(
                viewport={"width": width, "height": height},
                color_scheme=theme,
                reduced_motion="reduce",
            )
            install_page(context, theme)
            page = context.new_page()
            page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))

            open_settings_nodes(page, base)
            initial_focus = page.evaluate(FOCUS_SCRIPT)
            collapsed = page.evaluate(COGITO_SLOT_SCRIPT)
            captures.append(shot(page, out, f"settings-nodes-collapsed-{key}"))

            expand_node(page, SAMPLE_NODE)
            page.wait_for_selector('[data-testid="cogito-node-health"]', state="visible")
            expanded = page.evaluate(COGITO_SLOT_SCRIPT)
            captures.append(shot(page, out, f"settings-nodes-expanded-{key}"))
            expanded_overflow = page.evaluate(OVERFLOW_SCRIPT)

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

            for state in ("loading", "failure"):
                open_settings_nodes(page, base, state)
                expand_node(page, SAMPLE_NODE)
                if state == "loading":
                    page.wait_for_selector('[data-node-state="loading"]', state="visible", timeout=15_000)
                else:
                    page.wait_for_selector('[data-node-state="error"]', state="visible", timeout=15_000)
                slot = page.evaluate(COGITO_SLOT_SCRIPT)
                measurements["states"][f"{state}-{key}"] = slot
                captures.append(shot(page, out, f"settings-nodes-cogito-{state}-{key}"))

            context.close()

    # 컴포넌트 검수 창(NodePanel 실물): 정상·로딩·실패를 각각 펼친 노드에서 연다.
    context = browser.new_context(viewport={"width": WIDE, "height": 900}, color_scheme="dark", reduced_motion="reduce")
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
            context = browser.new_context(
                viewport={"width": width, "height": 900},
                color_scheme=theme,
                reduced_motion="reduce",
            )
            install_page(context, theme)
            page = context.new_page()
            open_settings_nodes(page, base)
            captures.append(shot(page, out, f"settings-nodes-collapsed-{key}"))
            expand_node(page, SAMPLE_NODE)
            captures.append(shot(page, out, f"settings-nodes-expanded-{key}"))
            measurements["widths"][key] = {"scroll": wheel_measure(page)}
            context.close()
    return measurements, captures


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

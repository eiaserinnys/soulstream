#!/usr/bin/env python3
"""모델 고르기 화면과 한도 안내 시각 검수 (카드 #1901 단위 3A).

가짜 응답(Fake를 이은 ModelFake)으로 모델 목록과 카드를 내려 아래 장면을 넓은 폭(1440)과 좁은 폭(360)으로 찍는다.
프리셋 id와 이름은 model-catalog.yaml의 실제 값이고, 한도를 다 쓴 모델(resets_at 포함)과 여러 backend를 섞었다.
바꾸기 전 빌드는 --prefix before-, 바뀐 빌드는 --prefix after-로 찍는다. 운영 사이트에는 접속하지 않는다.

  a-quota-rows         홈 실행 조합 선택기: 한도를 다 쓴 모델에 사유와 해제 시각
  b-model-unchosen     홈 실행 조합 선택기: 모델을 고르기 전 확인 단추(Claude Default)
  f-codex-order        홈 실행 조합 선택기: Codex Default를 골랐을 때 codex 모델이 앞
  d-picker-no-models   홈 실행 조합 선택기: 쓸 수 있는 모델이 없는 노드의 안내
  c-modal-unchosen     카드 실행 설정 모달: 모델을 고르기 전 「저장 후 실행」
  d-modal-no-models    카드 실행 설정 모달: 쓸 수 있는 모델이 없는 노드의 안내
  e-start-refused      카드 실행 설정 모달: 저장은 됐지만 시작이 거절된 안내

단언은 after- 빌드에서만 한다. before- 빌드는 같은 장면을 찍고, 상태 메뉴 팝업이 모달 뒤에 남는지 기록만 한다.

사용
  corepack pnpm -C unified-dashboard run build
  python3 -P scripts/visual-check/card_model_picker.py --dist unified-dashboard/dist --prefix after- --output <폴더>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from settings_toc import SERVER_CATEGORIES  # noqa: E402
from settings_toolbar_fakes import CHECKS, NODE, Fake, check, new_page, serve  # noqa: E402

WIDTHS = (1440, 360)
HOME_PREFERENCES = {"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None}
OVERFLOW = "() => document.documentElement.scrollWidth <= window.innerWidth"
RESETS_AT = "2026-11-28T03:20:00.000Z"
MONTH_RESETS_AT = "2026-12-20T00:00:00.000Z"
NO_MODELS = "쓸 수 있는 모델이 없습니다. 설정의 「코딩 에이전트 연결」에서 이 노드의 로그인을 확인하세요."
MAIN_NODE, BARE_NODE = "eiaserinnys", "eias-linegames"
CATALOG = Path(__file__).resolve().parents[2] / "packages" / "model-catalog" / "data" / "model-catalog.yaml"


def preset(source, **extra):
    return {"id": source["id"], "label": source["label"], "backend": source["backend"], "available": True, "reason": None,
            "reason_label": None, "resets_at": None, "usage_warning": False, **extra}


def exhausted(source, reason_label, resets_at):
    return preset(source, reason="quota_exhausted", reason_label=reason_label, resets_at=resets_at)


def by_backend(catalog, backend, count):
    return [item for item in catalog if item["backend"] == backend and "(" not in item["label"]][:count]


# 이름은 코드에 적지 않고 카탈로그(정본)에서 읽는다. 앞쪽 프리셋을 backend별로 골라 쓴다.
_CATALOG = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))["presets"]
CLAUDE = by_backend(_CATALOG, "claude", 4)
CODEX = by_backend(_CATALOG, "codex", 3)
ANTIGRAVITY = by_backend(_CATALOG, "antigravity", 1)
MAIN_PRESETS = [
    *(preset(item) for item in CLAUDE[:3]),
    exhausted(CODEX[0], "7일 사용량 제한", RESETS_AT),
    exhausted(CODEX[1], "7일 사용량 제한", RESETS_AT),
    preset(CODEX[2]),
    exhausted(CLAUDE[3], "월 사용량 제한", MONTH_RESETS_AT),
    preset(ANTIGRAVITY[0]),
]
BARE_PRESETS = [
    {**item, "available": False, "reason": "not_authenticated", "reason_label": "미인증", "resets_at": None}
    for item in MAIN_PRESETS
]
LABELS = [item["label"] for item in MAIN_PRESETS]
CODEX_FIRST = [item["label"] for item in MAIN_PRESETS if item["backend"] == "codex"]
CLAUDE_FIRST = [item["label"] for item in MAIN_PRESETS if item["backend"] == "claude"]
CODEX_ORDER = CODEX_FIRST + [label for label in LABELS if label not in CODEX_FIRST]
AGENTS = [
    {"id": "roselin", "name": "로젤린", "backend": "codex", "default_preset": CODEX[0]["id"]},
    {"id": "claude-default", "name": "Claude Default", "backend": "claude", "default_preset": ""},
    {"id": "codex-default", "name": "Codex Default", "backend": "codex", "default_preset": ""},
]
PRESETS_BY_NODE = {MAIN_NODE: MAIN_PRESETS, BARE_NODE: BARE_PRESETS}
REFUSAL = f"Model preset '{CODEX[0]['id']}' is unavailable on node {MAIN_NODE}: 미인증"
CARD_NOW = "2026-11-26T09:00:00Z"


def demo_card(card_id, node_id, **patch):
    return {"id": card_id, "folderId": "demo-folder", "title": "모델 고르기 화면 점검", "attachments": [], "request": "모델을 고르는 화면을 확인합니다.",
            "brief": "", "status": "todo", "blockedKind": None, "blockedDetail": None, "positionKey": "a", "queuePositionKey": None,
            "assigneeKind": "agent", "assigneeAgentId": "codex-default", "assigneeUserId": None, "assigneeSessionId": None,
            "nodeId": node_id, "modelPreset": None, "version": 5, "archived": False, "createdAt": CARD_NOW, "updatedAt": CARD_NOW, **patch}


class ModelFake(Fake):
    """모델 목록, 카드, 실행 설정 저장, 시작 거절을 더한 가짜 응답."""

    def __init__(self):
        super().__init__(atom=True, nodes="many", sessions="manual")
        self.cards = {"card-main": demo_card("card-main", MAIN_NODE), "card-bare": demo_card("card-bare", BARE_NODE)}
        self.settings_bodies: list[dict] = []
        self.execute_calls = 0

    def node_list(self):
        return [NODE, {**NODE, "nodeId": BARE_NODE, "port": 3106}]

    def handle(self, route):
        request = route.request
        path = urlsplit(request.url).path
        parts = path.split("/")
        if path.startswith("/api/nodes/") and path.endswith("/agents"):
            self.calls.append((request.method, path))
            return route.fulfill(json={"agents": AGENTS})
        if path.startswith("/api/nodes/") and path.endswith("/model-presets"):
            self.calls.append((request.method, path))
            return route.fulfill(json={"model_presets": PRESETS_BY_NODE[parts[3]]})
        if path == "/api/cards" and request.method == "GET":
            return route.fulfill(json={"cards": list(self.cards.values())})
        if len(parts) >= 4 and parts[1:3] == ["api", "cards"]:
            card = self.cards.get(parts[3])
            if card is None:
                return route.fulfill(status=404, json={"message": "카드를 찾을 수 없습니다."})
            tail = parts[4:]
            if not tail and request.method == "GET":
                return route.fulfill(json={"card": card, "sessions": [], "comments": [], "questions": [], "reports": [], "notes": [], "nowHistory": []})
            if tail == ["execution-settings"] and request.method == "POST":
                body = json.loads(request.post_data)
                self.settings_bodies.append(body)
                card.update(folderId=body["folderId"], nodeId=body["nodeId"], assigneeAgentId=body["agentId"],
                            modelPreset=body["modelPreset"], version=card["version"] + 1)
                return route.fulfill(json={"card": card})
            if tail == ["execute"] and request.method == "POST":
                self.execute_calls += 1
                return route.fulfill(status=422, json={"detail": {"error": {"code": "CARD_EXECUTION_SETTINGS_REQUIRED", "message": REFUSAL}}})
        if path == "/api/config/settings":
            return route.fulfill(json=SERVER_CATEGORIES)
        if path.startswith("/api/planner/starred-folders"):
            return route.fulfill(json={"items": [], "nextCursor": None})
        return super().handle(route)


def open_page(browser, base, fake, width, path="/"):
    context, page = new_page(browser, base, fake, width, preferences=HOME_PREFERENCES)
    page.goto(base + path, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    return context, page


def open_picker(browser, base, fake, width):
    context, page = open_page(browser, base, fake, width)
    page.get_by_role("button", name="실행 조합 선택").click()
    popup = page.locator(".v3-card-execution-picker")
    expect(popup).to_be_visible(timeout=10000)
    page.wait_for_timeout(500)
    return context, page, popup


def pick(popup, section, text):
    popup.locator(f'section[aria-label="{section}"] button', has_text=text).first.click()
    popup.page.wait_for_timeout(500)


def model_names(popup):
    return popup.locator('section[aria-label="모델"] button').evaluate_all(
        "(rows) => rows.map((row) => (row.querySelector('.v3-card-execution-name') || row).textContent.trim())")


def confirm_disabled(popup):
    return popup.get_by_role("button", name="확인", exact=True).is_disabled()


def shot(popup_or_page, out: Path, prefix: str, name: str, width: int):
    popup_or_page.screenshot(path=str(out / f"{prefix}{name}-{width}.png"), animations="disabled")


def scene_picker(browser, base, out: Path, prefix: str, width: int, current: bool):
    fake = ModelFake()
    context, page, popup = open_picker(browser, base, fake, width)
    pick(popup, "에이전트", "로젤린")
    if current:
        sol = popup.locator('section[aria-label="모델"] button', has_text=CODEX[0]["label"])
        reason = sol.locator(".v3-card-execution-reason").inner_text()
        check(f"실행 조합 {width}px: 한도를 다 쓴 모델에 사유와 해제 시각", "7일 사용량 제한 · " in reason and reason.endswith("해제") and "11/28" in reason, reason)
        check(f"실행 조합 {width}px: 한도를 다 쓴 모델도 고를 수 있음", sol.is_enabled(), None)
        month = popup.locator('section[aria-label="모델"] button', has_text=CLAUDE[3]["label"]).locator(".v3-card-execution-reason").inner_text()
        check(f"실행 조합 {width}px: 월 한도 사유", month.startswith("월 사용량 제한 · ") and "12/20" in month, month)
        check(f"실행 조합 {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    shot(popup, out, prefix, "a-quota-rows", width)

    pick(popup, "에이전트", "Claude Default")
    if current:
        check(f"실행 조합 {width}px: 모델을 고르기 전 확인이 꺼짐", confirm_disabled(popup), None)
        check(f"실행 조합 {width}px: claude 모델이 앞", model_names(popup)[:3] == CLAUDE_FIRST[:3], model_names(popup))
    shot(popup, out, prefix, "b-model-unchosen", width)

    pick(popup, "에이전트", "Codex Default")
    if current:
        names = model_names(popup)
        check(f"실행 조합 {width}px: codex 모델이 앞, 나머지는 카탈로그 순서", names == CODEX_ORDER, names)
        check(f"실행 조합 {width}px: Codex Default도 모델 전에는 확인이 꺼짐", confirm_disabled(popup), None)
    shot(popup, out, prefix, "f-codex-order", width)

    pick(popup, "노드", BARE_NODE)
    if current:
        text = popup.locator('section[aria-label="모델"]').inner_text()
        check(f"실행 조합 {width}px: 쓸 수 있는 모델이 없다는 안내", NO_MODELS in text, text)
        check(f"실행 조합 {width}px: 안내가 모델 목록 위의 <p>", popup.locator('section[aria-label="모델"] > p').count() == 1, None)
        check(f"실행 조합 {width}px: 안내가 있어도 확인이 꺼짐", confirm_disabled(popup), None)
        check(f"실행 조합 {width}px: 안내 뒤 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    shot(popup, out, prefix, "d-picker-no-models", width)
    context.close()


def open_modal(browser, base, fake, width, card_id):
    context, page = open_page(browser, base, fake, width, path=f"/?card={card_id}")
    detail = page.get_by_test_id("card-detail")
    expect(detail).to_be_visible(timeout=20000)
    return context, page, detail


def start_to_modal(page, detail):
    detail.get_by_role("button", name="시작하기", exact=True).click()
    dialog = page.locator('[data-slot="dialog-popup"]')
    expect(dialog).to_be_visible(timeout=10000)
    page.wait_for_timeout(800)
    details = dialog.locator("details")
    if details.count() and not details.first.evaluate("(element) => element.open"):
        details.first.evaluate("(element) => { element.open = true; }")
    page.wait_for_timeout(300)
    return dialog


def choose_model(page, dialog, label):
    dialog.get_by_role("combobox", name="모델").or_(dialog.locator('button[aria-label="모델"]')).first.click()
    page.locator('[data-slot="select-item"]', has_text=label).first.click()
    page.wait_for_timeout(500)


def scene_modal(browser, base, out: Path, prefix: str, width: int, current: bool):
    fake = ModelFake()
    context, page, detail = open_modal(browser, base, fake, width, "card-main")
    dialog = start_to_modal(page, detail)
    menu_left_behind = page.locator("[data-card-status-picker]").count()
    save = dialog.locator('button[aria-label="카드 설정 저장"]')
    run_label = save.inner_text()
    if current:
        check(f"설정 모달 {width}px: 모델을 고르기 전 「저장 후 실행」이 꺼짐", run_label == "저장 후 실행" and save.is_disabled(), run_label)
        check(f"설정 모달 {width}px: 모달 뒤에 상태 메뉴 팝업이 남지 않음", menu_left_behind == 0, menu_left_behind)
        check(f"설정 모달 {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    (out / f"{prefix}menu-left-behind-{width}.json").write_text(json.dumps({"statusMenuPopupsBehindModal": menu_left_behind, "saveAndRunDisabled": save.is_disabled()}), encoding="utf-8")
    shot(page, out, prefix, "c-modal-unchosen", width)

    choose_model(page, dialog, CODEX[0]["label"])
    if current:
        check(f"설정 모달 {width}px: 모델을 고르면 「저장 후 실행」이 켜짐", save.is_enabled(), None)
    save.click()
    page.wait_for_timeout(1000)
    alert = dialog.locator('[role="alert"]').first
    text = alert.inner_text()
    if current:
        check(f"설정 모달 {width}px: 저장 뒤 시작 거절 안내", f"저장했지만 시작하지 못했습니다: {REFUSAL}" in text and "카드를 저장하지 못했습니다" not in text, text)
        check(f"설정 모달 {width}px: 저장은 한 번, 시작 요청도 한 번", len(fake.settings_bodies) == 1 and fake.execute_calls == 1, [len(fake.settings_bodies), fake.execute_calls])
        check(f"설정 모달 {width}px: 거절 뒤에도 모달이 열려 있음", dialog.is_visible(), None)
        check(f"설정 모달 {width}px: 거절 안내 뒤 가로 넘침 없음", page.evaluate(OVERFLOW), width)
    shot(page, out, prefix, "e-start-refused", width)
    context.close()

    fake = ModelFake()
    context, page, detail = open_modal(browser, base, fake, width, "card-bare")
    dialog = start_to_modal(page, detail)
    if current:
        check(f"설정 모달 {width}px: 쓸 수 있는 모델이 없다는 안내", NO_MODELS in dialog.inner_text(), dialog.inner_text())
        check(f"설정 모달 {width}px: 안내가 있어도 「저장 후 실행」이 꺼짐", dialog.locator('button[aria-label="카드 설정 저장"]').is_disabled(), None)
    shot(page, out, prefix, "d-modal-no-models", width)
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="찍을 빌드 폴더(unified-dashboard/dist)")
    parser.add_argument("--prefix", required=True, choices=("before-", "after-"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    current = args.prefix == "after-"
    server, base = serve(Path(args.dist))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width in WIDTHS:
                scene_picker(browser, base, out, args.prefix, width, current)
                scene_modal(browser, base, out, args.prefix, width, current)
            browser.close()
    finally:
        server.shutdown()
    (out / f"{args.prefix}checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(CHECKS)} checks ok, captures in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

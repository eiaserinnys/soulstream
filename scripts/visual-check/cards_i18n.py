#!/usr/bin/env python3
"""Exercise the localized card workflow against fixture API responses."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from card_model_picker import MAIN_PRESETS, demo_card
from settings_i18n import LocaleFake, ROOT, capture, page_for, start_vite
from settings_toolbar_fakes import NODE

FOLDER = {"id": "demo-folder", "name": "November release", "status": "open", "parentFolderId": None, "version": 1}
DETAIL_ID = "00000000-0000-4000-8000-000000000101"
TITLE = "Verify the release dashboard and share the handoff"
AGENT = "Release coordinator"
DETAIL_CARD = demo_card(
    DETAIL_ID, NODE["nodeId"], number=101, title=TITLE, status="review",
    request="Verify the card board, check items, and the completion history.",
    brief="The release dashboard is ready for a final review.",
    now={"text": "Review the deployment evidence and choose a release window.",
         "turn": "user", "ask": "Which window should we use?", "updatedAt": "2026-11-28T03:24:00Z", "sessionId": None},
    items=[
        {"id": 1, "title": "Open the card board on a narrow screen", "state": "done", "result": "The card board loaded at 360 px.",
         "evidence": [], "caveat": None, "rev": 1, "confirmed": None, "fixOpen": 0, "reopened": None, "from": None,
         "createdAt": "2026-11-28T02:00:00Z", "reportedAt": "2026-11-28T03:12:00Z", "display": "reported"},
        {"id": 2, "title": "Confirm the release window", "state": "doing", "result": "Two windows are available.",
         "evidence": [], "caveat": None, "rev": 0, "confirmed": None, "fixOpen": 0, "reopened": None, "from": None,
         "createdAt": "2026-11-28T02:00:00Z", "reportedAt": None, "display": "doing"},
    ],
    assigneeAgentId="release-agent",
)
CARD_SET = [
    demo_card("draft-qa", NODE["nodeId"], number=102, title="Draft the support announcement", status="todo", positionKey="b"),
    demo_card("queue-qa", NODE["nodeId"], number=103, title="Publish release notes", status="queued", positionKey="c", queuePositionKey="a"),
    demo_card("run-qa", NODE["nodeId"], number=104, title="Collect customer feedback", status="running", positionKey="d"),
    DETAIL_CARD,
]
DETAIL = {
    "card": DETAIL_CARD,
    "reports": [{"id": "report-qa", "title": "Dashboard review", "format": "markdown",
                 "body": "The board now shows the latest release cards.", "createdAt": "2026-11-28T03:10:00Z", "sessionId": None}],
    "questions": [{"id": "question-qa", "title": "Release window", "kind": "decision",
                   "text": "Choose the window for the final rollout.", "options": ["Morning", "Afternoon"],
                   "askedAt": "2026-11-28T03:23:00Z", "answer": None, "answeredAt": None}],
    "comments": [{"id": "comment-qa", "cardId": DETAIL_ID, "authorKind": "user", "authorId": "QA", "sessionId": None,
                  "kind": "comment", "body": "Please keep the support team informed.", "createdAt": "2026-11-28T03:14:00Z"}],
    "notes": [{"id": "note-qa", "cardId": DETAIL_ID, "authorKind": "agent", "authorId": AGENT, "sessionId": None,
               "kind": "note", "body": "Support has the release checklist.", "createdAt": "2026-11-28T03:18:00Z"}],
    "sessions": [],
    "nowHistory": [
        {"text": "Collecting evidence.", "turn": "agent", "ask": None, "at": "2026-11-28T03:15:00Z"},
        {"text": DETAIL_CARD["now"]["text"], "turn": "user", "ask": DETAIL_CARD["now"]["ask"], "at": DETAIL_CARD["now"]["updatedAt"]},
    ],
}


class CardsFake(LocaleFake):
    def __init__(self, locale, hold_list=False):
        super().__init__()
        self.preferences["language"] = locale
        self.locale = locale
        self.hold_list = hold_list
        self.held = None
        self.list_calls = 0

    def handle(self, route):
        url = urlsplit(route.request.url)
        if url.path == "/api/folders":
            return route.fulfill(json={"folders": [FOLDER], "sessions": {}})
        if url.path == "/api/planner/today":
            return route.fulfill(json={"attention": [], "running": [], "queued": [], "reviewSessionIds": []})
        if url.path == "/api/cards":
            if parse_qs(url.query).get("status") == ["done"]:
                completed = demo_card("done-qa", NODE["nodeId"], title="Ship the October dashboard",
                                      status="done", completedAt=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
                return route.fulfill(json={"cards": [completed], "nextCursor": None})
            self.list_calls += 1
            if self.hold_list:
                self.held = route
                return
            return route.fulfill(json={"cards": CARD_SET})
        if url.path == f"/api/cards/{DETAIL_ID}":
            return route.fulfill(json=DETAIL)
        if url.path.startswith("/api/nodes/") and url.path.endswith("/agents"):
            return route.fulfill(json={"agents": [{"id": "release-agent", "name": AGENT, "backend": MAIN_PRESETS[0]["backend"], "default_preset": MAIN_PRESETS[0]["id"]}]})
        if url.path.startswith("/api/nodes/") and url.path.endswith("/model-presets"):
            return route.fulfill(json={"model_presets": [
                {**preset, "reason_label": "Included quota used" if self.locale == "en" and preset["reason_label"] else preset["reason_label"]}
                for preset in MAIN_PRESETS if preset["available"]
            ]})
        return super().handle(route)


def active(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      return el?.getAttribute('aria-label') || el?.getAttribute('placeholder') ||
        (el?.tagName === 'BODY' ? 'body' : el?.textContent?.trim().slice(0,55) || el?.tagName);
    }""")


def sizes(page):
    return page.evaluate("() => ({viewport: innerWidth, document: document.documentElement.scrollWidth})")


def language(locale):
    return json.loads((ROOT / f"packages/i18n/src/locales/{locale}/cards.json").read_text())


def select_tab(detail, name):
    tab = detail.get_by_role("tab", name=name, exact=False)
    tab.click()
    expect(tab).to_have_attribute("aria-selected", "true")


def board_and_detail(page, out, locale, width, copy):
    board = page.locator(".v3-card-board")
    expect(board.locator('[data-board-column="review"]')).to_have_attribute("aria-label", copy["status"]["review"])
    expect(board.locator("[data-board-column]")).to_have_count(4)
    capture(page, out, f"{locale}-board-{width}.png")
    board_sizes = sizes(page)
    board_focus = {}
    if width == 1440:
        expand = page.get_by_test_id("card-home").get_by_role("button", name=copy["expandBoard"])
        expand.press("Enter")
        expanded = page.locator('[data-card-board-expanded="true"]')
        expect(expanded).to_be_visible()
        expect(expanded.locator(f'[data-card-id="{DETAIL_ID}"]')).to_be_visible()
        board_focus["expand_first"] = active(page)
        capture(page, out, f"{locale}-board-expanded-1440.png")
        page.keyboard.press("Tab")
        board_focus["expand_tab"] = active(page)
        page.keyboard.press("Escape")
        expect(expanded).to_have_count(0)
        board_focus["expand_close"] = active(page)

    card = board.locator(f'[data-card-id="{DETAIL_ID}"] .v3-postit-open')
    card.click()
    detail = page.get_by_test_id("card-detail")
    expect(detail.get_by_text(TITLE, exact=True)).to_be_visible()
    expect(detail.get_by_test_id("card-now-panel").locator('[data-now-view="current"] time, time').first).to_contain_text(
        "12:24" if locale == "ko" else "12:24 PM")
    expect(detail.get_by_test_id("card-check-items").get_by_text("Confirm the release window")).to_be_visible()
    detail_sizes = sizes(page)
    first = active(page)
    capture(page, out, f"{locale}-detail-{width}.png")
    if width == 1440:
        select_tab(detail, copy["comment"])
        expect(detail.get_by_role("heading", name="Release window")).to_be_visible()
        expect(detail.get_by_text(copy["instructions"], exact=True)).to_be_visible()
        capture(page, out, f"{locale}-detail-timeline-{width}.png")
        select_tab(detail, copy["notes"])
        expect(detail.get_by_text("Support has the release checklist.")).to_be_visible()
        capture(page, out, f"{locale}-detail-notes-{width}.png")
    page.keyboard.press("Escape")
    expect(detail).to_have_count(0)
    return {"width": width, "board": board_sizes, "detail": detail_sizes, "open_focus": first, "close_focus": active(page), **board_focus}


def dialog_and_inbox(page, out, locale, copy):
    home = page.get_by_test_id("card-home")
    create = home.get_by_role("button", name=copy["newCard"], exact=True)
    create.click()
    dialog = page.get_by_role("dialog", name=copy["newCard"])
    field = dialog.get_by_role("textbox", name=copy["title"])
    expect(field).to_be_visible()
    result = {"create_first": active(page)}
    field.fill("Consolidate the release notes for the support handoff")
    capture(page, out, f"{locale}-create-1440.png")
    page.keyboard.press("Enter")
    result["create_enter"] = dialog.is_visible()
    result["before_resize"] = sizes(page)
    page.set_viewport_size({"width": 360, "height": 800})
    result["after_resize"] = sizes(page)
    result["draft_preserved"] = field.input_value() == "Consolidate the release notes for the support handoff"
    page.set_viewport_size({"width": 1440, "height": 900})
    page.keyboard.press("Tab")
    result["create_tab"] = active(page)
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    result["create_close"] = active(page)

    opener = home.get_by_role("button", name=copy["selectExecutionSettings"])
    opener.click()
    picker = page.locator(".v3-card-execution-picker")
    expect(picker).to_be_visible()
    result["picker_first"] = active(page)
    picker.get_by_role("button", name=AGENT).click()
    model_list = picker.get_by_role("region", name=copy["model"], exact=True)
    first_model = model_list.get_by_role("button", name=MAIN_PRESETS[0]["label"], exact=True)
    expect(first_model).to_be_visible()
    capture(page, out, f"{locale}-execution-1440.png")
    first_model.focus()
    page.keyboard.press("Tab")
    result["picker_tab"] = active(page)
    page.keyboard.press("Escape")
    expect(picker).not_to_be_visible()
    result["picker_escape"] = active(page)
    opener.click()
    picker.get_by_role("button", name=AGENT).click()
    confirm = picker.get_by_role("button", name=copy["confirm"], exact=True)
    expect(confirm).to_be_enabled()
    confirm.focus()
    page.keyboard.press("Enter")
    result["picker_enter_closed"] = not picker.is_visible()
    if not result["picker_enter_closed"]:
        try:
            expect(picker).not_to_be_visible(timeout=1000)
            result["picker_enter_closed"] = True
        except AssertionError:
            page.keyboard.press("Escape")
            expect(picker).not_to_be_visible()
    result["picker_enter"] = active(page)

    home.get_by_role("button", name=copy["inboxView"], exact=True).click()
    expect(home.get_by_role("heading", name=copy["needsAttention"], exact=True)).to_be_visible()
    expect(home.locator(f'[data-card-id="{DETAIL_ID}"]')).to_be_visible()
    capture(page, out, f"{locale}-inbox-1440.png")
    home.get_by_role("switch", name=copy["hideCompletedAndCancelled"]).click()
    collection = home.locator(".v3-completed-collection")
    expect(collection.get_by_text("Ship the October dashboard", exact=True)).to_be_visible()
    expect(collection.get_by_role("button", name=copy["period"]["7"])).to_be_visible()
    collection.scroll_into_view_if_needed()
    capture(page, out, f"{locale}-completed-1440.png")
    return result


def error_and_recovery(browser, base, out, copy):
    context, page, fake = page_for(browser, base, 1440, "en", CardsFake("en", hold_list=True))
    home = page.get_by_test_id("card-home")
    expect(home.get_by_label(copy["loadingCards"])).to_be_visible()
    capture(page, out, "en-loading-1440.png")
    fake.hold_list = False
    fake.held.fulfill(status=503, json={"message": "The card service is temporarily unavailable."})
    expect(home.get_by_role("alert")).to_contain_text(copy["loadCardsError"])
    capture(page, out, "en-error-1440.png")
    home.get_by_role("button", name=copy["reload"]).click()
    expect(home.locator(".v3-card-board")).to_be_visible()
    expect(home.get_by_role("alert")).to_have_count(0)
    result = f"503 → {copy['loadCardsError']} → {copy['reload']} → 카드 판. 목록 호출 {fake.list_calls}회."
    context.close()
    return result


def operations(out, wide, narrow, recovered):
    en = wide["en"]
    mobile = narrow
    text = f"""# 웹 카드 한영 전환 조작 결과

실제 대시보드 경로에서 Chromium으로 조작했다. 카드와 인증 응답은 로컬 fixture다.

| UI 설계 §0 | 실행과 결과 |
| --- | --- |
| 14. 누른 뒤 초점 | 카드 상세 열기 `{en['open_focus']}`, Esc 후 `{en['close_focus']}`. 각 팝업은 아래 표. |
| 15. Tab과 Esc | 카드 상세, 새 카드 창, 실행 선택기를 열고 Esc로 닫았다. 확대 보드 Tab 다음은 `{en['expand_tab']}`. 새 카드 창 Tab 다음은 `{en['create_tab']}`, 모델 목록 Tab 다음은 `{en['picker_tab']}`. |
| 16. 최소 폭 | 360px 문서 폭은 카드 판 {mobile['board']['document']}px, 상세 {mobile['detail']['document']}px. 보드 열은 보드 안에서 가로로 이동한다. |
| 17. 오류 상태 | {recovered} |
| 18. 창 크기 변경 | 새 카드 창을 연 채 1440px → 360px → 1440px로 변경. 좁은 폭 문서 {en['after_resize']['document']}px, 제목 입력 유지 {en['draft_preserved']}. 스크롤 위치와 열린 선택기 좌표는 미실측. 이 경로에서는 창 안 입력만 검사했다. |

| 창 또는 선택기 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |
| --- | --- | --- | --- | --- | --- |
| 보드 확대 | Expand board에서 Enter | {en['expand_first']} | 열림 | 닫힘 | {en['expand_close']} |
| 카드 상세 | 판에서 카드 누름 | {en['open_focus']} | 미실측 · 상세에 기본 제출 동작이 없다 | 닫힘 | {en['close_focus']} |
| 새 카드 | 드래프트 열의 New card 누름 | {en['create_first']} | 제목 입력에서 누른 뒤 창 열림 {en['create_enter']} | 닫힘 | {en['create_close']} |
| 실행 설정 선택기 | Choose execution settings 누름 | {en['picker_first']} | 모델 선택 후 Confirm에서 누름. 닫힘 {en['picker_enter_closed']} | 닫힘 | Esc `{en['picker_escape']}`, Enter `{en['picker_enter']}` |

새 카드 폴더 선택기, 상태·색상 메뉴, 파일 뷰어는 미실측. 표에 있는 화면을 열고 닫는 경로를 측정했다.
"""
    (out / "operations.md").write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    process, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            wide = {}
            for locale in ("ko", "en"):
                copy = language(locale)
                context, page, _ = page_for(browser, base, 1440, locale, CardsFake(locale))
                wide[locale] = board_and_detail(page, args.output, locale, 1440, copy)
                wide[locale].update(dialog_and_inbox(page, args.output, locale, copy))
                context.close()
            copy = language("en")
            context, page, _ = page_for(browser, base, 360, "en", CardsFake("en"))
            narrow = board_and_detail(page, args.output, "en", 360, copy)
            context.close()
            recovered = error_and_recovery(browser, base, args.output, copy)
            operations(args.output, wide, narrow, recovered)
    finally:
        process.terminate()
        process.wait(timeout=20)


if __name__ == "__main__":
    main()

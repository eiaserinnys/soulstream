#!/usr/bin/env python3
"""끝난 llm 세션 이어 쓰기 시각 검수 (카드 #1901 단위 6c2).

가짜 응답(settings_toolbar_fakes.Fake를 이은 LlmFake)으로 운영과 같은 꼴의 translate 세션(user_message에 system과
user messages, assistant_message 하나, completed)을 내리고 두 장면을 넓은 폭(1440)과 좁은 폭(360)으로 찍는다.
바꾸기 전 빌드는 --prefix before-, 바뀐 빌드는 --prefix after-로 찍는다. 운영 사이트에는 접속하지 않는다.

  a-composer   끝난 llm 세션의 입력창과 안내문
  b-continued  새 글을 보낸 뒤. 가짜 서버가 이어 붙은 새 질문과 답 이벤트를 흘려 준다

좁은 폭(360)은 1440 화면에서 채팅 패널을 360px까지 줄여 찍는다(가짜 데이터에 폴더가 없어 모바일 레이아웃이 채팅 탭을 열지 못한다).
장면마다 기대 문구, 옛 안내(「LLM (맥락」, 「맥락으로 보냅니다」) 없음, 가로 넘침 없음을 <prefix>checks.json에 남긴다.
단언은 after- 빌드에서만 하고, before- 빌드는 같은 항목을 기록만 한다.

사용
  corepack pnpm -C unified-dashboard run build
  python3 -P scripts/visual-check/llm_continue.py --dist unified-dashboard/dist --prefix after- --output <폴더>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from settings_toolbar_fakes import CHECKS, SESSION_ID, SUMMARY, Fake, new_page, serve  # noqa: E402

WIDTHS = (1440, 360)
HOME_PREFERENCES = {"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None}
OVERFLOW = "() => document.documentElement.scrollWidth <= window.innerWidth"
EXPECTED_PLACEHOLDER = "대화를 이어서 입력하세요"
OLD_GUIDE = ("LLM (맥락", "맥락으로 보냅니다")
FOLLOW_UP = "더 짧게 줄여 줘"
SYSTEM = "Translate the user's text into English."
SOURCE = "안녕하세요, 오늘 회의는 세 시에 시작합니다."
ANSWER = "Hello, today's meeting starts at three o'clock."
SHORT_ANSWER = "Meeting at three today."
MODEL = {"provider": "openai", "model": "sample-translate-model"}
LLM_SUMMARY = {**SUMMARY, "displayName": "번역 요청", "status": "completed", "sessionType": "llm", "llmProvider": MODEL["provider"],
               "llmModel": MODEL["model"], "clientId": "translate", "agentId": None, "agentName": None, "eventCount": 2}


def sse(event_id, event):
    return f"event: {event['type']}\nid: {event_id}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


def history(continued):
    first = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": SOURCE}]
    items = [
        (1, {"type": "user_message", "user": "translate", "text": SOURCE, "messages": first, **MODEL, "max_tokens": 512, "timestamp": 1_790_000_000}),
        (2, {"type": "assistant_message", "content": ANSWER, "usage": {"input_tokens": 31, "output_tokens": 12}, **MODEL, "timestamp": 1_790_000_001}),
    ]
    if continued:
        messages = [*first, {"role": "assistant", "content": ANSWER}, {"role": "user", "content": FOLLOW_UP}]
        items += [
            (3, {"type": "user_message", "user": "dashboard", "text": FOLLOW_UP, "messages": messages, **MODEL, "max_tokens": 512, "timestamp": 1_790_000_010}),
            (4, {"type": "assistant_message", "content": SHORT_ANSWER, "usage": {"input_tokens": 58, "output_tokens": 6}, **MODEL, "timestamp": 1_790_000_011}),
        ]
    return items


class LlmFake(Fake):
    """llm 세션 하나를 내리고, 이어 쓰기 요청을 받으면 새 이벤트를 흘린다."""

    def __init__(self):
        super().__init__(atom=True, sessions="one")
        self.continued = False
        self.llm_completions_calls = 0

    def handle(self, route):
        request = route.request
        path = urlsplit(request.url).path
        if request.method == "POST" and path == f"/api/sessions/{SESSION_ID}/intervene":
            self.calls.append((request.method, path))
            self.continued = True
            return route.fulfill(json={"type": "intervene_ack", "status": "ok", "outcome": "auto_resumed", "agentSessionId": SESSION_ID, "delivered": True})
        if path == "/api/llm/completions":
            self.calls.append((request.method, path))
            self.llm_completions_calls += 1
            return route.fulfill(status=404, json={"detail": "Not Found"})
        if path == "/api/sessions":
            self.calls.append((request.method, path))
            return route.fulfill(json={"sessions": [LLM_SUMMARY], "total": 1})
        if path == "/api/sessions/stream":
            self.calls.append((request.method, path))
            body = f"event: session_list\ndata: {json.dumps({'type': 'session_list', 'sessions': [LLM_SUMMARY], 'total': 1})}\n\n"
            return route.fulfill(content_type="text/event-stream", body=body)
        if path == f"/api/sessions/{SESSION_ID}/events":
            self.calls.append((request.method, path))
            last = int((parse_qs(urlsplit(request.url).query).get("lastEventId") or ["0"])[0])
            items = history(self.continued)
            body = "".join(sse(i, e) for i, e in items if i > last)
            sync = {"type": "history_sync", "last_event_id": items[-1][0], "is_live": True, "status": "completed"}
            return route.fulfill(content_type="text/event-stream", body=body + f"event: history_sync\ndata: {json.dumps(sync)}\n\n")
        return super().handle(route)


def composer(page):
    return page.locator('section[aria-label="세션 채팅"] [data-slot="chat-input-body"]')


def open_session(browser, base, fake, width):
    # 가짜 데이터에는 폴더가 없어 모바일 레이아웃이 채팅 탭을 열지 못한다. 좁은 폭은 1440 화면에서
    # 채팅 패널을 폭 조절 손잡이로 width px까지 줄여 같은 입력창을 찍는다.
    context, page = new_page(browser, base, fake, 1440, preferences=HOME_PREFERENCES)
    page.goto(f"{base}/?session={SESSION_ID}", wait_until="domcontentloaded")
    expect(composer(page)).to_be_visible(timeout=20000)
    expect(page.get_by_text(ANSWER)).to_be_visible(timeout=20000)
    pane = page.locator('section[aria-label="세션 채팅"]')
    if width < 1440:
        handle = page.get_by_role("separator", name="폴더와 채팅 너비 조절")
        for _ in range(40):
            if pane.bounding_box()["width"] <= width:
                break
            handle.focus()
            page.keyboard.press("ArrowRight")
            page.wait_for_timeout(80)
    page.wait_for_timeout(600)
    return context, page


def record(strict, label, condition, detail):
    CHECKS.append({"check": label, "ok": bool(condition), "detail": detail})
    if strict:
        assert condition, f"{label}: {json.dumps(detail, ensure_ascii=False)}"


def guide_checks(strict, page, scene, width, want_continued):
    editor = composer(page)
    placeholder = editor.get_attribute("placeholder") or ""
    page_text = page.locator("body").inner_html()
    record(strict, f"{scene} {width}px: 안내문이 「{EXPECTED_PLACEHOLDER}」", placeholder == EXPECTED_PLACEHOLDER, placeholder)
    record(strict, f"{scene} {width}px: 옛 안내 없음", not any(old in placeholder or old in page_text for old in OLD_GUIDE), placeholder)
    pane = page.locator('section[aria-label="세션 채팅"]')
    record(strict, f"{scene} {width}px: 채팅 패널 폭", pane.bounding_box()["width"] <= width + 1, pane.bounding_box()["width"])
    record(strict, f"{scene} {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW) and pane.evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), width)
    if want_continued:
        record(strict, f"{scene} {width}px: 같은 세션에 새 질문과 답이 붙음", page.get_by_text(SHORT_ANSWER).count() > 0 and page.get_by_text(FOLLOW_UP).count() > 0, page.locator("body").inner_text()[:400])


def capture(browser, base, out: Path, prefix: str, width: int):
    strict = prefix == "after-"
    fake = LlmFake()
    context, page = open_session(browser, base, fake, width)
    guide_checks(strict, page, "a-composer", width, False)
    page.screenshot(path=str(out / f"{prefix}a-composer-{width}.png"), animations="disabled")

    editor = composer(page)
    editor.fill(FOLLOW_UP)
    page.get_by_test_id("chat-input").get_by_test_id("send-button").click()
    waited = 0
    while not fake.continued and not fake.llm_completions_calls and waited < 5000:
        page.wait_for_timeout(100)
        waited += 100
    if strict:
        expect(page.get_by_text(SHORT_ANSWER)).to_be_visible(timeout=15000)
    else:
        page.wait_for_timeout(1500)
    page.wait_for_timeout(600)
    sent = [path for method, path in fake.calls if method == "POST"]
    record(strict, f"b-continued {width}px: 보낸 곳이 같은 세션의 intervene이고 llm completions는 부르지 않음",
           sent == [f"/api/sessions/{SESSION_ID}/intervene"], sent)
    guide_checks(strict, page, "b-continued", width, True)
    page.screenshot(path=str(out / f"{prefix}b-continued-{width}.png"), animations="disabled")
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="찍을 빌드 폴더(unified-dashboard/dist)")
    parser.add_argument("--prefix", required=True, choices=("before-", "after-"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    server, base = serve(Path(args.dist))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width in WIDTHS:
                capture(browser, base, out, args.prefix, width)
            browser.close()
    finally:
        server.shutdown()
    (out / f"{args.prefix}checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(CHECKS)} checks recorded, captures in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

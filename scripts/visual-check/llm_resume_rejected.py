#!/usr/bin/env python3
"""끝난 llm 세션에서 글을 보냈을 때 노드의 영구 거절 문구가 보이는지 시각 검수 (카드 #1901 단위 u8).

llm_continue.py의 가짜 서버(LlmFake)를 이어, 이어 쓰기 요청(POST /intervene)에 두 가지 응답을 준다.
  r-old  옛 응답. 200 queued(delivered:false, next_turn_required). 거절 문구가 없다. 기록만 한다.
  r-new  새 응답. 422 {error:{code:"RESUME_REJECTED", message}}. 「전송하지 못했습니다: <문구>」가 한 번만 보여야 한다.

좁은 폭(360)은 llm_continue.py와 같게 1440 화면에서 채팅 패널을 360px까지 줄여 찍는다.
장면마다 기대 문구와 가로 넘침 없음을 <prefix>checks.json에 남긴다. 단언은 r-new에서만 한다. 운영 사이트에는 접속하지 않는다.

사용
  corepack pnpm -C unified-dashboard run build
  python3 -P scripts/visual-check/llm_resume_rejected.py --dist unified-dashboard/dist --output <폴더>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from llm_continue import FOLLOW_UP, OVERFLOW, WIDTHS, LlmFake, composer, open_session, record  # noqa: E402
from settings_toolbar_fakes import CHECKS, SESSION_ID, serve  # noqa: E402

REJECTION = "이 노드에 openai 키가 없어 이어 쓸 수 없습니다."
FAILURE_TEXT = f"전송하지 못했습니다: {REJECTION}"
SCENES = ("r-old", "r-new")


class RejectingFake(LlmFake):
    """이어 쓰기 요청에 옛 응답 또는 새 응답을 준다."""

    def __init__(self, scene: str):
        super().__init__()
        self.scene = scene
        self.intervene_posts = 0

    def handle(self, route):
        request = route.request
        if request.method == "POST" and urlsplit(request.url).path == f"/api/sessions/{SESSION_ID}/intervene":
            self.calls.append((request.method, urlsplit(request.url).path))
            self.intervene_posts += 1
            if self.scene == "r-old":
                return route.fulfill(json={"type": "intervene_ack", "status": "ok", "outcome": "queued", "agentSessionId": SESSION_ID,
                                           "deliveryId": "d-old", "delivered": False, "consumeWhen": "next_turn", "reason": "next_turn_required"})
            return route.fulfill(status=422, json={"error": {"code": "RESUME_REJECTED", "message": REJECTION}})
        return super().handle(route)


def capture(browser, base, out: Path, scene: str, width: int) -> None:
    strict = scene == "r-new"
    fake = RejectingFake(scene)
    context, page = open_session(browser, base, fake, width)
    composer(page).fill(FOLLOW_UP)
    page.get_by_test_id("chat-input").get_by_test_id("send-button").click()
    waited = 0
    while not fake.intervene_posts and waited < 5000:
        page.wait_for_timeout(100)
        waited += 100
    if strict:
        expect(page.get_by_text(FAILURE_TEXT)).to_be_visible(timeout=15000)
    page.wait_for_timeout(1500)
    body = page.locator("body").inner_text()
    shown = body.count(REJECTION)
    pane = page.locator('section[aria-label="세션 채팅"]')
    record(strict, f"{scene} {width}px: 보낸 곳이 같은 세션의 intervene 한 번", fake.intervene_posts == 1, fake.intervene_posts)
    record(strict, f"{scene} {width}px: 거절 문구 「{FAILURE_TEXT}」 표시 횟수", shown == (1 if strict else 0), shown)
    record(strict, f"{scene} {width}px: 가로 넘침 없음", page.evaluate(OVERFLOW) and pane.evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), width)
    page.screenshot(path=str(out / f"{scene}-{width}.png"), animations="disabled")
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="찍을 빌드 폴더(unified-dashboard/dist)")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    server, base = serve(Path(args.dist))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for scene in SCENES:
                for width in WIDTHS:
                    capture(browser, base, out, scene, width)
            browser.close()
    finally:
        server.shutdown()
    (out / "checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(CHECKS)} checks recorded, captures in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

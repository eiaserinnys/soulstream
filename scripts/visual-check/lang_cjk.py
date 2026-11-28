#!/usr/bin/env python3
"""Exercise and capture Japanese and Simplified Chinese in the Vite dashboard."""
from __future__ import annotations

import argparse
from copy import deepcopy
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from cards_i18n import CardsFake, DETAIL, DETAIL_ID, select_tab
from persistent_i18n import FIXTURE_MODULE, PersistentFake
from sessions_i18n import copy_for
from settings_i18n import capture, focus, page_for, start_vite
from settings_toolbar_fakes import SESSION_ID, open_settings

NAMES = ("한국어", "English", "日本語", "简体中文")
SAMPLES = {
    "ja": (
        "公開前にダッシュボードを確認してください",
        "設定を保存し、別のブラウザーでダッシュボードを開いて、同じアカウントに保存した表示言語が正しく選択されることを確認してください。",
    ),
    "zh-Hans": (
        "请在发布前检查仪表盘",
        "保存设置后请在另一款浏览器中打开仪表盘，确认登录同一账户后会自动使用已保存的界面语言，并检查所有确认项是否都能在窄屏上完整阅读。",
    ),
    "ko": (
        "공개 전 대시보드를 확인해 주세요",
        "설정을 저장한 뒤 다른 브라우저에서 대시보드를 열어 같은 계정에 저장한 표시 언어가 선택되는지 확인해 주세요.",
    ),
}
RAW_KEY = re.compile(r"\b(?:settings|cards|ui|admin|persistent|sessions)\.[A-Za-z]\w*(?:\.\w+)*\b")


class CjkCards(CardsFake):
    def __init__(self, language):
        super().__init__("ko")
        title, sentence = SAMPLES[language]
        self.detail = deepcopy(DETAIL)
        self.detail["card"]["title"] = title
        self.detail["questions"] = [{
            **self.detail["questions"][0], "kind": "request",
            "title": title, "text": sentence * 2, "options": ["했어"],
        }]

    def handle(self, route):
        if route.request.url.split("?", 1)[0].endswith(f"/api/cards/{DETAIL_ID}"):
            return route.fulfill(json=self.detail)
        return super().handle(route)


def record(page, out, notes, language, screen, width, region):
    expect(region).to_be_visible()
    page.evaluate("() => document.fonts.ready")
    raw = RAW_KEY.findall(region.inner_text())
    assert not raw, (screen, raw)
    measures = region.evaluate("""root => {
      const bounds = root.getBoundingClientRect();
      return {
        root: [Math.round(bounds.left), Math.round(bounds.right)],
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        clipped: [...root.querySelectorAll('button, [role="option"], .config-category-item > span')]
          .filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 1)
          .map(el => (el.innerText || el.getAttribute('aria-label') || '').trim())
      };
    }""")
    assert measures["document"] <= width, measures
    capture(page, out, f"{language}-{screen}-{width}.png")
    notes.append(f"| {language}-{screen}-{width} | {measures['root']} / {measures['document']}px | "
                 f"{', '.join(filter(None, measures['clipped'])) or '없음'} | 없음 |")
    print(f"{language}-{screen}-{width}", flush=True)


def select_language(page, fake, out, notes, operations, language, width):
    open_settings(page)
    dialog = page.locator('[data-slot="dialog-popup"]')
    first_focus = focus(page)
    appearance = copy_for("ko", "settings")["tabs"]["appearance"]["label"]
    dialog.get_by_role("button", name=appearance, exact=True).click()
    field = page.get_by_role("combobox", name=copy_for("ko", "settings")["language"], exact=True)
    field.scroll_into_view_if_needed()
    field.click()
    option = page.get_by_role("option", name=NAMES[2 if language == "ja" else 3], exact=True)
    option.press("Enter")
    expect(page.locator("html")).to_have_attribute("lang", language)
    page.wait_for_function("(lang) => localStorage.getItem('soul-language') === lang", arg=language)
    for _ in range(30):
        if fake.preferences["language"] == language:
            break
        page.wait_for_timeout(50)
    assert fake.preferences["language"] == language, fake.preferences
    settings = copy_for(language, "settings")
    field = page.get_by_role("combobox", name=settings["language"], exact=True)
    expect(field).to_have_accessible_description(settings["languageHelp"])
    field.scroll_into_view_if_needed()
    if width == 1440:
        record(page, out, notes, language, "language-row", width, dialog)
        field.press("Enter")
        for name in NAMES:
            expect(page.get_by_role("option", name=name, exact=True)).to_be_visible()
        expect(page.get_by_role("option", name="日本語", exact=True).locator(".break-keep")).to_have_css("word-break", "normal")
        record(page, out, notes, language, "language", width, dialog)
        page.keyboard.press("Escape")
        expect(field).to_be_focused()
        page.keyboard.press("Tab")
        assert focus(page)["inside"]
        field.focus()
        page.set_viewport_size({"width": 360, "height": 800})
        expect(field).to_be_visible()
        page.set_viewport_size({"width": width, "height": 900})
        expect(field).to_be_visible()
        operations.append(f"- {language} 언어 선택 Enter/Esc 후 선택 버튼에 초점, "
                          f"Tab 초점은 창 내부, 1440→360→1440에서 언어 행 보임. 첫 초점 {first_focus}.")
    else:
        page.locator(".config-detail").get_by_role("button", name=settings["allSettings"], exact=True).click()
        record(page, out, notes, language, "settings-tabs", width, dialog)
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    operations.append(f"- {language} {width}px 설정 창 닫은 뒤 초점 {focus(page)}.")


def dashboard(browser, base, out, notes, operations, language, width):
    fake = CjkCards(language)
    context, page, _ = page_for(browser, base, width, fake=fake)
    page.set_default_timeout(12000)
    try:
        if language != "ko":
            select_language(page, fake, out, notes, operations, language, width)
            page.reload(wait_until="domcontentloaded")
            expect(page.locator("html")).to_have_attribute("lang", language)

        copy = copy_for(language, "cards")
        board = page.locator(".v3-card-board")
        expect(board.locator('[data-board-column="review"]')).to_have_attribute("aria-label", copy["status"]["review"])
        if language != "ko":
            if width == 1440:
                panel = page.get_by_test_id("v3-session-panel")
                expect(panel.locator("[data-session-id]").first).to_be_visible()
                record(page, out, notes, language, "sessions", width, panel)
            record(page, out, notes, language, "board", width, board)

        board.locator(f'[data-card-id="{DETAIL_ID}"] .v3-postit-open').click()
        detail = page.get_by_test_id("card-detail")
        expect(detail.locator(".v3-card-title-button")).to_have_text(SAMPLES[language][0])
        opened_focus = focus(page)
        expect(detail.get_by_test_id("card-check-items").get_by_text("Confirm the release window")).to_be_visible()
        record(page, out, notes, language, "detail", width, detail)
        if language == "ko":
            keep = detail.locator(".v3-card-title-editor h1")
            expect(keep).to_have_css("word-break", "keep-all")
            operations.append(f"- ko 1440px 카드 제목 글꼴 {keep.evaluate('e => getComputedStyle(e).fontFamily')}.")
            return
        select_tab(detail, copy["comment"])
        done = detail.get_by_role("button", name=copy["doneResponse"], exact=True)
        expect(done).to_be_visible()
        background = detail.locator(".v3-card-question-background")
        expect(background).to_have_css("word-break", "normal")
        measurements = background.evaluate("""element => {
          const text = document.createRange();
          text.selectNodeContents(element);
          const rects = [...text.getClientRects()];
          return {lines: new Set(rects.map(rect => Math.round(rect.top))).size,
            width: element.clientWidth, scroll: element.scrollWidth,
            font: getComputedStyle(element).fontFamily};
        }""")
        assert measurements["lines"] > 1 and measurements["scroll"] <= measurements["width"], measurements
        done.scroll_into_view_if_needed()
        record(page, out, notes, language, "request", width, detail)
        operations.append(f"- {language} {width}px 요청 본문 {measurements}.")
        page.keyboard.press("Escape")
        expect(detail).to_have_count(0)
        operations.append(f"- {language} {width}px 카드 상세 첫 초점 {opened_focus}, Esc 후 {focus(page)}.")
    except Exception:
        print(f"{language} {width}px, html lang={page.locator('html').get_attribute('lang')}", flush=True)
        print(page.locator("body").inner_text()[:1800], flush=True)
        raise
    finally:
        context.close()


def pas(browser, base, out, notes, language):
    fake = PersistentFake(language)
    context, page, _ = page_for(browser, base, 1440, language, fake)
    try:
        fake.fixture = page.evaluate(
            "(url) => import(url).then(module => module.buildPasThreadFixture())", FIXTURE_MODULE,
        )
        page.goto(f"{base}/persistent/{SESSION_ID}", wait_until="domcontentloaded")
        expect(page.locator("html")).to_have_attribute("lang", language)
        deck = page.get_by_test_id("report-deck")
        expect(deck).to_have_accessible_name(copy_for(language, "persistent")["report"]["current"])
        record(page, out, notes, language, "pas-board", 1440, deck)
    finally:
        context.close()


def card_recovery(browser, base, out, notes, operations):
    language = "ja"
    fake = CardsFake(language, hold_list=True)
    context, page, _ = page_for(browser, base, 1440, language, fake)
    copy = copy_for(language, "cards")
    try:
        home = page.get_by_test_id("card-home")
        expect(home.get_by_label(copy["loadingCards"])).to_be_visible()
        record(page, out, notes, language, "board-loading", 1440, home)
        fake.hold_list = False
        fake.held.fulfill(status=503, json={})
        expect(home.get_by_role("alert")).to_contain_text(copy["loadCardsError"])
        record(page, out, notes, language, "board-error", 1440, home)
        home.get_by_role("button", name=copy["reload"]).click()
        expect(home.locator(".v3-card-board")).to_be_visible()
        expect(home.get_by_role("alert")).to_have_count(0)
        operations.append("- ja 카드 목록 503에서 일본어 오류 문구를 확인하고 다시 읽기로 카드 판을 복구했다.")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="Directory for screenshots and operations.md")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    notes, operations = [], []
    proc, base = start_vite()
    print(f"Vite PID {proc.pid} at {base}", flush=True)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for language in ("ja", "zh-Hans"):
                for width in (1440, 360):
                    dashboard(browser, base, args.output, notes, operations, language, width)
                pas(browser, base, args.output, notes, language)
            dashboard(browser, base, args.output, notes, operations, "ko", 1440)
            card_recovery(browser, base, args.output, notes, operations)
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=20)
        (args.output / "operations.md").write_text("\n".join([
            "# 조작 결과", "",
            f"`python3 -P scripts/visual-check/lang_cjk.py --output {args.output}`", "",
            "Vite 개발 서버, Chromium, 개발 로그인과 브라우저 API 대역으로 확인했다.",
            "", "## 장면별 측정", "",
            "| 캡처 | 장면 좌우 / 문서 너비 | 버튼·탭의 스크롤 폭 초과 | 노출된 번역 키 |",
            "| --- | --- | --- | --- |", *notes,
            "", "## 직접 조작", "", *operations, "",
        ]), encoding="utf-8")


if __name__ == "__main__":
    main()

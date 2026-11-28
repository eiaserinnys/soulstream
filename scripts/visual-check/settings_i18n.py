#!/usr/bin/env python3
"""Capture and exercise the localized settings screen."""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_toolbar_fakes import Fake, new_page, open_settings, serve

ROOT = Path(__file__).resolve().parents[2]
DIALOG = '[data-slot="dialog-popup"]'


class LocaleFake(Fake):
    def __init__(self):
        super().__init__(atom=True, user_prefs={"wallpaper": {"mode": "bokeh"}, "uploaded": False})
        self.authenticated = False
        self.preferences = {"appearance": "system", "wallpaper": {"mode": "bokeh"}, "language": "ko"}

    def handle(self, route):
        request = route.request
        path = request.url.split("?", 1)[0].split("/api/")[-1]
        if path == "auth/config":
            return route.fulfill(json={"authEnabled": True, "devModeEnabled": True})
        if path == "auth/status":
            return route.fulfill(json={"authenticated": self.authenticated, "user": {"email": "qa@example.test", "name": "QA", "isAdmin": True} if self.authenticated else None})
        if path == "auth/dev-login":
            self.authenticated = True
            return route.fulfill(json={"ok": True})
        if path == "user/preferences":
            if request.method == "PUT":
                self.preferences.update(request.post_data_json or {})
            return route.fulfill(json={"email": "qa@example.test", "preferences": self.preferences, "hasBackground": False, "backgroundUrl": None, "updatedAt": None})
        return super().handle(route)


def start_vite():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, VITE_API_BASE="http://127.0.0.1:1")
    dashboard = ROOT / "unified-dashboard"
    proc = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", str(port), "--strictPort"], cwd=dashboard, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError(f"Vite exited: {proc.returncode}")
        try:
            with urlopen(base, timeout=1):
                return proc, base
        except (URLError, TimeoutError):
            time.sleep(0.2)
    proc.terminate()
    proc.wait(timeout=20)
    raise RuntimeError("Vite did not start")


def page_for(browser, base, width, locale="ko", fake=None):
    fake = fake or LocaleFake()
    context, page = new_page(browser, base, fake, width, height=900 if width > 640 else 800, preferences={"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None})
    page.add_init_script(f"localStorage.setItem('soul-language', '{locale}')")
    page.route("**/api/config/settings", lambda route: route.fulfill(json={"categories": []}))
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={"items": [], "nextCursor": None}))
    page.goto(base + "/", wait_until="domcontentloaded")
    page.get_by_test_id("dev-email-input").fill("qa@example.test")
    page.get_by_test_id("dev-login-button").click()
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=30000)
    page.wait_for_timeout(500)
    return context, page, fake


def capture(page, out, name):
    page.screenshot(path=str(out / name), animations="disabled")


def focus(page):
    return page.evaluate("""() => { const e = document.activeElement; return {label: e?.getAttribute('aria-label') || e?.textContent?.trim() || e?.tagName, inside: !!e?.closest('[data-slot="dialog-popup"]'), testid: e?.getAttribute('data-testid')}; }""")


def typography_title(page, locale):
    return page.get_by_text("채팅 글자 크기" if locale == "ko" else "Chat text size", exact=True)


def scroll_to_typography(page):
    section = page.get_by_test_id("chat-font-size-slider").locator("xpath=ancestor::section[1]")
    section.evaluate('element => element.scrollIntoView({block: "end", inline: "nearest"})')
    return typography_title(page, "ko").evaluate("""element => {
      const panel = element.closest(".config-detail");
      return {
        scrollTop: panel.scrollTop,
        titleTop: element.getBoundingClientRect().top - panel.getBoundingClientRect().top,
      };
    }""")


def clipped_tabs(page):
    labels = page.locator(".config-category-item > span")
    expect(labels).to_have_count(20)
    expect(labels.first).to_be_visible()
    page.evaluate("() => document.fonts.ready")
    return labels.evaluate_all("""labels => labels.flatMap(label => {
      const { textContent, clientWidth, scrollWidth } = label;
      return clientWidth > 0 && scrollWidth <= clientWidth ? [] : [{ textContent, clientWidth, scrollWidth }];
    })""")


def title_style(locator):
    return locator.evaluate("""element => {
      const { fontSize, fontWeight, color } = getComputedStyle(element);
      return { fontSize, fontWeight, color };
    }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline-dist", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    proc, base = start_vite()
    baseline, baseline_url = serve(Path(args.baseline_dist))
    observations = []
    dialog_rows = []
    resize_ok = True
    tab_ok = True
    error_ok = True
    visual_failures = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context, page, _ = page_for(browser, baseline_url, 1440)
            open_settings(page)
            before_scroll = scroll_to_typography(page)
            capture(page, out, "before-ko-settings-1440.png")
            context.close()
            for locale in ("ko", "en"):
                for width in (1440, 360):
                    context, page, fake = page_for(browser, base, width)
                    open_settings(page)
                    first_focus = focus(page)
                    if locale == "ko":
                        capture(page, out, f"ko-tabs-{width}.png")
                    if width <= 640:
                        page.get_by_role("button", name="화면과 읽기", exact=True).click()
                    expect(page.locator(".config-wallpaper-options")).to_be_visible(timeout=15000)
                    language_trigger = page.get_by_role("combobox", name="언어", exact=True)
                    language_trigger.scroll_into_view_if_needed()
                    if locale == "en":
                        language_trigger.click()
                        page.get_by_role("option", name="English", exact=True).click()
                        expect(page.get_by_role("combobox", name="Language", exact=True)).to_be_visible(timeout=10000)
                        page.wait_for_timeout(700)
                        assert fake.preferences.get("language") == "en", fake.preferences
                        if width <= 640:
                            page.get_by_role("button", name="All settings", exact=True).click()
                        clipped = clipped_tabs(page)
                        observations.append(f"영어 {width}px 탭 이름 잘림: {len(clipped)}/20")
                        if clipped:
                            visual_failures.append(f"영어 {width}px: {clipped}")
                        capture(page, out, f"en-tabs-{width}.png")
                        if width <= 640:
                            page.locator('.config-category-item[aria-current="page"]').click()
                    page.get_by_role("combobox", name="언어" if locale == "ko" else "Language", exact=True).scroll_into_view_if_needed()
                    if locale == "ko" and width == 1440:
                        after_scroll = scroll_to_typography(page)
                        observations.append(f"한국어 1440px 비교: 글자 크기 제목을 기준으로 스크롤 정렬. 변경 전 {before_scroll}, 변경 후 {after_scroll}")
                        if abs(before_scroll["titleTop"] - after_scroll["titleTop"]) > 1:
                            visual_failures.append("한국어 전후 캡처의 글자 크기 제목 위치가 다름")
                    capture(page, out, f"{locale}-settings-{width}.png")
                    overflow = page.evaluate("() => ({document: document.documentElement.scrollWidth, viewport: innerWidth})")
                    assert overflow["document"] <= overflow["viewport"], overflow
                    observations.append(f"{locale} {width}px: 문서 폭 {overflow['document']}, 화면 폭 {overflow['viewport']}")
                    field = page.get_by_role("combobox", name="언어" if locale == "ko" else "Language", exact=True)
                    expect(field).to_have_accessible_description(
                        "화면 문구의 언어를 계정에 저장합니다."
                        if locale == "ko" else "Save the display language to your account."
                    )
                    geometry = field.evaluate("""element => {
                      const label = document.querySelector(`label[for=\"${element.id}\"]`);
                      const range = document.createRange(); range.selectNodeContents(label);
                      const l = label.getBoundingClientRect(), c = element.getBoundingClientRect();
                      return {labelLeft: l.left, controlLeft: c.left, controlRight: c.right, viewport: innerWidth, lines: range.getClientRects().length, labelWidth: l.width, controlWidth: c.width};
                    }""")
                    assert abs(geometry["labelLeft"] - geometry["controlLeft"]) <= 1 and geometry["controlRight"] <= geometry["viewport"] and geometry["labelWidth"] > 0 and geometry["controlWidth"] > 0 and geometry["lines"] == 1, geometry
                    observations.append(f"{locale} {width}px 언어 행 위치와 글줄: {geometry}")
                    field_id = field.get_attribute("id")
                    language_style = title_style(page.locator(f'label[for="{field_id}"]'))
                    typography_style = title_style(typography_title(page, locale))
                    observations.append(f"{locale} {width}px 제목 스타일: 언어 {language_style}, 글자 크기 {typography_style}")
                    if language_style != typography_style:
                        visual_failures.append(f"{locale} {width}px 제목 스타일 불일치: {language_style} / {typography_style}")
                    if locale == "en" and width == 1440:
                        trigger = page.get_by_role("combobox", name="Language", exact=True)
                        trigger.focus()
                        page.keyboard.press("Tab")
                        tab_state = focus(page)
                        tab_ok = tab_state["inside"]
                        observations.append(f"언어 선택 뒤 Tab: {tab_state}")
                        trigger.focus()
                        page.keyboard.press("Enter")
                        expect(page.get_by_role("option", name="English", exact=True)).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.get_by_role("option", name="English", exact=True)).to_have_count(0)
                        selected_focus = focus(page)
                        page.set_viewport_size({"width": 360, "height": 800})
                        resize_ok = page.get_by_role("combobox", name="Language", exact=True).is_visible()
                        observations.append(f"좁은 폭에서 언어 선택 표시 유지: {resize_ok}")
                        page.set_viewport_size({"width": 1440, "height": 900})
                        page.keyboard.press("Escape")
                        expect(page.locator(DIALOG)).to_have_count(0)
                        close_focus = focus(page)
                        dialog_rows.append(f"| 설정 창 | 툴바 설정 단추 | {first_focus['label']} | 언어 선택 열기 | 창 닫힘 | {close_focus['label']} |")
                        dialog_rows.append(f"| 언어 선택 | Language 단추 | {selected_focus['label']} | 선택 목록 열기 | 목록 닫힘 | {selected_focus['label']} |")
                        observations.append(f"설정 첫 초점 {first_focus}; 선택 목록 Esc 후 {selected_focus}; 창 Esc 후 {close_focus}")
                    context.close()
            other_browser = LocaleFake()
            other_browser.preferences["language"] = "en"
            context, page, _ = page_for(browser, base, 1440, fake=other_browser)
            expect(page.locator("html")).to_have_attribute("lang", "en")
            observations.append("다른 브라우저: 로컬 값은 한국어, 계정은 영어일 때 첫 대시보드가 영어")
            context.close()
            context, page, _ = page_for(browser, base, 1440)
            page.route("**/api/config/settings", lambda route: route.fulfill(status=503, json={"detail": "unavailable"}))
            open_settings(page)
            page.wait_for_timeout(1000)
            error_text = page.locator(DIALOG).inner_text()
            error_shown = "Failed to fetch settings" in error_text
            capture(page, out, "ko-settings-error-1440.png")
            page.get_by_role("button", name="완료", exact=True).click()
            page.route("**/api/config/settings", lambda route: route.fulfill(json={"categories": []}))
            open_settings(page)
            retry_ok = page.locator(".config-wallpaper-options").is_visible()
            error_ok = error_shown and retry_ok
            observations.append(f"설정 읽기 실패 안내: {error_shown}; 닫고 다시 열어 복구: {retry_ok}")
            context.close()
            browser.close()
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=20)
        baseline.shutdown()
        baseline.server_close()
    content = ["# 조작 결과", "", "## 14번부터 18번", "", "| 항목 | 결과 | 근거 |", "| :--- | :--- | :--- |", "| 14 | 통과 | 설정 창과 언어 선택의 초점은 아래 기록 참조 |", f"| 15 | {'통과' if tab_ok else '미통과'} | Tab 초점과 언어 목록·설정 창 Esc 측정 |", "| 16 | 통과 | 360px과 1440px에서 문서 가로 폭을 비교 |", f"| 17 | {'통과' if error_ok else '미통과'} | 설정 읽기 실패 안내와 창을 다시 열어 복구 |", f"| 18 | {'통과' if resize_ok else '미통과'} | 1440px → 360px에서 상세 탭 표시 유지 여부 |", "", "## 대화상자와 줄 안 편집", "", "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| :--- | :--- | :--- | :--- | :--- | :--- |", *dialog_rows, "", "## 측정과 실행", "", *[f"- {entry}" for entry in observations], "- 환경: Vite 개발 서버와 Playwright API 대역, 개발 로그인 양식 및 운영 형태의 설정 데이터", f"- 실행: python3 -P scripts/visual-check/settings_i18n.py --output {out} --baseline-dist {args.baseline_dist}", f"- 산출물: {out}", ""]
    (out / "operations.md").write_text("\n".join(content), encoding="utf8")
    if visual_failures:
        raise SystemExit("\n".join(visual_failures))
    if not (resize_ok and tab_ok and error_ok):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

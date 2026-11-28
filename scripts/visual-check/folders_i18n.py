#!/usr/bin/env python3
"""Exercise the localized folder workspace and dialogs with fixture HTTP responses."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import LocaleFake, ROOT, capture, focus, page_for, start_vite

FOLDER = {
    "id": "folder-qa", "projectPageId": "project-qa",
    "name": "Dashboard rollout and customer feedback for the November release",
    "sortOrder": 0, "status": "open", "version": 1, "archived": False, "parentFolderId": None,
}
CHILD = {
    **FOLDER, "id": "folder-child", "projectPageId": "project-child",
    "name": "Release notes and customer support handoff", "parentFolderId": FOLDER["id"],
}
EMPTY_PAGE = {"items": [], "nextCursor": None}
READOUT_TITLE = "Release readiness readout"
READOUT_BODY = "Review the release checklist before the handoff."


def snapshot(folder):
    page_id = folder["projectPageId"]
    return {
        "page": {"id": page_id, "title": folder["name"], "version": 1, "metadata": {}, "archived": False},
        "blocks": [{
            "id": "desc-" + page_id, "page_id": page_id, "block_type": "paragraph",
            "text": "Collect release feedback and follow up on the remaining tasks.",
            "parent_id": None, "position_key": "A", "properties": {}, "collapsed": False,
        }],
        "state_vector": "AA==",
    }


class FolderFake(LocaleFake):
    def __init__(self, locale, hold_context):
        super().__init__()
        self.preferences["language"] = locale
        self.hold_context = hold_context
        self.context_routes = []

    def handle(self, route):
        url = urlsplit(route.request.url)
        path = url.path
        if path == "/api/folders":
            return route.fulfill(json={"folders": [FOLDER, CHILD], "sessions": {}})
        if path == "/api/planner/today":
            return route.fulfill(json={"attention": [], "running": [], "queued": [], "reviewSessionIds": []})
        if path == "/api/cards":
            return route.fulfill(json={"cards": []})
        for folder in (FOLDER, CHILD):
            folder_id = folder["id"]
            if path == f"/api/planner/folders/{folder_id}":
                subfolders = {"items": [CHILD], "nextCursor": None} if folder == FOLDER else EMPTY_PAGE
                return route.fulfill(json={
                    **snapshot(folder), "folder": folder, "cards": [], "subfolders": subfolders, "sessions": EMPTY_PAGE,
                })
            if path == f"/api/folders/{folder_id}":
                return route.fulfill(json={"folder": folder, "items": [], "sections": []})
            if path == f"/api/pages/{folder['projectPageId']}":
                if self.hold_context and folder == FOLDER and url.query == "include_blocks=true":
                    self.context_routes.append(route)
                    return
                return route.fulfill(json=snapshot(folder))
            if path == f"/api/pages/{folder['projectPageId']}/session-defaults":
                return route.fulfill(body="null", content_type="application/json")
        if path == "/api/board-items":
            return route.fulfill(json={"boardItems": [{
                "id": "readout-item", "itemId": "readout-doc", "itemType": "markdown",
                "folderId": FOLDER["id"], "metadata": {"title": READOUT_TITLE, "version": 1},
            }]})
        if path == "/api/markdown-documents/readout-doc":
            return route.fulfill(json={"id": "readout-doc", "title": READOUT_TITLE, "body": READOUT_BODY, "version": 1})
        return super().handle(route)


def open_folder(page, width, out, locale, folders):
    if width <= 760:
        tab = page.get_by_test_id("v3-mobile-tab-projects")
        expect(tab).to_contain_text(folders["mobile"]["allFolders"])
        tab.click()
        project_list = page.get_by_test_id("v3-mobile-project-list")
        expect(page.get_by_role("heading", name=folders["mobile"]["allFolders"])).to_be_visible()
        capture(page, out, f"{locale}-projects-{width}.png")
        project_list.get_by_role("button", name=FOLDER["name"], exact=True).click()
    else:
        page.get_by_test_id(f"v3-project-row-{FOLDER['id']}").locator(".v3-project-nav-link").click()
    expect(page.get_by_test_id("v3-folder-cards-section")).to_be_visible()


def geometry(scope):
    return scope.evaluate("""root => {
      const bounds = root.getBoundingClientRect();
      const visible = el => el.checkVisibility({checkVisibilityCSS: true}) && el.getClientRects().length;
      const clipped = [...root.querySelectorAll('h1,h2,h3,label,button,summary,input')].filter(visible).flatMap(el => {
        const box = el.getBoundingClientRect();
        const outside = box.left < Math.max(0,bounds.left) - 1 || box.right > Math.min(innerWidth,bounds.right) + 1;
        const textClipped = el.childElementCount === 0 && el.clientWidth && el.scrollWidth > el.clientWidth + 1
          && getComputedStyle(el).textOverflow !== 'ellipsis';
        return outside || textClipped ? [el.getAttribute('aria-label') || el.textContent.trim() || el.tagName] : [];
      });
      return {viewport: innerWidth, document: document.documentElement.scrollWidth, clipped};
    }""")


def check_context_error(page, fake, out, folders):
    section = page.locator(".v3-project-context[aria-busy=true]")
    expect(section.get_by_label(folders["context"]["loading"])).to_be_visible()
    section.scroll_into_view_if_needed()
    capture(page, out, "en-context-loading-1440.png")
    fake.hold_context = False
    for route in fake.context_routes:
        route.fulfill(status=503, json={"detail": "Fixture context outage"})
    alert = page.locator(".v3-project-context").get_by_text(folders["context"]["loadError"], exact=True)
    expect(alert).to_be_visible()
    expect(page.locator(".v3-project-context")).to_contain_text("Couldn't load project context (503)")
    capture(page, out, "en-context-error-1440.png")
    message = alert.inner_text()
    page.get_by_test_id("v3-child-folder-folder-child").get_by_role("button", name=f"Open {CHILD['name']} folder").click()
    page.get_by_role("button", name=folders["workspace"]["goParent"]).click()
    return message


def check_create(page, width, out, locale, folders):
    opener = page.locator(".v3-child-folders").get_by_role("button", name=folders["common"]["newFolder"], exact=True)
    opener.click()
    dialog = page.get_by_role("dialog", name=folders["common"]["newFolder"])
    name = dialog.get_by_role("textbox", name=folders["dialog"]["folderName"])
    expect(name).to_be_visible()
    opening = focus(page)
    create = dialog.get_by_role("button", name=folders["common"]["create"], exact=True)
    expect(create).to_be_disabled()
    draft = "Customer feedback and follow-up for the November release"
    name.fill(draft)
    expect(create).to_be_enabled()
    capture(page, out, f"{locale}-new-folder-{width}.png")
    dimensions = geometry(dialog)
    page.keyboard.press("Tab")
    tab = focus(page)
    page.keyboard.press("Shift+Tab")
    resize = None
    if (locale, width) == ("en", 1440):
        page.set_viewport_size({"width": 360, "height": 800})
        expect(name).to_have_value(draft)
        resize = geometry(dialog)
        page.set_viewport_size({"width": width, "height": 900})
        expect(name).to_have_value(draft)
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    return opening, tab, focus(page), dimensions, resize


def check_archive(page, out, folders):
    page.get_by_role("button", name=folders["workspace"]["menu"], exact=True).click()
    page.get_by_text(folders["archive"]["action"], exact=True).click()
    dialog = page.get_by_role("dialog", name=folders["archive"]["title"])
    expect(dialog).to_be_visible()
    capture(page, out, "en-archive-1440.png")
    opening = focus(page)
    page.keyboard.press("Tab")
    tab = focus(page)
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    return opening, tab, focus(page)


def operations(out, dialog, error, narrow, archive):
    opening, tab, closed, _, resize = dialog
    archive_open, archive_tab, archive_closed = archive
    width_ok = all(item["document"] <= 360 and not item["clipped"] for item in narrow)
    resize_ok = resize["document"] <= 360 and not resize["clipped"]
    rows = [
        (14, "실측", f"만들기 첫 초점 {opening['label']}, 닫은 뒤 {closed['label']}. 보관 첫 초점 {archive_open['label']}, 닫은 뒤 {archive_closed['label']}."),
        (15, "통과" if tab["inside"] and archive_tab["inside"] else "실측 확인 필요", f"만들기 Tab 초점 {tab['label']}, 보관 Tab 초점 {archive_tab['label']}. 두 창을 Esc로 닫았다."),
        (16, "통과" if width_ok else "넘침 확인", f"360px 실측 {json.dumps(narrow, ensure_ascii=False)}."),
        (17, "재진입 복구 확인", f"요청을 보류한 뒤 503을 주었다. 오류는 {error} 다른 폴더에 갔다가 돌아와 복구를 확인했다."),
        (18, "통과" if resize_ok else "실측 확인 필요", f"1440→360→1440px에서 만들기 입력값이 유지됐다. 360px 실측 {json.dumps(resize, ensure_ascii=False)}."),
    ]
    report = (
        "# 폴더 화면 조작 결과\n\n"
        "기존 폴더 작업 공간과 대화상자 컴포넌트를 사용했다. 새 px 값 없음.\n\n"
        "| 항목 | 결과 | 근거 |\n"
        "| :--- | :--- | :--- |\n"
        + "".join(f"| {number} | {result} | {detail} |\n" for number, result, detail in rows)
        + "\n| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |\n"
        "| :--- | :--- | :--- | :--- | :--- | :--- |\n"
        f"| 폴더 만들기 | 하위 폴더 머리의 새 폴더 | {opening['label']} | 입력 뒤 만들기 활성화 | 닫힘 | {closed['label']} |\n"
        f"| 폴더 보관 | 폴더 메뉴에서 보관 | {archive_open['label']} | Tab으로 {archive_tab['label']}까지 이동 | 닫힘 | {archive_closed['label']} |\n"
        "\n실행 명령은 python3 -P scripts/visual-check/folders_i18n.py --output <shots>. 캡처는 이 파일과 같은 폴더에 있다.\n"
    )
    (out / "operations.md").write_text(report, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    process, base = start_vite()
    narrow = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for locale, width in (("ko", 1440), ("en", 1440), ("en", 360)):
                folders = json.loads((ROOT / f"packages/i18n/src/locales/{locale}/folders.json").read_text())
                fake = FolderFake(locale, (locale, width) == ("en", 1440))
                context, page, _ = page_for(browser, base, width, locale, fake)
                print(f"{locale} {width}: open folder", flush=True)
                open_folder(page, width, out, locale, folders)
                if fake.hold_context:
                    error = check_context_error(page, fake, out, folders)
                project = page.get_by_test_id("v3-project-context")
                expect(project.get_by_role("heading", name=folders["context"]["title"])).to_be_visible()
                expect(project.get_by_text(folders["context"]["empty"], exact=True)).to_be_visible()
                project.scroll_into_view_if_needed()
                capture(page, out, f"{locale}-workspace-{width}.png")
                board = page.get_by_test_id("v3-inline-board")
                expect(board.get_by_role("heading")).to_contain_text(folders["sections"]["board"])
                expect(board.get_by_text(READOUT_TITLE, exact=False)).to_be_visible()
                board.locator(".v3-inline-board-expand").click()
                expect(board.get_by_text(READOUT_BODY, exact=True)).to_be_visible()
                capture(page, out, f"{locale}-board-{width}.png")
                assert "folders." not in board.inner_text() and "folders." not in project.inner_text()
                print(f"{locale} {width}: open creation dialog", flush=True)
                result = check_create(page, width, out, locale, folders)
                if width == 360:
                    narrow.extend([geometry(project), geometry(board), result[3]])
                if (locale, width) == ("en", 1440):
                    desktop_dialog = result
                    archive = check_archive(page, out, folders)
                context.close()
            operations(out, desktop_dialog, error, narrow, archive)
    finally:
        process.terminate()
        process.wait(timeout=20)


if __name__ == "__main__":
    main()

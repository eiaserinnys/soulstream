#!/usr/bin/env python3
"""아이폰과 아이패드 세로, 가로의 앱 셸 영역을 나란히 찍는 시각 검수 (카드 #1970).

무엇을 찍나
-----------
`?section=entryShell&safeArea=fixture`를 390x844(폰), 834x1210(아이패드 세로),
1210x834(아이패드 가로)로 그리고, 화면을 눌러 같은 영역으로 간 뒤 영역마다 세 폭을 찍는다.
영역마다 세 장을 한 장에 나란히 붙인 비교 그림(`<phase>-<area>-compare.png`)도 만든다.
`--pair <phase>`를 주면 그 phase의 같은 영역 비교 그림을 위에 붙인 전후 그림
(`<pair>-vs-<phase>-<area>.png`)도 만든다.

- 1회차 영역: start, feed, folder, folder-board(폰에는 없다), chat, session-menu, card-detail,
  settings, starred-loading / starred-loaded / starred-error(응답을 3초 늦춤, 불러온 뒤, 실패)
- 2회차 영역(`ipad_parity_round2.py`): pas(PAS 정상 화면), starred-retry-failed / starred-retry-loaded,
  search-entry / search-open, board-title, sidebar-daily-row, folder-list(폰 중요 작업, 전체 폴더와
  아이패드 서랍, 사이드바)

단언 (고치기 전 번들에서 실패하는 것이 정상인 것이 있다)
- 아이패드 채팅 머리에 「세션 메뉴」 단추가 있고 「세션 파일」 단추와 크기, 세로 가운데가 같으며,
  누르면 그 세션 이름을 제목으로 한 세션 메뉴가 열린다.
- 아이패드 사이드바가 중요 작업 첫 로딩 동안 `sidebar-starred-loading`(progressbar)을 보이고,
  불러온 뒤에는 그것이 사라지고 목록 행이 보인다.
- 616x900(아이패드 틀의 가장 좁은 폭)에서 세션 이름이 아주 길어도 채팅 머리 단추가 머리 안에 있고,
  제목이 단추와 겹치지 않으며 말줄임으로 끝난다.
- 2회차 단언은 `ipad_parity_round2.py` 머리에 있다.
- 조작 항목(초점, Tab, Esc, 창 크기 바꾸기)은 `operations`에 잰 값을 남긴다.

실행 방법
---------
1. 번들을 만든다(eiaserinnys는 heavy_verify runner 경유):
       node soul-app/scripts/export-components.mjs
   출력: unified-dashboard/dist/assets/ios-components
2. 사용자 site-packages의 Playwright와 Pillow로 실행한다:
       python3 -P soul-app/scripts/visual-check/ipad_parity.py \\
           --bundle unified-dashboard/dist/assets/ios-components \\
           --out <캡처 폴더> --phase after [--pair before]

번들만 로컬 HTTP 서버로 제공하고 `/api/auth/status`만 흉내 낸다(쿠키 review=fixture).
긴 세션 이름 사례는 두 번째 서버가 번들 JS의 `공개 예시 세션 `을 긴 이름으로 바꿔 서빙한다.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import Page, sync_playwright  # noqa: E402

import ipad_parity_round2  # noqa: E402
from parity_harness import (  # noqa: E402
    EDGE_TOLERANCE, FRAMES, NARROW, TABLET_FRAMES, BundleServer, Run, capture_area, compose,
    ensure_sidebar, stack, visible,
)

SESSION_NAME = "공개 예시 세션 10"
STARRED_ROW_TITLE = "공개 예시 프로젝트"
LONG_SESSION_PREFIX = "아주 긴 세션 이름이 채팅 머리의 단추를 밀어내지 않고 한 줄 말줄임으로 끝나는지 보는 공개 예시 세션 "
BUNDLE_SESSION_PREFIX = b"\\uacf5\\uac1c \\uc608\\uc2dc \\uc138\\uc158 "

HEADER_JS = r"""
() => {
  const round = (v) => Math.round(v * 100) / 100;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height) };
  };
  const header = document.querySelector('[data-testid="tablet-chat-header"]');
  if (!header) return null;
  const pick = (label) => [...header.querySelectorAll(`[aria-label="${label}"]`)]
    .find((el) => el.getBoundingClientRect().width > 0) || null;
  const title = [...header.querySelectorAll('div')].find((el) => el.children.length === 0
    && el.textContent && el.textContent.includes('세션')) || null;
  const titleStyle = title ? getComputedStyle(title) : null;
  return {
    header: box(header), headerScroll: { scrollWidth: header.scrollWidth, clientWidth: header.clientWidth },
    files: box(pick('세션 파일')), menu: box(pick('세션 메뉴')), close: box(pick('챗 닫기')),
    title: box(title), titleText: title ? title.textContent : null,
    titleEllipsis: titleStyle ? titleStyle.textOverflow : null,
    titleClipped: title ? title.scrollWidth > title.clientWidth : null,
    titleLines: title ? title.getClientRects().length : null,
  };
}
"""

ACTIVE_JS = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { label: el.getAttribute('aria-label'), testId: el.getAttribute('data-testid'),
    text: (el.textContent || '').trim().slice(0, 40) };
}"""






def go_feed(page: Page, frame: str) -> None:
    if frame == "phone":
        page.get_by_test_id("phone-tab-FeedTab").click()
        page.wait_for_timeout(900)


def go_folder(page: Page, frame: str, width: int) -> None:
    if frame == "phone":
        page.get_by_test_id("phone-tab-FolderTab").click()
        page.wait_for_timeout(900)
        page.get_by_text("전체 폴더", exact=True).filter(visible=True).first.click()
        page.wait_for_timeout(900)
        page.get_by_text("공개 예시 폴더", exact=False).filter(visible=True).first.click()
    else:
        ensure_sidebar(page, width)
        page.get_by_test_id("sidebar-main-list").get_by_text("공개 예", exact=False).first.click()
        page.get_by_test_id("task-workspace-tablet-header").wait_for(state="visible")
    page.wait_for_timeout(1200)


def go_chat(page: Page, frame: str) -> None:
    go_feed(page, frame)
    page.get_by_text(SESSION_NAME, exact=True).first.click()
    page.wait_for_timeout(1500)


def go_settings(page: Page, frame: str, width: int) -> None:
    if frame == "phone":
        page.get_by_test_id("phone-tab-SettingsTab").click()
    else:
        ensure_sidebar(page, width)
        page.get_by_text("설정", exact=True).last.click()
    page.wait_for_timeout(1200)


def chat_header(page: Page) -> dict | None:
    return page.evaluate(HEADER_JS)


def center(box: dict | None) -> float | None:
    return None if not box else (box["top"] + box["bottom"]) / 2


def check_chat_header(run: Run, frame_id: str, metrics: dict | None) -> None:
    menu = metrics and metrics["menu"]
    files = metrics and metrics["files"]
    run.check(f"{frame_id}: chat header has 세션 메뉴", bool(menu), metrics)
    if not (menu and files):
        return
    run.check(f"{frame_id}: 세션 메뉴 matches 세션 파일 size",
              abs(menu["width"] - files["width"]) <= EDGE_TOLERANCE
              and abs(menu["height"] - files["height"]) <= EDGE_TOLERANCE,
              {"menu": menu, "files": files})
    run.check(f"{frame_id}: 세션 메뉴 vertical center matches 세션 파일",
              abs(center(menu) - center(files)) <= EDGE_TOLERANCE, {"menu": menu, "files": files})
    run.check(f"{frame_id}: 세션 메뉴 sits right of 세션 파일", menu["left"] >= files["right"] - EDGE_TOLERANCE,
              {"menu": menu, "files": files})


def menu_dialog_title(page: Page) -> str | None:
    dialog = page.get_by_test_id("entry-shell-os-alert-harness")
    try:
        dialog.wait_for(state="visible", timeout=6000)
    except Exception:  # noqa: BLE001
        return None
    return dialog.inner_text()


def capture_chat_and_menu(run: Run) -> None:
    for frame in FRAMES:
        frame_id, width, height = frame
        page = run.open(frame)
        try:
            go_chat(page, frame_id)
            run.shot(page, "chat", frame_id)
            if frame_id == "phone":
                trigger = page.get_by_label("세션 메뉴", exact=True).first
            else:
                metrics = chat_header(page)
                check_chat_header(run, frame_id, metrics)
                run.operations.setdefault("header", {})[frame_id] = metrics
                trigger = page.get_by_test_id("tablet-chat-header").get_by_label("세션 메뉴", exact=True).first
            if not visible(page, trigger):
                run.missing("session-menu", frame_id, "no 세션 메뉴 button in chat header")
                continue
            if frame_id != "phone":
                files = page.get_by_test_id("tablet-chat-header").get_by_label("세션 파일", exact=True).first
                files.focus()
                page.keyboard.press("Tab")
                after_files = page.evaluate(ACTIVE_JS)
                page.keyboard.press("Tab")
                after_menu = page.evaluate(ACTIVE_JS)
                run.operations.setdefault("tab_order", {})[frame_id] = {
                    "after_files": after_files, "after_menu": after_menu}
            trigger.focus()
            page.keyboard.press("Enter")
            text = menu_dialog_title(page)
            run.check(f"{frame_id}: 세션 메뉴 opens the session menu for that session",
                      bool(text) and SESSION_NAME in text and "세션 ID 복사" in text,
                      (text or "")[:200])
            opened_focus = page.evaluate(ACTIVE_JS)
            run.shot(page, "session-menu", frame_id)
            if frame_id == "ipad-landscape":
                page.set_viewport_size({"width": 834, "height": 1210})
                page.wait_for_timeout(1200)
                dialog_box = page.get_by_test_id("entry-shell-os-alert-harness").bounding_box()
                run.operations["resize_with_menu_open"] = {"dialog": dialog_box, "viewport": [834, 1210]}
                run.check("resize: open session menu stays inside the new viewport",
                          bool(dialog_box) and dialog_box["x"] >= 0 and dialog_box["x"] + dialog_box["width"] <= 834,
                          dialog_box)
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(900)
            page.keyboard.press("Escape")
            page.wait_for_timeout(900)
            closed = not visible(page, page.get_by_test_id("entry-shell-os-alert-harness"))
            closed_focus = page.evaluate(ACTIVE_JS)
            run.operations.setdefault("session_menu", {})[frame_id] = {
                "opened_focus": opened_focus, "esc_closed": closed, "focus_after_close": closed_focus}
        except Exception as error:  # noqa: BLE001
            run.missing("session-menu", frame_id, f"failed: {str(error).splitlines()[0]}")
        finally:
            page.context.close()


def capture_resize_chat(run: Run) -> None:
    page = run.open(FRAMES[2])
    try:
        go_chat(page, "ipad-landscape")
        before = chat_header(page)
        page.set_viewport_size({"width": 834, "height": 1210})
        page.wait_for_timeout(1500)
        after = chat_header(page)
        run.operations["resize_chat"] = {"landscape": before, "portrait": after}
        run.check("resize: chat header keeps 세션 메뉴 after landscape to portrait",
                  bool(after and after["menu"] and after["header"]
                       and after["menu"]["right"] <= after["header"]["right"] + EDGE_TOLERANCE), after)
    except Exception as error:  # noqa: BLE001
        run.notes.append(f"resize chat: {str(error).splitlines()[0]}")
    finally:
        page.context.close()


def capture_narrow_long(run: Run, long_base: str) -> None:
    page = run.open(NARROW, base=long_base)
    try:
        go_feed(page, NARROW[0])
        page.get_by_text(LONG_SESSION_PREFIX + "10", exact=True).first.click()
        page.wait_for_timeout(1500)
        metrics = chat_header(page)
        run.operations["narrow_long_title"] = metrics
        run.shot(page, "chat-long-title", NARROW[0])
        ok = bool(metrics and metrics["menu"] and metrics["files"] and metrics["title"])
        if ok:
            buttons = [metrics[key] for key in ("files", "menu", "close") if metrics[key]]
            ok = (all(b["right"] <= metrics["header"]["right"] + EDGE_TOLERANCE for b in buttons)
                  and metrics["title"]["right"] <= metrics["files"]["left"] + EDGE_TOLERANCE
                  and metrics["title"]["left"] >= metrics["header"]["left"]
                  and metrics["titleEllipsis"] == "ellipsis" and metrics["titleLines"] == 1
                  and metrics["headerScroll"]["scrollWidth"] <= metrics["headerScroll"]["clientWidth"])
        run.check("616x900 long session name: header buttons stay inside, title ellipsizes on one line", ok, metrics)
    except Exception as error:  # noqa: BLE001
        run.missing("chat-long-title", NARROW[0], f"failed: {str(error).splitlines()[0]}")
    finally:
        page.context.close()


def starred_scope(page: Page, frame_id: str):
    return page if frame_id == "phone" else page.get_by_test_id("sidebar-starred-section")


def open_starred(page: Page, frame_id: str, width: int) -> None:
    if frame_id == "phone":
        page.get_by_test_id("phone-tab-FolderTab").click()
        page.wait_for_timeout(300)
    else:
        ensure_sidebar(page, width)


def capture_starred(run: Run) -> None:
    for frame in FRAMES:
        frame_id, width, _ = frame
        page = run.open(frame, "&starred=slow")
        try:
            open_starred(page, frame_id, width)
            loading_id = "starred-loading" if frame_id == "phone" else "sidebar-starred-loading"
            loading = page.get_by_test_id(loading_id)
            shown = visible(page, loading)
            role = next((loading.nth(i).get_attribute("role") for i in range(loading.count())
                         if loading.nth(i).is_visible()), None)
            path = run.out / f"{run.phase}-starred-loading-{frame_id}.png"
            page.screenshot(path=str(path))
            run.shots.setdefault("starred-loading", {})[frame_id] = str(path)
            run.check(f"{frame_id}: starred first load shows {loading_id}", shown and role == "progressbar",
                      {"visible": shown, "role": role})
            try:
                loading.first.wait_for(state="detached", timeout=8000)
            except Exception:  # noqa: BLE001 - 남아 있으면 아래 단언이 실패를 남긴다
                pass
            gone = not visible(page, loading)
            rows = starred_scope(page, frame_id).get_by_text(STARRED_ROW_TITLE, exact=True).count()
            run.shot(page, "starred-loaded", frame_id)
            run.check(f"{frame_id}: starred loading ends with list rows", gone and rows > 0,
                      {"loading_gone": gone, "rows": rows})
        except Exception as error:  # noqa: BLE001
            run.missing("starred-loading", frame_id, f"failed: {str(error).splitlines()[0]}")
        finally:
            page.context.close()


def capture_starred_error(run: Run) -> None:
    for frame in FRAMES:
        frame_id, width, _ = frame
        page = run.open(frame, "&starred=error")
        try:
            open_starred(page, frame_id, width)
            page.wait_for_timeout(1200)
            message = starred_scope(page, frame_id).get_by_text("중요 작업을 불러오지 못했습니다", exact=False)
            run.operations.setdefault("starred_error", {})[frame_id] = {"message_visible": visible(page, message)}
            run.shot(page, "starred-error", frame_id)
        except Exception as error:  # noqa: BLE001
            run.missing("starred-error", frame_id, f"failed: {str(error).splitlines()[0]}")
        finally:
            page.context.close()



def capture_round1(run: Run, long_base: str) -> None:
    capture_area(run, "start", FRAMES, lambda page, frame, width: None)
    capture_area(run, "feed", FRAMES, lambda page, frame, width: go_feed(page, frame))
    capture_area(run, "folder", FRAMES, go_folder)
    capture_area(run, "folder-board", TABLET_FRAMES, lambda page, frame, width: (
        go_folder(page, frame, width),
        page.get_by_test_id("settings-segment-tablet-card-view-board").click(),
        page.wait_for_timeout(1200)))
    run.missing("folder-board", "phone", "iPhone folder has no card board (iPad-only feature)")
    capture_chat_and_menu(run)
    capture_area(run, "card-detail", FRAMES, lambda page, frame, width: (
        page.get_by_test_id("postit-open-public-review-1").first.click(),
        page.wait_for_timeout(1500)))
    capture_area(run, "settings", FRAMES, go_settings)
    capture_starred(run)
    capture_starred_error(run)
    capture_resize_chat(run)
    capture_narrow_long(run, long_base)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", required=True, help="ios-components 번들 디렉토리")
    parser.add_argument("--out", required=True, help="캡처와 JSON을 저장할 디렉토리")
    parser.add_argument("--phase", required=True, help="파일 이름 앞머리(before, after 등)")
    parser.add_argument("--pair", help="이 phase(쉼표로 여럿)의 같은 영역 비교 그림을 위에 붙여 전후 그림을 만든다")
    parser.add_argument("--part", choices=("all", "round1", "round2"), default="all",
                        help="한 번에 다 돌면 오래 걸리므로 1회차, 2회차 장면을 나눠 돌린다")
    args = parser.parse_args()

    bundle = Path(args.bundle).resolve()
    out = Path(args.out).resolve()
    if not (bundle / "index.html").is_file():
        raise SystemExit(f"번들 index.html이 없습니다: {bundle}")
    out.mkdir(parents=True, exist_ok=True)
    long_name = json.dumps(LONG_SESSION_PREFIX, ensure_ascii=True)[1:-1].encode()

    with BundleServer(bundle) as server, \
            BundleServer(bundle, {BUNDLE_SESSION_PREFIX: long_name}) as long_server, \
            sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        run = Run(browser, server.base, out, args.phase)
        try:
            if args.part in ("all", "round1"):
                capture_round1(run, long_server.base)
            if args.part in ("all", "round2"):
                ipad_parity_round2.capture_all(run)
        finally:
            browser.close()

    compares = {area: compose(run, area, frames) for area, frames in run.shots.items()
                if area != "chat-long-title"}
    compares.update(run.custom_compares)
    pairs = {}
    for pair in (args.pair.split(",") if args.pair else []):
        for area, path in compares.items():
            earlier = out / f"{pair}-{area}-compare.png"
            if earlier.is_file():
                pairs[f"{pair}-vs-{args.phase}-{area}"] = stack(
                    earlier, Path(path), out / f"{pair}-vs-{args.phase}-{area}.png",
                    (f"{pair} · {area}", f"{args.phase} · {area}"))
    passed = all(entry["passed"] for entry in run.checks)
    result = {"phase": args.phase, "passed": passed, "checks": run.checks, "shots": run.shots,
              "compare": compares, "pairs": pairs, "operations": run.operations, "notes": run.notes}
    result_name = f"{args.phase}-result.json" if args.part == "all" else f"{args.phase}-{args.part}-result.json"
    (out / result_name).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    for entry in run.checks:
        print(("PASS " if entry["passed"] else "FAIL ") + entry["name"])
    for note in run.notes:
        print("NOTE " + note)
    print(out / result_name)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

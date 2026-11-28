"""카드 #1970 2회차 장면: 아이패드를 아이폰과 같게 고친 것의 캡처와 단언.

단언 (2회차 시작 커밋 번들에서는 실패하는 것이 정상이다)
- 중요 작업이 실패하면(starred=error-once) 그 자리에 실패 안내가 서고, 스크롤 칸의
  RefreshControl onRefresh(당겨서 새로고침)로 다시 불러오면 목록 행 2개가 보인다.
- 834x1210 피드 칸 머리에 「세션 검색」 단추가 있고, 누르면 피드 칸의 검색 입력에 초점이 간다.
  1210x834 피드 칸 머리에는 단추가 없다(사이드바 검색칸이 입구다).
- 834x1210, 1210x834 카드 보드 머리 제목 「카드」가 잘리지 않는다(scrollWidth = clientWidth).
- 사이드바 「카드」 줄의 좌우 끝이 중요 작업 상자의 좌우 끝과 같다.
- 고른 「카드」 줄의 위쪽 선이 보인다(선 가운데를 elementFromPoint로 찍으면 그 줄이다). 가로에서는 줄이
  검색칸 아래에서 시작한다. RN 웹이 RefreshControl 목록의 style을 두 칸에 주어 위로 당김이 두 번 들던 결함.
- 피드 칸 머리 「세션 검색」, 「검색 닫기」 단추의 오른쪽 끝이 머리 안쪽 오른쪽 끝에 선다(834 첫 화면,
  834 검색 연 뒤, 1210 검색 연 뒤). 616 폭에서도 제목과 단추가 겹치지 않는다.
- 카드 상세 제목은 낱말 단위로 줄을 넘긴다(word-break keep-all).
- 834x1210 피드 행에 상태 배지 열(session-card-right-rail)이 보인다.
측정만 하는 것: 사이드바 이름 칸 폭(`operations.sidebar_names`), 피드 칸 폭(`operations.feed_width`).
"""
from __future__ import annotations

from playwright.sync_api import Page

from parity_harness import (
    EDGE_TOLERANCE, FRAMES, NARROW, TABLET_FRAMES, Run, capture_area, compose_rows, compose_tiles,
    ensure_sidebar, pull_refresh, visible,
)

STARRED_TITLES = ("공개 예시 프로젝트", "길이가 긴 폴더 이름의 줄바꿈과 말줄임을 확인하는 공개 예시")
PAS_SCREEN = "section=persistent&sample=screen&safeArea=fixture"

BOX_JS = r"""
(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
}
"""

LEAF_JS = r"""
([rootSelector, text]) => {
  const root = document.querySelector(rootSelector);
  if (!root) return null;
  const leaf = [...root.querySelectorAll('div')].find((el) => el.children.length === 0
    && (el.textContent || '').trim() === text && el.getBoundingClientRect().width > 0);
  if (!leaf) return null;
  let row = leaf;
  for (let i = 0; i < 6 && row && row.getBoundingClientRect().width <= 150; i++) row = row.parentElement;
  const r = leaf.getBoundingClientRect();
  const rr = row ? row.getBoundingClientRect() : null;
  return { scrollWidth: leaf.scrollWidth, clientWidth: leaf.clientWidth, width: Math.round(r.width),
    row: rr ? { left: Math.round(rr.left), right: Math.round(rr.right) } : null };
}
"""

NAME_JS = r"""
(selector) => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const out = [];
  for (const el of root.querySelectorAll('div')) {
    if (el.children.length) continue;
    const text = (el.textContent || '').trim();
    if (!text.startsWith('공개 예') && !text.startsWith('길이가')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    out.push({ text, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      clipped: el.scrollWidth > el.clientWidth, full: el.scrollWidth });
  }
  return out.slice(0, 6);
}
"""

DAILY_ROW_JS = r"""
() => {
  const list = document.querySelector('[data-testid="sidebar-main-list"]');
  const starred = document.querySelector('[data-testid="sidebar-starred-section"]');
  if (!list || !starred) return null;
  const leaf = [...list.querySelectorAll('div')].find((el) => el.children.length === 0
    && (el.textContent || '').trim() === '카드' && el.getBoundingClientRect().width > 0);
  let row = leaf;
  while (row && row.parentElement !== starred.parentElement) row = row.parentElement;
  if (row && row.getAttribute('data-testid') === 'sidebar-daily-row') row = row.firstElementChild;
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right) };
}
"""

ROW_EDGE_JS = r"""
() => {
  const list = document.querySelector('[data-testid="sidebar-main-list"]');
  if (!list) return null;
  const leaf = [...list.querySelectorAll('div')].find((el) => el.children.length === 0
    && (el.textContent || '').trim() === '카드' && el.getBoundingClientRect().width > 0);
  let row = leaf;
  while (row && parseFloat(getComputedStyle(row).borderTopWidth || '0') === 0) row = row.parentElement;
  if (!row) return null;
  const r = row.getBoundingClientRect();
  const hit = document.elementFromPoint((r.left + r.right) / 2, r.top + 0.5);
  const search = [...document.querySelectorAll('[data-testid="session-search-input"]')]
    .find((el) => el.getBoundingClientRect().width > 0);
  return { top: r.top, topEdgeHitsRow: !!hit && (row === hit || row.contains(hit)),
    searchBottom: search ? search.getBoundingClientRect().bottom : null };
}
"""

FEED_HEADER_JS = r"""
() => {
  const header = [...document.querySelectorAll('[data-testid="tablet-feed-header"]')]
    .find((el) => el.getBoundingClientRect().width > 0);
  if (!header) return null;
  const h = header.getBoundingClientRect();
  const contentRight = h.right - parseFloat(getComputedStyle(header).paddingRight);
  const button = [...header.querySelectorAll('[aria-label="세션 검색"], [aria-label="검색 닫기"]')]
    .find((el) => el.getBoundingClientRect().width > 0);
  const title = header.querySelector('[data-testid="tablet-feed-title"]');
  const b = button ? button.getBoundingClientRect() : null;
  const tr = title ? title.getBoundingClientRect() : null;
  return { left: h.left, right: h.right, bottom: h.bottom, contentRight,
    button: b && { label: button.getAttribute('aria-label'), left: b.left, right: b.right },
    title: tr && { left: tr.left, right: tr.right },
    gapToContentRight: b ? +(contentRight - b.right).toFixed(1) : null };
}
"""

FOCUS_JS = r"""
() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const pane = document.querySelector('[data-testid="split-panel-session"]');
  return { tag: el.tagName, placeholder: el.getAttribute('placeholder'), inFeedPane: !!(pane && pane.contains(el)) };
}
"""


def capture_all(run: Run) -> None:
    capture_area(run, "pas", FRAMES, lambda page, frame, width: page.wait_for_timeout(1500), section=PAS_SCREEN)
    capture_starred_retry(run)
    capture_search_entry(run)
    capture_board_title(run)
    capture_daily_row(run)
    capture_feed_header(run)
    check_card_title(run)
    check_feed_rail(run)
    capture_folder_lists(run)


def failure(error: Exception) -> str:
    return f"failed: {str(error).splitlines()[0]}"


def capture_starred_retry(run: Run) -> None:
    for frame in FRAMES:
        frame_id, width, _ = frame
        page = run.open(frame, "&starred=error-once")
        try:
            if frame_id == "phone":
                page.get_by_test_id("phone-tab-FolderTab").click()
                scroll_id, scope = "starred-task-scroll", page
            else:
                ensure_sidebar(page, width)
                scroll_id, scope = "sidebar-main-list", page.get_by_test_id("sidebar-starred-section")
            page.wait_for_timeout(1500)
            failed = visible(page, scope.get_by_text("중요 작업을 불러오지 못했습니다", exact=False))
            run.shot(page, "starred-retry-failed", frame_id)
            refreshed = pull_refresh(page, scroll_id)
            page.wait_for_timeout(1500)
            rows = sum(1 for title in STARRED_TITLES if visible(page, scope.get_by_text(title, exact=True)))
            run.shot(page, "starred-retry-loaded", frame_id)
            run.check(f"{frame_id}: starred failure, pull to refresh, 2 rows", failed and refreshed == "called" and rows == 2,
                      {"failure_shown": failed, "refresh": refreshed, "rows": rows})
        except Exception as error:  # noqa: BLE001
            run.missing("starred-retry-failed", frame_id, failure(error))
        finally:
            page.context.close()


def capture_search_entry(run: Run) -> None:
    for frame in FRAMES:
        frame_id, _, _ = frame
        page = run.open(frame)
        try:
            if frame_id == "phone":
                page.get_by_test_id("phone-tab-FeedTab").click()
                page.wait_for_timeout(900)
                button = page.get_by_label("세션 검색", exact=True)
            else:
                button = page.get_by_test_id("tablet-feed-header").get_by_label("세션 검색", exact=True)
            shown = visible(page, button)
            run.shot(page, "search-entry", frame_id)
            if frame_id == "ipad-landscape":
                field = page.get_by_placeholder("세션 및 대화 검색").filter(visible=True)
                run.check("ipad-landscape: one search entry (sidebar field, no feed button)",
                          not shown and field.count() == 1, {"feed_button": shown, "sidebar_fields": field.count()})
                if field.count():
                    field.first.click()
            elif shown:
                button.filter(visible=True).first.click()
            page.wait_for_timeout(1000)
            focus = page.evaluate(FOCUS_JS)
            run.operations.setdefault("search_entry", {})[frame_id] = {"button": shown, "focus": focus}
            if frame_id == "ipad-portrait":
                run.check("ipad-portrait: feed header 세션 검색 focuses the feed search input",
                          shown and bool(focus) and focus["tag"] in ("INPUT", "TEXTAREA") and focus["inFeedPane"],
                          {"button": shown, "focus": focus})
            run.shot(page, "search-open", frame_id)
        except Exception as error:  # noqa: BLE001
            run.missing("search-entry", frame_id, failure(error))
        finally:
            page.context.close()


def capture_board_title(run: Run) -> None:
    for frame in FRAMES:
        frame_id, _, _ = frame
        page = run.open(frame)
        try:
            run.shot(page, "board-title", frame_id)
            if frame_id == "phone":
                continue
            title = page.evaluate(LEAF_JS, ['[data-testid="tablet-main-title"]', "카드"])
            run.operations.setdefault("board_title", {})[frame_id] = title
            run.check(f"{frame_id}: board header title 「카드」 is not clipped",
                      bool(title) and title["scrollWidth"] <= title["clientWidth"], title)
        except Exception as error:  # noqa: BLE001
            run.missing("board-title", frame_id, failure(error))
        finally:
            page.context.close()


def capture_daily_row(run: Run) -> None:
    top_rows: list[tuple[str, str]] = []
    for frame in TABLET_FRAMES:
        frame_id, width, _ = frame
        page = run.open(frame, "&starred=ready")
        try:
            ensure_sidebar(page, width)
            page.wait_for_timeout(900)
            row = page.evaluate(DAILY_ROW_JS)
            sheet = page.evaluate(BOX_JS, '[data-testid="starred-task-sheet"]')
            run.operations.setdefault("sidebar_daily_row", {})[frame_id] = {"row": row, "starred_sheet": sheet}
            run.shot(page, "sidebar-daily-row", frame_id)
            ok = bool(row and sheet) and abs(row["left"] - sheet["left"]) <= EDGE_TOLERANCE \
                and abs(row["right"] - sheet["right"]) <= EDGE_TOLERANCE
            run.check(f"{frame_id}: sidebar 카드 row edges match the starred sheet", ok, {"row": row, "starred_sheet": sheet})
            edge = page.evaluate(ROW_EDGE_JS)
            run.operations.setdefault("sidebar_row_top", {})[frame_id] = edge
            top_rows.append((f"{frame_id} · 사이드바 위 340x220", crop(run, page, "sidebar-top", frame_id,
                                                                        {"x": 0, "y": 0, "width": 340, "height": 220})))
            ok = bool(edge) and edge["topEdgeHitsRow"]
            if frame_id == "ipad-landscape":
                ok = ok and edge["searchBottom"] is not None and edge["top"] >= edge["searchBottom"]
            run.check(f"{frame_id}: selected 카드 row top edge is visible"
                      + (" below the search field" if frame_id == "ipad-landscape" else ""), ok, edge)
        except Exception as error:  # noqa: BLE001
            run.missing("sidebar-daily-row", frame_id, failure(error))
        finally:
            page.context.close()
    run.missing("sidebar-daily-row", "phone", "iPhone has no sidebar; its 카드 tab is in the bottom bar")
    run.custom_compares["sidebar-top"] = compose_rows(run.out / f"{run.phase}-sidebar-top-compare.png", top_rows)


def crop(run: Run, page: Page, area: str, name: str, clip: dict) -> str:
    path = run.out / f"{run.phase}-{area}-{name}.png"
    page.wait_for_timeout(500)
    page.screenshot(path=str(path), clip=clip)
    return str(path)


def capture_feed_header(run: Run) -> None:
    portrait, landscape = TABLET_FRAMES
    cases = (("portrait-entry", portrait, None), ("portrait-open", portrait, "feed"),
             ("landscape-open", landscape, "sidebar"), ("narrow-entry", NARROW, None))
    rows: list[tuple[str, str]] = []
    for name, frame, opener in cases:
        page = run.open(frame)
        try:
            if opener == "feed":
                page.get_by_test_id("tablet-feed-header").get_by_label("세션 검색", exact=True).first.click()
            elif opener == "sidebar":
                page.get_by_test_id("session-search-input").filter(visible=True).first.click()
            page.wait_for_timeout(900)
            header = page.evaluate(FEED_HEADER_JS)
            run.operations.setdefault("feed_header", {})[name] = header
            if not header:
                rows.append((name, "missing: no feed header"))
                run.check(f"{name}: feed header action", False, header)
                continue
            left = max(0, header["left"] - 8)
            rows.append((f"{name} · {frame[1]}x{frame[2]}", crop(run, page, "feed-header", name, {
                "x": left, "y": 0, "width": min(frame[1], header["right"] + 8) - left, "height": header["bottom"] + 8})))
            button, title = header["button"], header["title"]
            if name == "narrow-entry":
                run.check("ipad-narrow: feed header title and action do not overlap",
                          bool(button and title) and title["right"] <= button["left"], header)
            else:
                run.check(f"{name}: feed header action sits at the header's right edge",
                          header["gapToContentRight"] is not None and abs(header["gapToContentRight"]) <= 1, header)
        except Exception as error:  # noqa: BLE001
            rows.append((name, f"missing: {failure(error)}"))
            run.check(f"{name}: feed header action", False, failure(error))
        finally:
            page.context.close()
    run.custom_compares["feed-header"] = compose_rows(run.out / f"{run.phase}-feed-header-compare.png", rows)


def check_card_title(run: Run) -> None:
    for frame in FRAMES:
        frame_id, _, _ = frame
        page = run.open(frame)
        try:
            page.get_by_test_id("postit-open-public-review-1").first.click()
            page.get_by_test_id("card-detail-title").filter(visible=True).first.wait_for(state="visible")
            run.shot(page, "card-title", frame_id)
            word_break = page.evaluate("""() => {
              const el = [...document.querySelectorAll('[data-testid="card-detail-title"]')]
                .find((e) => e.getBoundingClientRect().width > 0);
              return el ? getComputedStyle(el).wordBreak : null;
            }""")
            run.check(f"{frame_id}: card detail title breaks between words", word_break == "keep-all", word_break)
        except Exception as error:  # noqa: BLE001
            run.notes.append(f"card title {frame_id}: {failure(error)}")
        finally:
            page.context.close()


def check_feed_rail(run: Run) -> None:
    for frame in TABLET_FRAMES:
        frame_id, _, _ = frame
        page = run.open(frame)
        try:
            pane = page.evaluate(BOX_JS, '[data-testid="split-panel-session"]')
            rails = page.locator('[data-testid="session-card-right-rail"]').filter(visible=True).count()
            run.operations.setdefault("feed_width", {})[frame_id] = {"pane": pane, "visible_status_rails": rails}
            if frame_id == "ipad-portrait":
                run.check("ipad-portrait: feed rows keep the status badge column", rails > 0,
                          {"pane": pane, "visible_status_rails": rails})
        except Exception as error:  # noqa: BLE001
            run.notes.append(f"feed rail {frame_id}: {failure(error)}")
        finally:
            page.context.close()


def capture_folder_lists(run: Run) -> None:
    tiles: list[tuple[str, str]] = []

    def shoot(page: Page, name: str, label: str) -> None:
        path = run.out / f"{run.phase}-folder-list-{name}.png"
        page.wait_for_timeout(700)
        page.screenshot(path=str(path))
        tiles.append((label, str(path)))

    page = run.open(FRAMES[0], "&starred=ready")
    try:
        page.get_by_test_id("phone-tab-FolderTab").click()
        page.wait_for_timeout(1200)
        shoot(page, "phone-starred", "phone · 중요 작업")
        page.get_by_text("전체 폴더", exact=True).filter(visible=True).first.click()
        page.wait_for_timeout(1200)
        shoot(page, "phone-all", "phone · 전체 폴더")
    except Exception as error:  # noqa: BLE001
        tiles.append(("phone", f"missing: {failure(error)}"))
    finally:
        page.context.close()
    for frame in TABLET_FRAMES:
        frame_id, width, _ = frame
        page = run.open(frame, "&starred=ready")
        try:
            ensure_sidebar(page, width)
            page.wait_for_timeout(900)
            shoot(page, frame_id, f"{frame_id} · {'서랍' if frame_id == 'ipad-portrait' else '사이드바'}")
            run.operations.setdefault("sidebar_names", {})[frame_id] = page.evaluate(
                NAME_JS, '[data-testid="sidebar-main-list"]')
        except Exception as error:  # noqa: BLE001
            tiles.append((frame_id, f"missing: {failure(error)}"))
        finally:
            page.context.close()
    run.custom_compares["folder-list"] = compose_tiles(run.out / f"{run.phase}-folder-list-compare.png", tiles)

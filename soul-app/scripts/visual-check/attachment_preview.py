#!/usr/bin/env python3
"""카드 #429 앱 단위: 첨부 미리보기 창의 PDF·SVG·고정폭 텍스트 시각 검수.

실제 컴포넌트(MessageAttachments → AttachmentPreviewModal)를 웹으로 내보내
헤드리스 Chromium에서 장면을 캡처하고, 목록/PDF/텍스트/마크다운/HTML/zip/실패/
빈 파일/SVG/받는 중과 목록→PDF→닫기→zip→닫기→SVG→실패→다시 시도 흐름을 확인한다.
390 폭과 넓은 폭을 캡처하며, 단언이 깨지면 0이 아닌 코드로 끝난다.

사용:
  python3 soul-app/scripts/visual-check/attachment_preview.py --out .local/card429/app
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPT_DIR.parents[1]
HARNESS_DIR = SCRIPT_DIR / "attachment_preview"
FIXTURE_DIR = HARNESS_DIR / "fixtures"

ROW_SEL = '[data-testid="message-attachment-row-{}"]'
TILES = '[data-testid="message-attachments-images"]'
READY_SEL = '[data-testid="message-attachment-row-0"]'
SURFACE = '[data-testid="chat-image-viewer-surface"]'
CLOSE = '[data-testid="chat-image-viewer-close"]'
FRAME = '[data-testid="chat-image-viewer-frame"]'
SAVE = '[data-testid="chat-image-viewer-save-original"]'
LOADING = '[data-testid="attachment-preview-loading"]'

WIDTHS = (("390", 390, 844), ("wide", 1180, 820))
MIN_WIDTH = ("360", 360, 780)

# Text fixture row (row 1) keeps the long name so header truncation is observed.
LONG_TEXT_NAME = "수백 줄 서버 로그와 아주 긴 파일 이름을 가진 공개 검수용 첨부 문서.txt"


class Check:
    def __init__(self) -> None:
        self.items: list[dict[str, str]] = []

    def record(self, ident: str, claim: str, result: str, detail: str = "") -> None:
        self.items.append({"id": ident, "claim": claim, "result": result, "detail": detail})
        print(f"[{result}] {ident}: {claim}" + (f" — {detail}" if detail else ""))

    def run(self, ident: str, claim: str, fn) -> None:
        try:
            detail = fn()
        except Exception as error:  # noqa: BLE001 - every failure belongs in the report
            self.record(ident, claim, "fail", str(error).replace("\n", " ")[:400])
        else:
            self.record(ident, claim, "pass", detail if isinstance(detail, str) else "")

    def failures(self) -> list[dict[str, str]]:
        return [item for item in self.items if item["result"] != "pass"]


def export_bundle(export_dir: Path) -> None:
    cli = APP_ROOT / "node_modules/expo/bin/cli"
    if not cli.is_file():
        raise RuntimeError(f"expo CLI가 없습니다: {cli}")
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node를 찾지 못했습니다.")
    if export_dir.exists():
        shutil.rmtree(export_dir)
    print(f"웹 번들 내보내기: {HARNESS_DIR} → {export_dir}")
    subprocess.run(
        [node, str(cli), "export", "--platform", "web",
         "--output-dir", str(export_dir), "--max-workers", "2"],
        cwd=HARNESS_DIR, check=True,
        env={**os.environ, "EXPO_NO_TELEMETRY": "1", "CI": "1"},
    )
    if not (export_dir / "index.html").is_file():
        raise RuntimeError("웹 번들에 index.html이 없습니다.")


class DualRootHandler(BaseHTTPRequestHandler):
    """번들(dist)과 검수 fixture를 같은 출처로 제공한다."""

    dist: Path = Path(".")
    fixtures: Path = FIXTURE_DIR

    def do_GET(self) -> None:  # noqa: N802 - http.server 계약
        path = unquote(urlparse(self.path).path)
        if path in ("", "/"):
            target = self.dist / "index.html"
        elif path.startswith("/fixtures/"):
            target = self.fixtures / path[len("/fixtures/"):]
        else:
            target = self.dist / path.lstrip("/")
        if not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif target.suffix in (".js", ".mjs"):
            content_type = "text/javascript; charset=utf-8"
        elif target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif target.suffix == ".svg":
            content_type = "image/svg+xml"
        elif target.suffix == ".json":
            content_type = "application/json; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        return


def serve(dist: Path) -> ThreadingHTTPServer:
    handler = type("BoundDualRootHandler", (DualRootHandler,), {"dist": dist, "fixtures": FIXTURE_DIR})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def open_row(page, index: int) -> None:
    row = page.locator(ROW_SEL.format(index))
    row.scroll_into_view_if_needed()
    row.click()
    page.wait_for_selector(SURFACE, timeout=15000)


def close_modal(page) -> None:
    page.locator(CLOSE).click()
    page.wait_for_selector(CLOSE, state="detached", timeout=10000)


def close_with_escape(page) -> None:
    page.keyboard.press("Escape")
    page.wait_for_selector(CLOSE, state="detached", timeout=10000)


def safe_close(page) -> None:
    """한 장면이 깨져도 나머지 장면의 증거를 계속 모은다."""
    try:
        if page.locator(CLOSE).count():
            page.locator(CLOSE).click(timeout=5000)
        page.wait_for_selector(CLOSE, state="detached", timeout=5000)
    except Exception:  # noqa: BLE001 - 장면 실패는 check에 이미 남는다
        return


def wait_text(page, selector: str, text: str, timeout: int = 15000):
    locator = page.locator(f"{selector} div[dir=\"auto\"]").filter(has_text=text).first
    locator.wait_for(timeout=timeout)
    return locator


def computed(locator, prop: str) -> str:
    return locator.evaluate("(el, p) => getComputedStyle(el).getPropertyValue(p)", prop)


def page_overflow(page, selector: str = SURFACE) -> dict:
    measured = page.evaluate(
        """(selector) => {
          const surface = document.querySelector(selector);
          if (!surface) return null;
          const vw = window.innerWidth;
          const box = surface.getBoundingClientRect();
          return {
            viewport: vw,
            docScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            surfaceLeft: box.left,
            surfaceRight: box.right,
            surfaceWidth: box.width,
          };
        }""",
        selector,
    )
    if measured is None:
        raise AssertionError(f"미리보기 창을 찾지 못했습니다: {selector}")
    return measured


def read_pixels(path: Path, points: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
    from PIL import Image  # 검수 노드에만 있는 도구. 없으면 이 검사가 실패로 남는다.

    with Image.open(path) as image:
        rgb = image.convert("RGB")
        return [rgb.getpixel(point) for point in points]


def box_of(locator) -> tuple[float, float, float, float]:
    box = locator.bounding_box()
    if box is None:
        raise AssertionError("상자의 위치를 재지 못했습니다.")
    return box["x"], box["y"], box["width"], box["height"]


def svg_light_backing(page, screenshot: Path, label: str, check: Check) -> str:
    svg = page.locator('[data-testid="chat-image-viewer-image"] svg')
    svg.wait_for(timeout=15000)
    holder = svg.locator("xpath=..")
    background = computed(holder, "background-color")
    if background != "rgb(255, 255, 255)":
        raise AssertionError(f"SVG 바탕이 밝지 않습니다: {background}")
    x, y, width, height = box_of(svg)
    # 모서리는 둥근 테두리 밖이라 바탕 화소가 아니다. 위쪽 가운데와 한가운데를 본다.
    backing, middle = read_pixels(screenshot, [
        (int(x + width / 2), int(y) + min(4, int(height / 4))),
        (int(x + width / 2), int(y + height / 2)),
    ])
    if not all(channel > 240 for channel in backing):
        raise AssertionError(f"SVG 바탕 화소가 밝지 않습니다: {backing}")
    if not all(channel < 90 for channel in middle):
        raise AssertionError(f"SVG 도형이 그려지지 않았습니다: {middle}")
    check.record(f"svg-light-backing-{label}", "SVG 보기의 바탕이 밝다", "pass", background)
    check.record(f"svg-pixels-{label}", "캡처 화소로 SVG 바탕과 도형을 확인", "pass",
                 f"backing={backing} center={middle}")
    return background


def run_viewport(browser, base_url: str, out: Path, check: Check, label: str, width: int, height: int) -> None:
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    requests: list[str] = []
    page_errors: list[str] = []
    page.on("request", lambda request: requests.append(request.url))
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    def shot(name: str) -> Path:
        page.wait_for_timeout(200)
        path = out / f"{name}-{label}.png"
        page.screenshot(path=str(path))
        return path

    try:
        page.goto(f"{base_url}/?section=attachments&theme=light", wait_until="load", timeout=60000)
        page.wait_for_selector(READY_SEL, timeout=60000)
        page.wait_for_timeout(400)

        def list_scene():
            shot("list")
            tiles = page.locator(TILES).count()
            rows = page.locator('[data-testid^="message-attachment-row-"]').count()
            if tiles != 1:
                raise AssertionError(f"이미지 묶음이 하나가 아닙니다: {tiles}")
            if rows != 9:
                raise AssertionError(f"파일 행 수가 다릅니다: {rows}")
            return f"tiles={tiles} rows={rows}"

        check.run(f"list-{label}", "목록에 이미지 타일과 파일 행이 그려진다", list_scene)

        # PDF: 문서 배치 안에서 이어 보기
        def pdf_scene():
            open_row(page, 0)
            page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
            iframe = page.locator('[data-testid="attachment-preview-pdf"] iframe')
            if page.locator(FRAME).locator('[data-testid="attachment-preview-pdf"]').count() != 1:
                raise AssertionError("PDF가 미리보기 창의 문서 틀 밖에서 그려졌습니다.")
            source = iframe.get_attribute("src") or ""
            if not source.startswith("blob:"):
                raise AssertionError(f"PDF가 blob URL로 열리지 않았습니다: {source[:60]}")
            frames = page.frame_locator('[data-testid="attachment-preview-pdf"] iframe')
            frames.locator("#pdf-facsimile").wait_for(timeout=20000)
            tags = frames.locator(".tag").all_inner_texts()
            if tags != ["1쪽", "2쪽", "3쪽"]:
                raise AssertionError(f"쪽 표시가 다릅니다: {tags}")
            tops = frames.locator(".page").evaluate_all(
                "nodes => nodes.map(node => node.getBoundingClientRect().top)")
            if not (tops[0] < tops[1] < tops[2]):
                raise AssertionError(f"쪽이 위아래로 이어지지 않습니다: {tops}")
            if label == "390":
                _, _, _, frame_height = box_of(iframe)
                if frame_height < 400:
                    raise AssertionError(f"PDF 영역이 문서 배치 높이를 쓰지 않습니다: {frame_height}")
            shot("pdf")
            return f"src=blob tags={tags}"

        check.run(f"pdf-{label}", "PDF가 미리보기 창 안에서 쪽을 위아래로 이어 연다", pdf_scene)

        def pdf_escape():
            page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
            page.keyboard.press("Escape")
            page.wait_for_selector(CLOSE, state="detached", timeout=10000)
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'message-attachment-row-0'",
                timeout=10000)
            return "Esc 닫힘, 초점이 연 행으로 복귀"

        check.run(f"escape-close-{label}", "Esc로 닫히고 초점이 연 요소로 돌아온다(ui-design §0-14·15)", pdf_escape)

        # 텍스트: 고정폭·선택 가능·긴 이름 말줄임
        def text_scene():
            open_row(page, 1)
            page.wait_for_selector('[data-testid="attachment-preview-text"]', timeout=20000)
            line = wait_text(page, '[data-testid="attachment-preview-text"]', "공개 검수용 서버 로그")
            font = computed(line, "font-family")
            selectable = computed(line, "user-select")
            white_space = computed(line, "white-space")
            if "monospace" not in font:
                raise AssertionError(f"고정폭 글꼴이 아닙니다: {font}")
            if selectable != "text":
                raise AssertionError(f"본문을 선택할 수 없습니다: {selectable}")
            header_name = page.locator(SURFACE).locator('div[dir="auto"]').filter(has_text=LONG_TEXT_NAME).first
            header_name.wait_for(timeout=10000)
            overflow = header_name.evaluate(
                "el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,"
                " textOverflow: getComputedStyle(el).textOverflow, whiteSpace: getComputedStyle(el).whiteSpace,"
                " rects: el.getClientRects().length, height: el.getBoundingClientRect().height })")
            if overflow["textOverflow"] != "ellipsis":
                raise AssertionError(f"긴 이름이 말줄임이 아닙니다: {overflow}")
            if overflow["rects"] != 1:
                raise AssertionError(f"긴 이름이 여러 줄입니다: {overflow}")
            shot("text")
            return f"font={font} select={selectable} wrap={white_space} header={overflow}"

        check.run(f"text-{label}", "텍스트·로그는 고정폭 글꼴이며 선택할 수 있고 긴 이름은 말줄임", text_scene)
        safe_close(page)

        def markdown_scene():
            open_row(page, 2)
            page.wait_for_selector('[data-testid="attachment-preview-markdown"]', timeout=20000)
            heading = page.locator('[data-testid="attachment-preview-markdown"] h1').first
            heading.wait_for(timeout=15000)
            text = heading.inner_text()
            if text != "Argon 톤 제안":
                raise AssertionError(f"마크다운 제목이 다릅니다: {text}")
            shot("markdown")
            return f"h1={text}"

        check.run(f"markdown-{label}", "마크다운 첨부가 문서로 그려진다", markdown_scene)
        safe_close(page)

        def html_scene():
            open_row(page, 3)
            page.wait_for_selector('[data-testid="attachment-preview-html"] iframe', timeout=20000)
            frames = page.frame_locator('[data-testid="attachment-preview-html"] iframe')
            heading = frames.locator("h1")
            heading.wait_for(timeout=15000)
            text = heading.inner_text()
            if text != "공개 검수용 문서":
                raise AssertionError(f"HTML 제목이 다릅니다: {text}")
            shot("html")
            return f"h1={text}"

        check.run(f"html-{label}", "HTML 첨부가 지금대로 문서로 열린다", html_scene)
        safe_close(page)

        def zip_scene():
            open_row(page, 4)
            page.wait_for_selector(FRAME, timeout=15000)
            zip_text = page.locator(FRAME).locator('div[dir="auto"]').filter(has_text="ZIP").first
            zip_text.wait_for(timeout=10000)
            save = page.locator(SAVE)
            save.wait_for(timeout=10000)
            if save.is_hidden():
                raise AssertionError("바닥 저장 단추가 보이지 않습니다.")
            shot("zip")
            return "아이콘·형식 이름·바닥 저장"

        check.run(f"zip-{label}", "zip은 형식 이름과 바닥 저장으로 남는다", zip_scene)
        safe_close(page)

        def empty_scene():
            open_row(page, 5)
            page.wait_for_selector(FRAME, timeout=15000)
            empty = page.locator(FRAME).locator('div[dir="auto"]').filter(has_text="빈 파일").first
            empty.wait_for(timeout=15000)
            shot("empty")
            return "빈 파일"

        check.run(f"empty-{label}", "빈 파일은 지금 표현 그대로다", empty_scene)
        safe_close(page)

        def loading_scene():
            open_row(page, 6)
            page.wait_for_selector(LOADING, timeout=15000)
            if page.locator(LOADING).is_hidden():
                raise AssertionError("받는 중 표시가 보이지 않습니다.")
            shot("loading")
            return "받는 중 표시"

        check.run(f"loading-{label}", "받는 중은 지금 표현 그대로다", loading_scene)
        safe_close(page)

        def failure_scene():
            open_row(page, 7)
            wait_text(page, FRAME, "미리보기를 불러오지 못했습니다.")
            retry = page.locator(SURFACE).get_by_text("다시 시도", exact=True).first
            retry.wait_for(timeout=10000)
            shot("failure")
            return "실패 안내와 다시 시도"

        check.run(f"failure-{label}", "실패는 같은 틀 안에서 안내와 다시 시도를 보인다", failure_scene)
        safe_close(page)

        def svg_scene():
            tile_svg = page.locator('[data-testid="message-attachments-images-image-1"] svg')
            tile_svg.wait_for(timeout=20000)
            page.locator('[data-testid="message-attachments-images-image-1"]').click()
            path = out / f"svg-{label}.png"
            page.wait_for_timeout(400)
            page.screenshot(path=str(path))
            svg_light_backing(page, path, label, check)
            return "격자 타일과 보기 모두 svg"

        check.run(f"svg-{label}", "SVG가 격자 타일과 이미지 보기에서 그려지고 바탕이 밝다", svg_scene)
        safe_close(page)

        # 흐름: 목록→PDF→닫기→zip→닫기→SVG→(닫기)→실패→다시 시도
        def flow():
            open_row(page, 0)
            page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
            close_modal(page)
            open_row(page, 4)
            page.wait_for_selector(FRAME, timeout=15000)
            page.locator(FRAME).locator('div[dir="auto"]').filter(has_text="ZIP").first.wait_for(timeout=10000)
            close_modal(page)
            page.locator('[data-testid="message-attachments-images-image-1"]').click()
            page.wait_for_selector('[data-testid="chat-image-viewer-image"] svg', timeout=20000)
            close_with_escape(page)
            open_row(page, 8)
            wait_text(page, FRAME, "미리보기를 불러오지 못했습니다.")
            page.locator(SURFACE).get_by_text("다시 시도", exact=True).first.click()
            wait_text(page, '[data-testid="attachment-preview-text"]', "다시 시도로 불러온 본문입니다.")
            shot("flow-retry")
            close_modal(page)
            return "PDF→zip→SVG→실패→다시 시도 완료"

        check.run(f"flow-{label}", "목록→PDF→닫기→zip→닫기→SVG→실패→다시 시도 흐름", flow)
        safe_close(page)

        # ui-design §0-16: 넘침과 잘림
        def overflow_check():
            open_row(page, 0)
            page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
            box = page_overflow(page)
            iframe_width = box_of(page.locator('[data-testid="attachment-preview-pdf"] iframe'))[2]
            close_modal(page)
            if box["docScrollWidth"] > box["viewport"] + 0.5:
                raise AssertionError(f"가로 스크롤이 생깁니다: {box}")
            if box["surfaceRight"] > box["viewport"] + 0.5 or box["surfaceLeft"] < -0.5:
                raise AssertionError(f"미리보기 창이 화면을 넘습니다: {box}")
            if box["surfaceWidth"] < 300:
                raise AssertionError(f"미리보기 창이 0폭으로 줄었습니다: {box}")
            if iframe_width < 280:
                raise AssertionError(f"PDF 영역이 줄었습니다: {iframe_width}")
            return f"{box} iframe={iframe_width}"

        check.run(f"no-overflow-{label}", "정해진 폭에서 가로 넘침·잘림·0폭 축소가 없다(ui-design §0-16)", overflow_check)
        safe_close(page)

        if label == "wide":
            def resize_case():
                open_row(page, 0)
                page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
                page.set_viewport_size({"width": 390, "height": 844})
                page.wait_for_timeout(500)
                page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=10000)
                narrow = page_overflow(page)
                if narrow["surfaceRight"] > narrow["viewport"] + 0.5:
                    raise AssertionError(f"좁힌 뒤 창이 넘칩니다: {narrow}")
                page.screenshot(path=str(out / "pdf-resized-390.png"))
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(400)
                page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=10000)
                close_modal(page)
                return f"넓힘↔좁힘 유지 {narrow}"

            check.run("resize-keeps-pdf", "창 크기를 바꿔도 PDF 보기와 창 폭이 유지된다(ui-design §0-18)", resize_case)
            safe_close(page)

        same_origin = [url for url in requests if not url.startswith((base_url, "data:", "blob:", "about:"))]
        check.record(f"same-origin-{label}", "검수 페이지가 다른 출처를 부르지 않는다",
                     "pass" if not same_origin else "fail", json.dumps(same_origin[:5], ensure_ascii=False))
        check.record(f"no-page-errors-{label}", "페이지 예외 없이 장면이 끝난다",
                     "pass" if not page_errors else "fail", json.dumps(page_errors[:3], ensure_ascii=False))
    finally:
        context.close()


def run_min_width(browser, base_url: str, out: Path, check: Check) -> None:
    label, width, height = MIN_WIDTH
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    try:
        page.goto(f"{base_url}/?section=attachments&theme=light", wait_until="load", timeout=60000)
        page.wait_for_selector(READY_SEL, timeout=60000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(out / f"list-{label}.png"))

        def narrow_case():
            open_row(page, 0)
            page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
            box = page_overflow(page)
            iframe_width = box_of(page.locator('[data-testid="attachment-preview-pdf"] iframe'))[2]
            page.screenshot(path=str(out / f"pdf-{label}.png"))
            close_modal(page)
            if box["docScrollWidth"] > box["viewport"] + 0.5:
                raise AssertionError(f"최소 폭에서 가로 스크롤이 생깁니다: {box}")
            if iframe_width < width - 120:
                raise AssertionError(f"최소 폭에서 PDF 영역이 줄었습니다: {iframe_width}")
            return f"{box} iframe={iframe_width}"

        check.run("no-overflow-360", "최소 360px 폭에서 가로 넘침이 없다(ui-design §0-16)", narrow_case)
    finally:
        context.close()


def run_dark(browser, base_url: str, out: Path, check: Check) -> None:
    context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    page = context.new_page()
    try:
        page.goto(f"{base_url}/?section=attachments&theme=dark", wait_until="load", timeout=60000)
        page.wait_for_selector(READY_SEL, timeout=60000)
        page.wait_for_timeout(400)

        def dark_pdf():
            open_row(page, 0)
            page.wait_for_selector('[data-testid="attachment-preview-pdf"] iframe', timeout=20000)
            frames = page.frame_locator('[data-testid="attachment-preview-pdf"] iframe')
            frames.locator("#pdf-facsimile").wait_for(timeout=15000)
            page.screenshot(path=str(out / "pdf-dark-390.png"))
            close_modal(page)
            return "어두운 테마에서도 PDF가 열린다"

        check.run("pdf-dark-390", "화면 모양 변경을 어두운 테마에서도 확인한다(ui-design §15)", dark_pdf)

        def dark_svg():
            page.locator('[data-testid="message-attachments-images-image-1"]').click()
            page.wait_for_timeout(400)
            path = out / "svg-dark-390.png"
            page.screenshot(path=str(path))
            svg_light_backing(page, path, "dark-390", check)
            close_modal(page)
            return "어두운 테마에서도 SVG 바탕이 밝다"

        check.run("svg-dark-390", "SVG의 밝은 바탕이 어두운 테마에서도 유지된다", dark_svg)
    finally:
        context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="캡처와 checks.json을 남길 폴더")
    parser.add_argument("--skip-export", action="store_true",
                        help="이미 있는 <out>/export 웹 번들을 다시 내보내지 않는다")
    args = parser.parse_args()

    out = Path(args.out).expanduser()
    if not out.is_absolute():
        out = Path.cwd() / out
    out.mkdir(parents=True, exist_ok=True)
    export_dir = out / "export"

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        print(f"Playwright를 불러오지 못했습니다: {error}", file=sys.stderr)
        return 2

    try:
        if args.skip_export:
            if not (export_dir / "index.html").is_file():
                print(f"--skip-export인데 번들이 없습니다: {export_dir}", file=sys.stderr)
                return 2
        else:
            export_bundle(export_dir)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"웹 번들을 만들지 못했습니다: {error}", file=sys.stderr)
        return 2

    server = serve(export_dir)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    check = Check()
    print(f"검수 서버: {base_url} (번들 {export_dir})")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for label, width, height in WIDTHS:
                    try:
                        run_viewport(browser, base_url, out, check, label, width, height)
                    except Exception as error:  # noqa: BLE001 - 장면 묶음 실패도 보고에 남긴다
                        check.record(f"viewport-{label}", "장면 묶음 실행", "fail", str(error)[:400])
                for name, run in (("min-width", lambda: run_min_width(browser, base_url, out, check)),
                                  ("dark", lambda: run_dark(browser, base_url, out, check))):
                    try:
                        run()
                    except Exception as error:  # noqa: BLE001
                        check.record(f"viewport-{name}", "장면 묶음 실행", "fail", str(error)[:400])
            finally:
                browser.close()
    finally:
        server.shutdown()

    report = {
        "out": str(out),
        "bundle": str(export_dir),
        "checks": check.items,
        "failed": len(check.failures()),
    }
    (out / "checks.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n검사 {len(check.items)}개, 실패 {len(check.failures())}개 → {out / 'checks.json'}")
    return 0 if not check.failures() else 1


if __name__ == "__main__":
    sys.exit(main())

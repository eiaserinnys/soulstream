"""카드 #429 앱 시안 보완판 확인(RN 웹): A1~A5와 SVG 장면.

python3 -P soul-app/src/mockups/app-file-viewer-429/visual_check.py <dist 폴더 또는 base url> <out_dir>
dist 폴더를 주면 /d/mockup-app-file-viewer-429-wfl0/ 아래로 띄운다.
"""
import functools
import http.server
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

SRC, OUT = sys.argv[1], Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
SLUG = "mockup-app-file-viewer-429-wfl0"
server = None
if not SRC.startswith("http"):
    root = tempfile.mkdtemp(prefix="app429-")
    os.makedirs(f"{root}/d", exist_ok=True)
    os.symlink(os.path.abspath(SRC), f"{root}/d/{SLUG}")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{server.server_address[1]}/d/{SLUG}/"
else:
    BASE = SRC.rstrip("/") + "/"

R = {}
HIDE = "() => { const h = document.getElementById('pages-review'); if (h) h.style.display = 'none'; }"
METRICS = """
() => { const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const q = s => document.querySelector(s);
  const labels = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
  return { docW: document.documentElement.scrollWidth, vw: innerWidth,
    surface: r(q('[data-testid=chat-image-viewer-surface]')), frame: r(q('[data-testid=chat-image-viewer-frame]')),
    footer: r(q('[data-testid=attachment-viewer-footer]')),
    close: r(q('[data-testid=chat-image-viewer-close]')),
    pdf: r(q('[data-testid=attachment-preview-pdf]')), firstPage: r(q('[data-testid=attachment-preview-pdf] img')),
    text: r(q('[data-testid=attachment-preview-text]')),
    textFont: (() => { const e = q('[data-testid=attachment-preview-text] div[dir], [data-testid=attachment-preview-text] [class*=css-text]'); return e ? getComputedStyle(e).fontFamily : null; })(),
    svg: r(q('[data-testid=chat-image-viewer-frame] svg')), svgBox: r(q('[data-testid=chat-image-viewer-frame] svg') && q('[data-testid=chat-image-viewer-frame] svg').parentElement),
    spinner: r(q('[data-testid=chat-image-viewer-frame] [role=progressbar]')),
    iframe: r(q('iframe')),
    labels: labels.filter(l => /닫기|저장|이전|다음|시도|파일$|열기$|크게 보기/.test(l)).slice(0, 20),
    texts: [...document.querySelectorAll('[data-testid=chat-image-viewer-surface] div[dir=auto]')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 6),
  }; }
"""


def open_page(browser, width, height, theme, scene, extra=""):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = ctx.new_page()
    page.set_default_timeout(8000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}?scene={scene}&theme={theme}{extra}", wait_until="networkidle")
    page.wait_for_timeout(1600)
    page.evaluate(HIDE)
    return ctx, page, errors


with sync_playwright() as p:
    browser = p.chromium.launch()
    plan = []
    for scene in ["list", "pdf", "text", "markdown", "html", "unsupported", "failed", "empty", "svg", "bundle"]:
        for width, height in [(390, 844), (820, 1180), (1440, 900)]:
            for theme in ["light", "dark"]:
                plan.append((scene, width, height, theme, ""))
    plan += [("loading", 390, 844, "light", "&hold=1"), ("loading", 820, 1180, "dark", "&hold=1"),
             ("pdf", 390, 844, "light", "&hold=1"), ("pdf", 360, 740, "light", ""), ("text", 360, 740, "light", ""),
             ("list", 360, 740, "light", "")]
    for scene, width, height, theme, extra in plan:
        ctx, page, errors = open_page(browser, width, height, theme, scene, extra)
        tag = extra.replace("&", "-").replace("=", "")
        name = f"app-{scene}-{width}-{theme}{tag}"
        page.screenshot(path=str(OUT / f"{name}.png"))
        m = page.evaluate(METRICS)
        m["errors"] = errors[:3]
        R[name] = m
        ctx.close()

    # 흐름: 목록 → PDF → 닫기 → zip → 닫기 → 실패 → 다시 시도
    ctx, page, errors = open_page(browser, 390, 844, "light", "list")
    flow = {}
    page.get_by_label("첨부 보기 정비 계획서 (2026년 11월 디렉터 검토용 최종본).pdf 열기").click()
    page.wait_for_timeout(1600)
    flow["pdf_open"] = page.evaluate(METRICS)["pdf"] is not None
    page.get_by_test_id("chat-image-viewer-close").click()
    page.wait_for_timeout(600)
    flow["after_close_surface"] = page.evaluate(METRICS)["surface"]
    page.get_by_label("captures-2611.zip 열기").click()
    page.wait_for_timeout(1000)
    mz = page.evaluate(METRICS)
    flow["zip"] = {"surface": mz["surface"], "labels": mz["labels"], "texts": mz["texts"]}
    page.screenshot(path=str(OUT / "flow-zip-390.png"))
    page.get_by_test_id("chat-image-viewer-close").click()
    page.wait_for_timeout(500)
    page.get_by_label("flow-lines.svg 크게 보기").click()
    page.wait_for_timeout(1000)
    flow["svg_open"] = page.evaluate(METRICS)["svg"]
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    flow["svg_after_esc"] = page.evaluate(METRICS)["surface"]
    ctx.close()

    ctx, page, errors = open_page(browser, 390, 844, "light", "failed")
    mf = page.evaluate(METRICS)
    flow["failed_texts"] = mf["texts"]
    page.get_by_text("다시 시도").click()
    page.wait_for_timeout(800)
    flow["after_retry_text"] = page.evaluate(METRICS)["text"] is not None
    page.screenshot(path=str(OUT / "flow-failed-retry-390.png"))
    ctx.close()

    ctx, page, errors = open_page(browser, 820, 1180, "light", "bundle")
    mb = page.evaluate(METRICS)
    flow["bundle"] = {"labels": mb["labels"], "texts": mb["texts"]}
    page.get_by_label("이전 첨부").first.click() if page.get_by_label("이전 첨부").count() else None
    page.wait_for_timeout(900)
    flow["bundle_prev"] = page.evaluate(METRICS)["svg"]
    page.screenshot(path=str(OUT / "flow-bundle-prev-820.png"))
    ctx.close()
    R["flow"] = flow
    browser.close()
if server:
    server.shutdown()
(OUT / "app-fix-results.json").write_text(json.dumps(R, ensure_ascii=False, indent=1))
print("done")

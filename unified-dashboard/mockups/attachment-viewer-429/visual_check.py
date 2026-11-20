"""카드 #429 웹 시안 보완판 확인: 반려 W1~W10의 조작 시나리오와 장면 캡처.

python3 -P unified-dashboard/mockups/attachment-viewer-429/visual_check.py <dist 폴더 또는 base url> <out_dir> [phase,phase]
phase: shots, w1w2, w3w4, w5w6, w7, w8, w9w10, compare, resize, review
"""
import functools
import http.server
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

SRC, OUT = sys.argv[1], Path(sys.argv[2])
PHASES = sys.argv[3].split(",") if len(sys.argv) > 3 else ["shots", "w1w2", "w3w4", "w5w6", "w7", "w8", "w9w10", "compare", "resize"]
OUT.mkdir(parents=True, exist_ok=True)
SIZES = {360: (360, 740), 390: (390, 844), 820: (820, 1180), 1440: (1440, 900)}
R = {}

server = None
if not SRC.startswith("http"):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SRC)
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{server.server_address[1]}/frame.html"
else:
    BASE = SRC.rstrip("/") + "/frame.html"

HIDE_COMMENT = "() => { const h = document.getElementById('pages-review'); if (h) h.style.display = 'none'; }"
METRICS = """
() => {
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect();
    return {x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height)}; };
  const pops = [...document.querySelectorAll('[data-slot="dialog-popup"]')];
  const popup = pops[0];
  const vp = popup ? popup.querySelector('.attachment-viewer-429-scroll [data-slot="scroll-area-viewport"]') : null;
  const img = popup ? popup.querySelector('img.chat-image-viewer-image') : null;
  const btns = popup ? [...popup.querySelectorAll('button')].map(b => ({label: b.getAttribute('aria-label') || b.textContent.trim(), title: b.getAttribute('title'), rect: r(b)})) : [];
  return {
    viewport: [innerWidth, innerHeight], docScrollWidth: document.documentElement.scrollWidth,
    popups: pops.map(r), popup: r(popup),
    attrs: popup ? Object.fromEntries([...popup.attributes].filter(a => a.name.startsWith('data-image') || a.name === 'data-cap' || a.name === 'data-attachment-kind').map(a => [a.name, a.value])) : null,
    title: r(popup && popup.querySelector('[data-slot="attachment-name"]')),
    footer: r(popup && popup.querySelector('[data-slot="dialog-footer"]')),
    iframe: r(popup && popup.querySelector('iframe')),
    img: r(img), imgNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
    vp: r(vp), vpTabIndex: vp ? vp.getAttribute('tabindex') : null, vpRole: vp ? vp.getAttribute('role') : null,
    vpLabel: vp ? vp.getAttribute('aria-label') : null,
    scroll: vp ? {top: vp.scrollTop, left: vp.scrollLeft, sh: vp.scrollHeight, ch: vp.clientHeight, sw: vp.scrollWidth, cw: vp.clientWidth} : null,
    status: popup ? [...popup.querySelectorAll('[role=status]')].filter(e => e.getClientRects().length).map(e => ({text: e.textContent.trim(), rect: r(e)})) : [],
    buttons: btns,
    popovers: document.querySelectorAll('[data-slot="popover-popup"]').length,
    unmocked: window.__mockupUnmocked || [],
  };
}
"""
ACTIVE = """() => { const a = document.activeElement; if (!a) return null;
  return a.getAttribute('aria-label') || a.getAttribute('data-slot') || a.tagName; }"""


def page_for(browser, width, theme="light", scale=1):
    w, h = SIZES[width]
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=scale, color_scheme=theme)
    page = ctx.new_page()
    page.set_default_timeout(8000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    return ctx, page, errors


def go(page, scene, theme="light", extra=""):
    page.goto(f"{BASE}?scene={scene}&theme={theme}&glass=css{extra}", wait_until="networkidle")
    page.wait_for_timeout(900)
    page.evaluate(HIDE_COMMENT)


def shots(browser):
    plan = []
    for scene in ["tall", "tall-whole", "wide", "svg", "svg-clear", "heic", "html", "failed"]:
        for width in [390, 820, 1440]:
            for theme in ["light", "dark"]:
                plan.append((scene, width, theme, ""))
    plan += [("tall", 360, "light", ""), ("wide", 360, "light", ""), ("html", 360, "light", ""),
             ("tall", 1440, "light", "&cap=448"), ("tall", 390, "dark", "&cap=448"),
             ("loading", 1440, "light", "&hold=1"), ("loading", 390, "light", "&hold=1"), ("loading", 1440, "dark", "&hold=1")]
    for scene, width, theme, extra in plan:
        ctx, page, errors = page_for(browser, width, theme)
        go(page, scene, theme, extra)
        if scene == "heic":
            page.wait_for_timeout(1500)
        if scene == "loading":
            page.wait_for_timeout(300)
        tag = extra.replace("&", "-").replace("=", "")
        name = f"{scene}-{width}-{theme}{tag}"
        page.screenshot(path=str(OUT / f"{name}.png"))
        m = page.evaluate(METRICS)
        m["errors"] = errors[:3]
        R[name] = m
        ctx.close()


def w1w2(browser):
    out = {}
    for width in [1440, 390]:
        ctx, page, _ = page_for(browser, width)
        go(page, "tall")
        before = page.evaluate(METRICS)
        btn = [b for b in before["buttons"] if b["label"] == "전체 보기"][0]["rect"]
        cx, cy = btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2
        # 마우스 두 번 누름(더블클릭)과 터치 두 번
        page.mouse.dblclick(cx, cy)
        page.wait_for_timeout(500)
        after2 = page.evaluate(METRICS)
        page.mouse.click(cx, cy)
        page.wait_for_timeout(400)
        after3 = page.evaluate(METRICS)
        out[f"toggle-{width}"] = {
            "before_popup": before["popup"], "before_btn": btn,
            "after_dbl_popup": after2["popup"], "after_dbl_fit": after2["attrs"],
            "after_dbl_btn": [b for b in after2["buttons"] if b["label"] in ("전체 보기", "폭에 맞춤")],
            "after_third_fit": after3["attrs"], "alive": bool(after3["popup"]),
            "element_at_btn": page.evaluate(f"() => {{ const e = document.elementFromPoint({cx},{cy}); const b = e && e.closest('button'); return b ? b.getAttribute('aria-label') : (e ? e.tagName : null); }}"),
        }
        page.screenshot(path=str(OUT / f"w1-after-toggles-{width}.png"))
        ctx.close()
    # W2: 스크롤 비율 보존
    ctx, page, _ = page_for(browser, 1440)
    go(page, "tall")
    vp = page.locator('.attachment-viewer-429-scroll [data-slot="scroll-area-viewport"]')
    vp.hover()
    page.mouse.wheel(0, 2000)
    page.wait_for_timeout(600)
    m0 = page.evaluate(METRICS)
    r0 = m0["scroll"]["top"] / (m0["scroll"]["sh"] - m0["scroll"]["ch"])
    page.get_by_role("button", name="전체 보기").click()
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "w2-whole-1440.png"))
    mw = page.evaluate(METRICS)
    page.get_by_role("button", name="폭에 맞춤").click()
    page.wait_for_timeout(500)
    m1 = page.evaluate(METRICS)
    r1 = m1["scroll"]["top"] / (m1["scroll"]["sh"] - m1["scroll"]["ch"])
    out["roundtrip"] = {"before_top": m0["scroll"]["top"], "after_top": m1["scroll"]["top"], "ratio_before": round(r0, 4), "ratio_after": round(r1, 4),
                        "whole_img": mw["img"], "whole_popup": mw["popup"], "read_popup": m1["popup"]}
    ctx.close()
    R["w1w2"] = out


def w3w4(browser):
    out = {}
    ctx, page, _ = page_for(browser, 1440)
    # 장면 단추를 키보드로 눌러 연다
    go(page, "tall")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    page.get_by_role("button", name="긴 캡처", exact=True).focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(1200)
    m = page.evaluate(METRICS)
    out["initial_active"] = page.evaluate(ACTIVE)
    out["vp"] = {"tabindex": m["vpTabIndex"], "role": m["vpRole"], "label": m["vpLabel"]}
    page.screenshot(path=str(OUT / "w3-initial-focus-1440.png"))
    top0 = m["scroll"]["top"]
    keys = {}
    for key in ["PageDown", "ArrowDown", "Space", "End", "Home"]:
        page.keyboard.press(key)
        page.wait_for_timeout(350)
        keys[key] = page.evaluate(METRICS)["scroll"]["top"]
    out["keys"] = {"start": top0, **keys}
    seq = []
    for _ in range(5):
        page.keyboard.press("Tab")
        page.wait_for_timeout(250)
        seq.append(page.evaluate(ACTIVE))
    out["tab_sequence"] = seq
    # W4: 키보드로 전환 단추를 누르면 초점이 단추에 남고 팝오버가 없다
    page.get_by_role("button", name="전체 보기").focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    out["after_enter_active"] = page.evaluate(ACTIVE)
    out["popovers"] = page.evaluate(METRICS)["popovers"]
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    out["after_enter2_active"] = page.evaluate(ACTIVE)
    out["titles"] = [b["title"] for b in page.evaluate(METRICS)["buttons"]]
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    out["after_esc_active"] = page.evaluate(ACTIVE)
    out["after_esc_open"] = bool(page.evaluate(METRICS)["popup"])
    ctx.close()
    R["w3w4"] = out


def w5w6(browser):
    out = {}
    for width in [1440, 390]:
        ctx, page, _ = page_for(browser, width)
        page.goto(f"{BASE}?scene=loading&theme=light&glass=css", wait_until="networkidle")
        page.evaluate(HIDE_COMMENT)
        page.wait_for_timeout(500)
        m0 = page.evaluate(METRICS)
        page.screenshot(path=str(OUT / f"w5-loading-{width}.png"))
        page.wait_for_timeout(2600)
        m1 = page.evaluate(METRICS)
        out[f"loading-{width}"] = {"loading_popup": m0["popup"], "loading_status": m0["status"], "loading_buttons": [b["label"] for b in m0["buttons"]],
                                   "loaded_popup": m1["popup"], "loaded_attrs": m1["attrs"], "loaded_buttons": [b["label"] for b in m1["buttons"]]}
        go(page, "failed")
        m2 = page.evaluate(METRICS)
        page.screenshot(path=str(OUT / f"w6-failed-{width}.png"))
        page.get_by_role("button", name="다시 시도").click()
        page.wait_for_timeout(1200)
        m3 = page.evaluate(METRICS)
        out[f"failed-{width}"] = {"popup": m2["popup"], "status": m2["status"], "buttons": [b["label"] for b in m2["buttons"]],
                                  "after_retry_attrs": m3["attrs"], "after_retry_buttons": [b["label"] for b in m3["buttons"]]}
        ctx.close()
    R["w5w6"] = out


def w7(browser):
    out = {}
    for width in [1440, 390]:
        ctx, page, _ = page_for(browser, width)
        go(page, "wide")
        m = page.evaluate(METRICS)
        out[f"wide-{width}"] = {"popup": m["popup"], "img": m["img"], "attrs": m["attrs"], "scroll": m["scroll"],
                                "buttons": [b["label"] for b in m["buttons"]], "active": page.evaluate(ACTIVE)}
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("End")
        page.wait_for_timeout(400)
        out[f"wide-{width}"]["after_keys_left"] = page.evaluate(METRICS)["scroll"]["left"]
        page.get_by_role("button", name="전체 보기").click()
        page.wait_for_timeout(400)
        mw = page.evaluate(METRICS)
        out[f"wide-{width}"]["whole"] = {"popup": mw["popup"], "img": mw["img"], "buttons": [b["label"] for b in mw["buttons"]]}
        page.screenshot(path=str(OUT / f"w7-wide-whole-{width}.png"))
        ctx.close()
    # 보통 사진(HEIC)과 SVG는 전환 단추가 없다
    for scene in ["heic", "svg"]:
        ctx, page, _ = page_for(browser, 1440)
        go(page, scene)
        page.wait_for_timeout(1500)
        m = page.evaluate(METRICS)
        out[f"{scene}-buttons"] = [b["label"] for b in m["buttons"]]
        out[f"{scene}-attrs"] = m["attrs"]
        ctx.close()
    R["w7"] = out


def w8(browser):
    out = {}
    for theme in ["dark", "light"]:
        ctx, page, _ = page_for(browser, 820, theme)
        go(page, "svg-clear", theme)
        m = page.evaluate(METRICS)
        img = m["img"]
        path = OUT / f"w8-svg-clear-820-{theme}.png"
        page.screenshot(path=str(path))
        out[theme] = {"img": img}
        ctx.close()
        try:
            from PIL import Image
            im = Image.open(path).convert("RGB")
            # 그림 안 빈 곳(왼쪽 아래)과 선 근처
            px = im.getpixel((img["x"] + 10, img["y"] + img["h"] - 10))
            out[theme]["empty_pixel"] = px
        except Exception as e:  # noqa: BLE001
            out[theme]["pixel_error"] = str(e)
    R["w8"] = out


def w9w10(browser):
    out = {}
    ctx, page, _ = page_for(browser, 1440)
    go(page, "html")
    m = page.evaluate(METRICS)
    out["buttons"] = [(b["label"], b["rect"]) for b in m["buttons"]]
    out["footer"] = m["footer"]
    frame = page.frame_locator("iframe")
    frame.get_by_role("button", name="완료만 보기").click()
    page.wait_for_timeout(300)
    out["inner_after_click"] = frame.locator("#toggle").inner_text()
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)
    out["closed_by_esc_inside"] = not page.evaluate(METRICS)["popup"]
    out["active_after"] = page.evaluate(ACTIVE)
    page.get_by_role("button", name="HTML", exact=True).focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(900)
    frame = page.frame_locator("iframe")
    frame.get_by_role("button", name="완료만 보기").click()
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)
    out["reopen_closed_by_esc_inside"] = not page.evaluate(METRICS)["popup"]
    out["reopen_active_after"] = page.evaluate("() => document.activeElement && document.activeElement.textContent.trim()")
    ctx.close()
    R["w9w10"] = out


def compare(browser):
    out = {}
    for width, theme in [(1440, "light"), (1440, "dark"), (820, "light")]:
        ctx, page, errors = page_for(browser, width, theme)
        go(page, "compare", theme)
        page.wait_for_timeout(500)
        m = page.evaluate(METRICS)
        page.screenshot(path=str(OUT / f"compare-{width}-{theme}.png"))
        out[f"{width}-{theme}"] = {"popups": m["popups"], "backdrops": page.evaluate("() => [...document.querySelectorAll('[data-slot=dialog-backdrop]')].filter(e => getComputedStyle(e).display !== 'none').length"),
                                   "imgs": page.evaluate("() => [...document.querySelectorAll('img.chat-image-viewer-image')].map(i => Math.round(i.getBoundingClientRect().width))"), "errors": errors[:3]}
        # 왼쪽 창을 휠로 내릴 수 있나
        if width == 1440 and theme == "light":
            p = m["popups"][0]
            page.mouse.move(p["x"] + p["w"] / 2, p["y"] + p["h"] / 2)
            page.mouse.wheel(0, 900)
            page.wait_for_timeout(400)
            out["left_scrolled"] = page.evaluate("() => [...document.querySelectorAll('.attachment-viewer-429-scroll [data-slot=scroll-area-viewport]')].map(v => v.scrollTop)")
        ctx.close()
    R["compare"] = out


def resize(browser):
    out = {}
    ctx, page, _ = page_for(browser, 1440)
    go(page, "tall")
    for _ in range(3):
        page.keyboard.press("PageDown")
        page.wait_for_timeout(200)
    page.wait_for_timeout(300)
    m0 = page.evaluate(METRICS)
    out["1440"] = {"ratio": round(m0["scroll"]["top"] / (m0["scroll"]["sh"] - m0["scroll"]["ch"]), 4), "popup": m0["popup"]}
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(700)
    m1 = page.evaluate(METRICS)
    page.screenshot(path=str(OUT / "resize-to-390.png"))
    out["390"] = {"ratio": round(m1["scroll"]["top"] / (m1["scroll"]["sh"] - m1["scroll"]["ch"]), 4), "popup": m1["popup"], "docScrollWidth": m1["docScrollWidth"]}
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(700)
    m2 = page.evaluate(METRICS)
    out["back1440"] = {"ratio": round(m2["scroll"]["top"] / (m2["scroll"]["sh"] - m2["scroll"]["ch"]), 4), "popup": m2["popup"]}
    ctx.close()
    R["resize"] = out


def review(browser):
    """게시 페이지의 코멘트 단추가 390에서 원본 저장을 덮는가."""
    out = {}
    for width in [390, 1440]:
        ctx, page, _ = page_for(browser, width)
        page.goto(f"{BASE}?scene=tall&theme=light&glass=css", wait_until="networkidle")
        page.wait_for_timeout(1500)
        save = page.get_by_role("button", name="원본 저장").bounding_box()
        toggle = page.evaluate("() => { const h = document.getElementById('pages-review'); const t = h && h.shadowRoot && h.shadowRoot.getElementById('toggle'); if (!t) return null; const b = t.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; }")
        out[str(width)] = {"save": save, "toggle": toggle}
        if save and toggle:
            ox = max(0, min(save["x"] + save["width"], toggle["x"] + toggle["w"]) - max(save["x"], toggle["x"]))
            oy = max(0, min(save["y"] + save["height"], toggle["y"] + toggle["h"]) - max(save["y"], toggle["y"]))
            out[str(width)]["overlap_area"] = round(ox * oy)
        page.screenshot(path=str(OUT / f"review-{width}.png"))
        ctx.close()
    R["review"] = out


FUNCS = {"shots": shots, "w1w2": w1w2, "w3w4": w3w4, "w5w6": w5w6, "w7": w7, "w8": w8, "w9w10": w9w10, "compare": compare, "resize": resize, "review": review}
with sync_playwright() as p:
    # 바쁜 호스트에서 키보드 스크롤 애니메이션이 늦게 끝나 값이 흔들리므로 부드러운 스크롤을 끈다.
    browser = p.chromium.launch(args=["--disable-smooth-scrolling"])
    for phase in PHASES:
        try:
            FUNCS[phase](browser)
        except Exception as e:  # noqa: BLE001
            R[f"error_{phase}"] = str(e)[:600]
        (OUT / f"results-{'-'.join(PHASES)}.json").write_text(json.dumps(R, ensure_ascii=False, indent=1))
    browser.close()
if server:
    server.shutdown()
print(json.dumps({k: v for k, v in R.items() if k != "shots"} if "shots" not in PHASES else {k: R[k] for k in R if k.startswith("error")}, ensure_ascii=False, indent=1)[:12000])

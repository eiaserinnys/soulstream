"""Capture PAS task and file seats at the same viewport sizes."""
from playwright.sync_api import expect

WIDTHS = (1440, 1150, 900, 768, 767, 390, 360)
TASK_WIDTHS = (1440, 1150, 900, 390, 360)


def capture_pas_width(browser, baseline, current, out, install_routes):
    result = {"tasks": {}, "files": {}}

    def open_page(base):
        context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", reduced_motion="reduce", locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block")
        page = context.new_page()
        page.add_init_script("localStorage.setItem('soul-dashboard-theme','dark'); localStorage.setItem('ls.webglGlass','0');")
        install_routes(page, "pas-width")
        page.goto(base + "/persistent/components-session", wait_until="domcontentloaded")
        expect(page.locator('[data-slot="chat-input-composer"]')).to_be_visible(timeout=15000)
        page.evaluate("document.fonts.ready")
        return context, page

    def geometry(page):
        return page.evaluate("""() => {
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          return {main:rect(document.querySelector('.persistent-session-main')),
                  composer:rect(document.querySelector('[data-slot="chat-input-composer"]'))};
        }""")

    for label, base in (("before", baseline), ("after", current)):
        context, page = open_page(base)
        toggle = page.get_by_role("button", name="작업 목록", exact=True)
        expect(toggle).to_be_enabled(timeout=15000)
        toggle.click()
        tasks = page.get_by_role("complementary", name="작업", exact=True)
        expect(tasks.get_by_text("세션 파일 폭 확인", exact=True)).to_be_visible(timeout=15000)
        result["tasks"][label] = {}
        for width in TASK_WIDTHS:
            page.set_viewport_size({"width": width, "height": 900})
            expect(tasks).to_be_visible()
            page.wait_for_timeout(150)
            result["tasks"][label][str(width)] = {**geometry(page), "pane": tasks.evaluate("e => {const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}")}
            page.screenshot(path=str(out / f"pas-tasks-{label}-{width}.png"), animations="disabled")
        if label == "after":
            page.set_viewport_size({"width": 900, "height": 900})
            page.get_by_role("button", name="세션 파일", exact=True).click()
            pane = page.get_by_role("region", name="세션 파일")
            expect(pane.get_by_text("event_outbox_types.ts", exact=True)).to_be_visible()
            pane.get_by_role("button", name="파일 닫기").click()
            expect(tasks.get_by_text("세션 파일 폭 확인", exact=True)).to_be_visible()
            result["tasks"]["restored"] = {**geometry(page), "pane": tasks.evaluate("e => {const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}")}
            page.screenshot(path=str(out / "pas-tasks-restored-900.png"), animations="disabled")
        context.close()

    context, page = open_page(current)
    toggle = page.get_by_role("button", name="세션 파일", exact=True)
    expect(toggle).to_be_visible(timeout=15000)
    draft = page.locator('.persistent-session-main textarea')
    expect(draft).to_be_enabled(timeout=15000)
    draft.fill("PAS 파일 확인 중")
    for width in WIDTHS:
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(150)
        before = geometry(page)
        toggle.click()
        pane = page.get_by_role("region", name="세션 파일")
        expect(pane.locator(".v3-session-files-title strong")).to_have_text("card1789-files-dashboard", timeout=15000)
        expect(pane.get_by_text("event_outbox_types.ts", exact=True)).to_be_visible()
        page.wait_for_timeout(150)
        after = geometry(page)
        details = pane.evaluate("""el => {
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          const text=e=>({text:e.textContent,client:e.clientWidth,scroll:e.scrollWidth,rect:rect(e)});
          const branch=el.querySelector('.v3-session-files-title strong');
          const row=[...el.querySelectorAll('.v3-session-files-row')].find(e=>e.textContent.includes('읽기만 한 파일'));
          const name=[...el.querySelectorAll('.v3-session-files-name')];
          const readLabel=row.querySelector('.v3-session-files-name'), badge=el.querySelector('.v3-session-files-section .v3-session-files-new');
          const count=[...row.querySelectorAll(':scope > span')].at(-1);
          const main=document.querySelector('.persistent-session-main').getBoundingClientRect();
          const hit=document.elementFromPoint((main.left+main.right)/2, Math.max(main.top+80, el.getBoundingClientRect().top+80));
          return {pane:rect(el),radius:getComputedStyle(el).borderRadius,border:getComputedStyle(el).borderTopWidth,
            branch:{...text(branch),title:branch.getAttribute('title')},
            names:Object.fromEntries(name.filter(e=>['event_outbox_types.ts','outbox_retry.ts'].includes(e.textContent)).map(e=>[e.textContent,text(e)])),
            read:{label:text(readLabel),badge:text(badge),count:text(count)},coversChat:!!hit && el.contains(hit)};
        }""")
        result["files"][str(width)] = {"before": before, "after": after, "draft": draft.input_value(), **details}
        page.screenshot(path=str(out / f"pas-width-{width}.png"), animations="disabled")
        if width == 1440:
            page.set_viewport_size({"width": 390, "height": 900})
            expect(pane).to_be_visible(); expect(draft).to_have_value("PAS 파일 확인 중")
            page.set_viewport_size({"width": 1440, "height": 900})
            expect(pane).to_be_visible(); expect(draft).to_have_value("PAS 파일 확인 중")
        pane.get_by_role("button", name="파일 닫기").click()
        expect(pane).to_have_count(0)
        expect(draft).to_have_value("PAS 파일 확인 중")
    context.close()
    return result

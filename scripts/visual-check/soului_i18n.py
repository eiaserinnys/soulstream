#!/usr/bin/env python3
"""Capture and exercise the shared Soul UI components in Korean and English."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import TimeoutError as PlaywrightTimeout, expect, sync_playwright
from settings_i18n import ROOT, start_vite

FIXTURE = r"""
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "@soulstream/i18n";
import { Button } from "@seosoyoung/soul-ui/components/ui/button";
import { ChatInput } from "@seosoyoung/soul-ui/components/ChatInput";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { ToolCallGroup } from "@seosoyoung/soul-ui/components/chat/ToolCallGroup";
import { FolderDialog } from "@seosoyoung/soul-ui/components/FolderDialog";
import { SessionContextMenu } from "@seosoyoung/soul-ui/components/SessionContextMenu";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { ClaudeRuntimeTasksPanel } from "@seosoyoung/soul-ui/components/ClaudeRuntimeTasksPanel";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";

const locale = new URLSearchParams(location.search).get("locale") === "ko" ? "ko" : "en";
const ko = locale === "ko";
document.documentElement.lang = locale;
const i18n = createI18n(locale);
const sessionId = "release-check";
const sessionName = ko
  ? "검색 색인 전환 및 월간 운영 보고서 검수 세션"
  : "Search index migration and monthly operations report review";
useDashboardStore.setState({
  activeSessionKey: sessionId,
  activeSessionSummary: { agentSessionId: sessionId, displayName: sessionName, status: "running", sessionType: "claude" },
});

const user = { id: "request", role: "user", content: ko
  ? "검색 색인 전환 전에 파일과 작업 상태를 확인해 주세요."
  : "Check the files and job status before switching the search index." };
const assistant = { id: "reply", role: "assistant", content: ko
  ? "검색 색인은 최신 상태입니다. 남은 작업은 진행 상황 보고서에 기록했습니다."
  : "The search index is current. I recorded the remaining work in the status report." };
const tools = [
  { id: "read", role: "tool", content: "Read status-report.md", toolName: "Read", toolResult: "3 items", toolDurationMs: 180 },
  { id: "check", role: "tool", content: "Check search index", toolName: "Bash", toolResult: "Index current", toolDurationMs: 810 },
];
const tasks = [
  { taskId: "index-validation", status: "running", taskType: "bash", isBackgrounded: true, summary: "Validate the search index.", updatedAt: 2 },
  { taskId: "report-export", status: "failed", taskType: "agent", isBackgrounded: true, summary: "Export the monthly operations report.", updatedAt: 1 },
];
const files = ["search-index-migration-and-monthly-operations-status-report.txt", "release-checklist.txt"].map((name, i) => ({
  key: String(i), name, mimeType: "text/plain", byteSize: 32, previewKind: "text", availability: "ready",
  previewUrl: "/api/visual/attachment/" + i, originalUrl: "/api/visual/attachment/" + i, legacySources: [],
  source: { kind: "asset", attachmentId: String(i), context: { type: "session", id: sessionId } },
}));

function Fixture() {
  const [contextMenu, setContextMenu] = useState(null);
  const [name, setName] = useState(sessionName);
  const [folder, setFolder] = useState(false);
  const [index, setIndex] = useState(null);
  const viewButton = useRef(null);
  const scene = new URLSearchParams(location.search).get("scene");

  return <main className="mx-auto max-w-3xl min-w-0 px-3 py-4">
    {scene === "chat" && <section className="flex min-w-0 flex-col gap-4" data-visual-surface="chat">
      <UserMessage msg={user} />
      <ToolCallGroup messages={tools} presentation="manuscript" />
      <AssistantMessage msg={assistant} />
      <ChatInput fileUploadUrl="/api/attachments/sessions" />
    </section>}
    {scene === "menu" && <>
      <Button className="max-w-full" data-testid="session-control" onClick={e => {
        const { left, bottom } = e.currentTarget.getBoundingClientRect();
        setContextMenu({ x: left, y: bottom, sessionId });
      }}><span className="truncate">{name}</span></Button>
      <SessionContextMenu contextMenu={contextMenu} onClose={() => setContextMenu(null)}
        getSessionName={() => name} resolveSessionIds={id => [id]}
        onRenameSession={async (_id, name) => setName(name || sessionName)}
        onContinueSession={async () => {}} onDeleteSessions={async () => {}}
        onRequestMoveSession={() => {}} />
    </>}
    {scene === "folder" && <>
      <Button data-testid="folder-control" onClick={() => setFolder(true)}>{ko ? "폴더 추가" : "Add folder"}</Button>
      <FolderDialog mode="create" open={folder} onOpenChange={setFolder} onConfirm={async () => {
        const response = await fetch("/api/visual/folder", { method: "POST" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        setFolder(false);
      }} />
    </>}
    {scene === "attachment" && <>
      <Button ref={viewButton} data-testid="attachment-control" onClick={() => setIndex(0)}>
        {ko ? "상태 보고서" : "Status report"}
      </Button>
      <AttachmentViewer items={files} index={index} onIndexChange={setIndex}
        onClose={() => setIndex(null)} returnFocus={viewButton.current} />
    </>}
    {scene === "runtime" && <section data-visual-surface="runtime">
      <ClaudeRuntimeTasksPanel sessionId={sessionId} variant="caption"
        runtime={{ tasks: Object.fromEntries(tasks.map(task => [task.taskId, task])), planMode: { active: true } }} />
    </section>}
  </main>;
}

createRoot(document.getElementById("root")).render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>);
"""

LABELS = {
    "ko": {
        "tool": "도구 2회", "chat": "메시지를 입력하세요", "menu": "세션 ID 복사", "rename_item": "이름 변경",
        "rename": "세션 이름 변경", "folder": "새 폴더", "save": "원본 저장", "retry": "다시 시도",
        "tasks": "백그라운드 작업", "output": "출력 보기", "restored": "변경한 세션 이름",
        "folder_error": "폴더를 만들지 못했습니다. 이름과 연결 상태를 확인한 뒤 다시 시도하세요.",
        "attachment_loading": "미리보기를 불러오는 중…",
    },
    "en": {
        "tool": "Tools: 2", "chat": "Type a message", "menu": "Copy session ID", "rename_item": "Rename",
        "rename": "Rename session", "folder": "New folder", "save": "Save original", "retry": "Retry",
        "tasks": "Background tasks", "output": "View output", "restored": "Updated session name",
        "folder_error": "Couldn’t create the folder. Check the name and connection, then retry.",
        "attachment_loading": "Loading preview…",
    },
}

FOCUS = """() => {
  const e = document.activeElement;
  if (!e || e === document.body) return 'BODY';
  const role = e.getAttribute('role');
  return e.dataset.testid || e.getAttribute('placeholder') || e.getAttribute('aria-label')
    || e.title || (role === 'menu' || role === 'dialog' ? role : e.textContent?.trim().slice(0, 60)) || e.tagName;
}"""
GEOMETRY = """surface => {
  const viewport = innerWidth;
  const frame = surface.getBoundingClientRect();
  const clipped = [];
  const visuallyHidden = element => {
    const css = getComputedStyle(element);
    return css.position === 'absolute' && css.clip !== 'auto';
  };
  for (const e of surface.querySelectorAll('button,input,textarea,[role=menuitem],h2,h3,span')) {
    const r = e.getBoundingClientRect(), css = getComputedStyle(e);
    if (!r.height || !r.width || visuallyHidden(e) || css.visibility === 'hidden') continue;
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    const visibleText = [];
    while (walker.nextNode()) {
      if (!visuallyHidden(walker.currentNode.parentElement)) visibleText.push(walker.currentNode.data);
    }
    const text = e.getAttribute('placeholder') || visibleText.join('').trim();
    if (text && (r.x < -1 || r.right > viewport + 1 ||
        (e.scrollWidth > e.clientWidth + 1 && css.textOverflow !== 'ellipsis' && css.overflowX === 'hidden'))) {
      clipped.push(text.slice(0, 72));
    }
  }
  return { viewport, documentWidth: document.documentElement.scrollWidth,
    x: Math.round(frame.x), right: Math.round(frame.right), top: Math.round(frame.top), clipped };
}"""

DIALOG = '[data-slot="dialog-popup"]'


def save(page, out, name, frame, geometry):
    expect(frame).to_be_visible()
    page.evaluate("() => document.fonts.ready.then(() => true)")
    geometry.append((name, frame.evaluate(GEOMETRY)))
    page.screenshot(path=str(out / f"{name}.png"), animations="disabled")


def routes(page):
    calls = {"attachment": 0, "folder": 0}
    pending = []

    def handle(route):
        url = route.request.url
        if "/visual/attachment/" in url:
            calls["attachment"] += 1
            if calls["attachment"] == 1:
                pending.append(route)
                return
            body = b"Search index validated at 09:00."
            return route.fulfill(status=206, body=body, headers={
                "Content-Range": f"bytes 0-{len(body)-1}/{len(body)}", "Content-Length": str(len(body)),
            })
        if url.endswith("/visual/folder"):
            calls["folder"] += 1
            return route.fulfill(status=503 if calls["folder"] == 1 else 200, json={})
        if url.endswith("/resume-after-limit"):
            return route.fulfill(json={"eligible": True, "resets_at": "2026-11-30T09:00:00Z", "schedule": None})
        if url.endswith("/background-tasks"):
            return route.fulfill(json={"tasks": []})
        if url.endswith("/output"):
            return route.fulfill(json={"output": "Search index validated."})
        return route.fulfill(status=404, json={})

    page.route("**/api/**", handle)
    return pending


def capture(browser, url, locale, width, out, geometry, operations, probes):
    labels = LABELS[locale]
    context = browser.new_context(
        viewport={"width": width, "height": 900 if width == 1440 else 800},
        locale=locale, timezone_id="Asia/Seoul", reduced_motion="reduce", service_workers="block",
    )
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"Browser error: {error}", file=sys.stderr))
    pending = routes(page)

    def go(scene):
        page.goto(f"{url}?scene={scene}&locale={locale}", wait_until="domcontentloaded")

    def shot(scene, frame):
        save(page, out, f"{locale}-{width}-{scene}", frame, geometry)

    def focus():
        return page.evaluate(f"() => new Promise(resolve => requestAnimationFrame(() => resolve(({FOCUS})())))")

    def dialog():
        return page.locator(DIALOG).last

    def tab_in_dialog(scene):
        order = []
        for key in ("Tab", "Shift+Tab"):
            page.keyboard.press(key)
            active = focus()
            inside = dialog().evaluate("frame => frame.contains(document.activeElement)")
            order.append(f"{key} → {active}")
            probes["tab"].append((f"{locale} {width} {scene} {key}", inside))
        return ", ".join(order)

    try:
        go("chat")
        editor = page.get_by_placeholder(labels["chat"], exact=True)
        expect(editor).to_be_visible()
        page.get_by_text(labels["tool"], exact=True).click()
        expect(page.locator('[data-slot="manuscript-activity-items"]').get_by_text("Read", exact=True)).to_be_visible()
        chat = page.locator('[data-visual-surface="chat"]')
        shot("chat", chat)
        if locale == "en" and width == 1440:
            editor.fill("Check the remaining changes before shipping.")
            editor.focus()
            page.set_viewport_size({"width": 360, "height": 800})
            expect(editor).to_have_value("Check the remaining changes before shipping.")
            expect(editor).to_be_focused()
            shot("chat-resized", chat)
            page.set_viewport_size({"width": width, "height": 900})

        go("menu")
        trigger = page.get_by_test_id("session-control")
        trigger.click()
        rename = page.get_by_role("button" if width == 360 else "menuitem", name=labels["rename_item"], exact=True)
        expect(rename).to_be_visible()
        frame = dialog() if width == 360 else page.get_by_role("menu")
        shot("session-menu", frame)
        if locale == "en" and width == 1440:
            page.set_viewport_size({"width": 360, "height": 800})
            mobile_item = page.get_by_role("button", name=labels["rename_item"], exact=True)
            try:
                mobile_item.wait_for(state="visible", timeout=2000)
                probes["menu_resize"] = True
                shot("menu-resized", dialog())
            except PlaywrightTimeout:
                probes["menu_resize"] = False
            page.set_viewport_size({"width": width, "height": 900})
            try:
                frame.wait_for(state="visible", timeout=2000)
            except PlaywrightTimeout:
                trigger.click()
                expect(frame).to_be_visible()
        first = focus()
        page.keyboard.press("Escape")
        expect(frame).to_be_hidden()
        returned = focus()
        probes["focus"].append((f"{locale} {width} 세션 메뉴", first not in ("", "BODY"), returned == "session-control"))

        trigger.click()
        expect(rename).to_be_visible()
        page.keyboard.press("Tab")
        tab = focus()
        operations.append((f"{locale} {width} 세션 메뉴", "세션 이름 클릭", first, "이름 변경 항목은 아래에서 확인", f"닫힘 (별도 열기에서 Tab → {tab})", returned))
        if not rename.is_visible():
            trigger.click()
            expect(rename).to_be_visible()
        rename.focus()
        page.keyboard.press("Enter")
        expect(dialog().get_by_text(labels["rename"], exact=True)).to_be_visible()
        editor = dialog().get_by_role("textbox")
        first = focus()
        initial_ok = first == editor.get_attribute("placeholder")
        shot("rename-dialog", dialog())
        tab = tab_in_dialog("이름 변경")
        page.keyboard.press("Escape")
        expect(dialog()).to_be_hidden()
        return_after_esc = focus()
        probes["focus"].append((f"{locale} {width} 이름 변경", initial_ok, return_after_esc == "session-control"))
        trigger.click()
        page.get_by_text(labels["rename_item"], exact=True).click()
        editor.fill(labels["restored"])
        editor.press("Enter")
        expect(trigger).to_have_text(labels["restored"])
        operations.append((f"{locale} {width} 이름 변경", "세션 메뉴에서 이름 변경", first, "입력 제출 후 세션 이름 갱신", f"닫힘 ({tab})", return_after_esc))

        go("folder")
        trigger = page.get_by_test_id("folder-control")
        trigger.click()
        expect(dialog().get_by_text(labels["folder"], exact=True)).to_be_visible()
        editor = dialog().get_by_role("textbox")
        first = focus()
        initial_ok = first == editor.get_attribute("placeholder")
        shot("folder-dialog", dialog())
        tab = tab_in_dialog("폴더 생성")
        page.keyboard.press("Escape")
        expect(dialog()).to_be_hidden()
        returned = focus()
        probes["focus"].append((f"{locale} {width} 폴더 생성", initial_ok, returned == "folder-control"))
        trigger.click()
        editor.fill("Release verification")
        editor.press("Enter")
        expect(dialog().get_by_text(labels["folder_error"], exact=True)).to_be_visible()
        if locale == "en" and width == 1440:
            shot("folder-error", dialog())
        editor.press("Enter")
        expect(dialog()).to_be_hidden()
        operations.append((f"{locale} {width} 폴더 생성", "폴더 추가 클릭", first, "503 표시 후 Enter로 재시도하여 닫힘", f"닫힘 ({tab})", returned))

        go("attachment")
        trigger = page.get_by_test_id("attachment-control")
        trigger.click()
        expect(dialog().get_by_text(labels["attachment_loading"], exact=True)).to_be_visible()
        first = focus()
        initial_ok = dialog().evaluate("frame => frame.contains(document.activeElement)")
        if locale == "en" and width == 1440:
            shot("attachment-loading", dialog())
        pending.pop().fulfill(status=503, body="Preview unavailable")
        retry = dialog().get_by_role("button", name=labels["retry"], exact=True)
        expect(retry).to_be_visible()
        if locale == "en" and width == 1440:
            shot("attachment-error", dialog())
        retry.focus()
        page.keyboard.press("Enter")
        expect(dialog().get_by_text("Search index validated at 09:00.")).to_be_visible()
        expect(dialog().get_by_role("button", name=labels["save"], exact=True)).to_be_visible()
        shot("attachment", dialog())
        tab = tab_in_dialog("첨부 보기")
        page.keyboard.press("Escape")
        expect(dialog()).to_be_hidden()
        returned = focus()
        probes["focus"].append((f"{locale} {width} 첨부 보기", initial_ok, returned == "attachment-control"))
        operations.append((f"{locale} {width} 첨부 보기", "상태 보고서 클릭", first, "재시도에 초점을 두고 Enter로 미리보기 복구", f"닫힘 ({tab})", returned))

        go("runtime")
        toggle = page.locator('[data-slot="manuscript-tasks-toggle"]')
        expect(toggle).to_contain_text(labels["tasks"])
        toggle.click()
        expect(page.get_by_text("index-validation", exact=True)).to_be_visible()
        page.get_by_title(labels["output"], exact=True).first.click()
        expect(page.get_by_text("Search index validated.", exact=True)).to_be_visible()
        shot("runtime", page.locator('[data-visual-surface="runtime"]'))
    finally:
        context.close()


def write_report(out, geometry, operations, probes):
    narrow = [(name, info) for name, info in geometry if info["viewport"] == 360]
    overflow = [name for name, info in narrow if info["documentWidth"] > 360 or info["x"] < -1 or info["right"] > 361]
    clipped = [f"{name} {', '.join(info['clipped'])}" for name, info in narrow if info["clipped"]]
    focus_issues = [f"{name} ({'첫 초점' if not first else '복귀'})" for name, first, returned in probes["focus"] if not first or not returned]
    tab_issues = [name for name, inside in probes["tab"] if not inside]
    content = [
        "# 조작 결과", "", "## 14번부터 18번", "",
        "| 항목 | 결과 | 근거 |", "| :--- | :--- | :--- |",
        f"| 14 | {'확인 필요' if focus_issues else '통과'} | 연 직후와 Esc 뒤 활성 요소를 아래 표에 기록. {' / '.join(focus_issues) or '모든 장면에서 초점 확인'} |",
        f"| 15 | {'확인 필요' if tab_issues else '통과'} | 열린 대화상자의 Tab·Shift+Tab과 Esc 확인. 초점 이탈 {' / '.join(tab_issues) or '없음'} |",
        f"| 16 | {'확인 필요' if overflow or clipped else '통과'} | 360px에서 측정. 가로 넘침 {', '.join(overflow) or '없음'}. 잘림 후보 {' / '.join(clipped) or '없음'} |",
        "| 17 | 통과 | 폴더 생성과 첨부 미리보기의 503 응답을 화면에서 확인하고 재시도해 복구 |",
        f"| 18 | {'통과' if probes.get('menu_resize') else '확인 필요'} | 1440→360에서 채팅 글과 초점 유지. 메뉴는 {'하단 시트로 전환' if probes.get('menu_resize') else '폭 변경 시 닫힘'} |",
        "", "## 대화상자와 줄 안 편집", "",
        "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
        *("| " + " | ".join(part.replace("|", "¦").replace("\n", " ") for part in row) + " |" for row in operations),
        "", "## 실행과 산출물", "",
        "- 대시보드 Vite 설정과 스타일로 공용 컴포넌트를 렌더링하고 Playwright에서 세션·작업·첨부 응답을 대역 처리",
        f"- 실행 `python3 -P scripts/visual-check/soului_i18n.py --output {out}`",
        f"- 산출물 `{out}/*.png`, `{out}/geometry.json`",
        "",
    ]
    (out / "operations.md").write_text("\n".join(content), encoding="utf-8")
    (out / "geometry.json").write_text(json.dumps(dict(geometry), ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    work = ROOT / "unified-dashboard/.local"
    work.mkdir(exist_ok=True)
    geometry, operations = [], []
    probes = {"tab": [], "focus": []}
    with TemporaryDirectory(prefix="soului-i18n-", dir=work) as temp:
        fixture = Path(temp)
        (fixture / "index.html").write_text(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<div id="root"></div><script type="module" src="./fixture.tsx"></script>', encoding="utf-8")
        (fixture / "fixture.tsx").write_text(FIXTURE, encoding="utf-8")
        server, base = start_vite()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                for locale, width in (("ko", 1440), ("en", 1440), ("en", 360)):
                    capture(browser, f"{base}/.local/{fixture.name}/index.html", locale, width, out, geometry, operations, probes)
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=20)
    write_report(out, geometry, operations, probes)


if __name__ == "__main__":
    main()

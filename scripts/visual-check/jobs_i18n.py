#!/usr/bin/env python3
"""Exercise the jobs settings through the dashboard with fixture API responses."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import expect, sync_playwright
from settings_i18n import DIALOG, ROOT, LocaleFake, capture, page_for, start_vite
from settings_toolbar_fakes import MODEL_PRESETS, SESSION_ID, open_settings

TIMESTAMP = "2026-12-01T00:00:00Z"
PRESET = MODEL_PRESETS[0]["id"]
JOB_NAME = "Weekly briefing and follow-up for the entire project team"
JOB = {
    "job_id": "briefing", "name": JOB_NAME, "prompt": "Summarize updates from the project.",
    "timezone": "Asia/Seoul", "schedule_kind": "recurring", "run_at": None,
    "schedule_expressions": ["0 9 * * 1,3,5"], "node_id": "eiaserinnys", "agent_id": "roselin",
    "model_preset": PRESET, "folderId": "folder-a", "enabled": True, "archived_at": None,
    "late_run_window_seconds": 1800, "next_run_at": TIMESTAMP, "version": 2,
    "created_at": TIMESTAMP, "updated_at": TIMESTAMP,
}
DETAIL = ".config-detail"
DICT_DIR = ROOT / "packages/i18n/src/locales"
SETTINGS_TABS = ("card_dispatch", "recurring_jobs", "summaries", "session_review", "persistent", "persistent_defaults")


class JobsFake(LocaleFake):
    def __init__(self, locale):
        super().__init__()
        self.preferences["language"] = locale
        self.dispatch_state = "ready"
        self.held_dispatch = []
        self.instruction = {
            "id": "i-1", "text": "Report the essential facts first.", "source_turns": ["T195"],
            "created_at": TIMESTAMP, "updated_at": TIMESTAMP, "origin": "agent",
        }

    def handle(self, route):
        url = urlsplit(route.request.url)
        path = url.path
        if path == "/api/settings/card-dispatch":
            if self.dispatch_state == "loading":
                self.held_dispatch.append(route)
                return
            if self.dispatch_state == "error":
                return route.fulfill(status=503, json={})
            return route.fulfill(json={"settings": {"version": 1, "nodeConcurrency": {"default": 4, "eiaserinnys": 6}}})
        if path == "/api/settings/card-orchestration":
            policy = {
                "enabled": True, "candidates": [{"agentId": "roselin", "nodeId": "eiaserinnys",
                                                "modelPreset": PRESET, "minimumRemainingPercent": 15}],
                "usageMaxAgeMs": 300000, "sessionFolderId": None, "systemFolderParentId": None,
            }
            return route.fulfill(json={"settings": {"version": 3, "policy": policy}})
        if path == "/api/recurring-jobs":
            return route.fulfill(json={"jobs": [JOB]})
        if path == "/api/recurring-jobs/briefing/runs":
            return route.fulfill(json={"runs": []})
        if path == "/api/recurring-jobs/preview":
            return route.fulfill(json={"timezone": JOB["timezone"], "scheduleExpressions": JOB["schedule_expressions"],
                                       "nextRuns": [TIMESTAMP]})
        if path == "/api/admin/settings/summaries":
            value = {"turn": {"enabled": True, "model_presets": [PRESET]}, "session": {"enabled": False, "model_presets": []}}
            return route.fulfill(json={"version": 1, "source": "settings", "value": value, "selectable_preset_ids": [PRESET]})
        if path == "/api/admin/settings/session-review-policy":
            policy = {"sourceAllowlist": ["work-portal"], "version": 2, "updatedBy": "qa@example.test", "updatedAt": TIMESTAMP}
            return route.fulfill(json={"policy": policy, "conditionalRules": [], "sourceCatalog": []})
        if path == "/api/admin/settings/persistent-defaults":
            return route.fulfill(json={"version": 2, "source": "settings", "value": {
                "model_preset": PRESET, "fallback_models": [{"model_preset": PRESET, "reasoning_effort": None}],
            }})
        if path == f"/api/persistent-sessions/{SESSION_ID}/instructions":
            return route.fulfill(json={"instructions": [self.instruction]})
        if path == f"/api/persistent-sessions/{SESSION_ID}/instructions/i-1":
            self.instruction = {**self.instruction, **route.request.post_data_json}
            return route.fulfill(json={"instruction": self.instruction})
        if path.endswith("/timeline"):
            event_types = parse_qs(url.query).get("event_types", [""])[0]
            event = {"id": 7, "created_at": TIMESTAMP}
            if event_types == "generation_started":
                event.update(event_type="generation_started", payload={"generation": 4})
            elif event_types == "debug":
                event.update(event_type="debug", payload={"kind": "persistent_decision", "action": "keep", "reason": "below_threshold"})
            else:
                event.update(id=6, event_type="generation_started", payload={"generation": 3, "reason": "settings", "current": {"model_preset": PRESET}})
            return route.fulfill(json={"messages": [event], "next_cursor": None})
        return super().handle(route)


def focus(page):
    return page.evaluate("""() => {
      const el = document.activeElement;
      const label = el?.matches('[data-slot="dialog-popup"]') ? 'DIALOG'
        : ['BODY', 'HTML'].includes(el?.tagName) ? el.tagName
        : el?.getAttribute('aria-label') || el?.textContent?.trim() || el?.tagName;
      return {label, inside: !!el?.closest('[data-slot="dialog-popup"]'), testid: el?.getAttribute('data-testid')};
    }""")


def choose_tab(page, label, settings):
    dialog = page.locator(DIALOG)
    back = dialog.get_by_role("button", name=settings["allSettings"], exact=True)
    if back.is_visible():
        back.click()
    tab = dialog.get_by_role("navigation").get_by_role("button", name=label, exact=True)
    tab.click()
    expect(page.locator(f"{DETAIL} .config-detail-heading h2")).to_have_text(label)
    return focus(page)["label"]


def record(page, out, name, key_label):
    detail = page.locator(DETAIL)
    expect(detail).to_contain_text(key_label)
    assert "jobs." not in detail.inner_text(), name
    page.evaluate("() => document.fonts.ready")
    capture(page, out, f"{name}.png")
    geometry = detail.evaluate("""panel => {
      const visible = el => el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const bounds = panel.getBoundingClientRect();
      const outside = [...panel.querySelectorAll('input,textarea,select,button')].filter(visible).flatMap(el => {
        const box = el.getBoundingClientRect();
        const container = el.closest("aside")?.getBoundingClientRect() ?? bounds;
        if (box.width >= 1 && box.left >= container.left - 1 && box.right <= container.right + 1) return [];
        return [el.getAttribute('aria-label') || el.innerText || el.tagName];
      });
      const clipped = [...panel.querySelectorAll('h2,h3,h4,legend, label,button, p, span')].filter(visible).flatMap(el => {
        if (!el.textContent.trim() || el.children.length || !el.clientWidth || el.scrollWidth <= el.clientWidth + 1
            || getComputedStyle(el).textOverflow === 'ellipsis') return [];
        return [el.textContent.trim()];
      });
      const dateLines = [...panel.querySelectorAll('time')].filter(visible).map(el => {
        const text = document.createRange(); text.selectNodeContents(el);
        return text.getClientRects().length;
      });
      return {document: document.documentElement.scrollWidth, viewport: innerWidth,
              panel: panel.scrollWidth, visible: panel.clientWidth, outside, clipped, dateLines};
    }""")
    return name, geometry


def operation_check(page, fake, out, settings, jobs):
    observations = {}
    print("  Loading, read error, and retry", flush=True)
    opened = focus(page)
    observations["dialog_open"] = opened
    choose_tab(page, settings["tabs"]["card_dispatch"]["label"], settings)
    fake.dispatch_state = "loading"
    choose_tab(page, settings["tabs"]["summaries"]["label"], settings)
    choose_tab(page, settings["tabs"]["card_dispatch"]["label"], settings)
    expect(page.locator(DETAIL).locator("form").first.get_by_role("status", name=jobs["common"]["loading"])).to_be_visible()
    capture(page, out, "en-card-dispatch-loading-1440.png")
    fake.dispatch_state = "error"
    for route in fake.held_dispatch:
        route.fulfill(status=503, json={})
    fake.held_dispatch.clear()
    choose_tab(page, settings["tabs"]["summaries"]["label"], settings)
    choose_tab(page, settings["tabs"]["card_dispatch"]["label"], settings)
    notice = page.locator(DETAIL).get_by_role("alert").filter(has_text=jobs["dispatch"]["loadError"])
    expect(notice).to_be_visible()
    capture(page, out, "en-card-dispatch-error-1440.png")
    fake.dispatch_state = "ready"
    retry = notice.get_by_role("button", name=jobs["common"]["reload"])
    retry.click()
    limit = page.get_by_role("spinbutton", name="Default concurrency limit")
    expect(limit).to_have_value("4")
    observations["retry_focus"] = focus(page)

    print("  Archive confirmation, Tab, and resize", flush=True)
    observations["tab_focus"] = choose_tab(page, settings["tabs"]["recurring_jobs"]["label"], settings)
    panel = page.locator(DETAIL)
    page.locator("[data-settings-list-row]").filter(has_text=JOB_NAME).click()
    schedule = page.get_by_test_id("recurring-schedule-editor")
    frequency = schedule.get_by_label(jobs["schedule"]["frequency"])
    expect(frequency).to_have_value("weekly")
    expect(schedule.get_by_role("button", name="Mon", exact=True)).to_have_attribute("aria-pressed", "true")
    archive = panel.get_by_role("button", name=jobs["recurring"]["archive"], exact=True)
    archive.focus()
    with page.expect_event("dialog") as received:
        page.once("dialog", lambda dialog: dialog.dismiss())
        page.keyboard.press("Enter")
    observations["confirm_message"] = received.value.message
    assert observations["confirm_message"] == jobs["recurring"]["confirmArchive"].replace("{{name}}", JOB_NAME)
    observations["confirm_focus"] = focus(page)
    expect(panel.get_by_role("heading", name=JOB_NAME, exact=True)).to_be_visible()
    frequency.focus()
    page.keyboard.press("Tab")
    observations["after_tab"] = focus(page)

    field = panel.get_by_role("textbox", name=jobs["recurring"]["name"], exact=True)
    field.fill("Unsubmitted title")
    panel.evaluate("element => { element.scrollTop = 150; }")
    before = panel.evaluate("element => element.scrollTop")
    page.set_viewport_size({"width": 360, "height": 800})
    expect(field).to_have_value("Unsubmitted title")
    expect(panel).to_be_visible()
    narrow = panel.evaluate("element => element.scrollTop")
    page.set_viewport_size({"width": 1440, "height": 900})
    after = panel.evaluate("element => element.scrollTop")
    expect(field).to_have_value("Unsubmitted title")
    observations["resize"] = f"입력 보존, 스크롤 {before} → {narrow} → {after}px"
    observations["resize_ok"] = before == narrow == after

    print("  Instruction editing and model picker", flush=True)
    choose_tab(page, settings["tabs"]["persistent"]["label"], settings)
    page.locator("[data-settings-list-row]").filter(has_text="검수 PAS").click()
    instructions = panel.locator('[data-section="instructions"]')
    edit = instructions.get_by_role("button", name=jobs["common"]["edit"], exact=True)
    edit.click()
    edit_field = instructions.get_by_role("textbox", name=jobs["instructions"]["edit"])
    observations["edit_open"] = focus(page)
    edit_field.fill("Discard this draft.")
    edit_field.press("Escape")
    expect(edit_field).to_have_count(0)
    expect(instructions).to_contain_text("Report the essential facts first.")
    observations["edit_cancel"] = focus(page)
    edit.click()
    edit_field.fill("List the key decisions first.")
    edit_field.press("Enter")
    expect(instructions).to_contain_text("List the key decisions first.")
    observations["edit_saved"] = focus(page)

    choose_tab(page, settings["tabs"]["persistent_defaults"]["label"], settings)
    model = panel.get_by_role("combobox", name=jobs["common"]["defaultModel"], exact=True)
    model.focus()
    model.press("Enter")
    options = page.get_by_role("listbox")
    expect(options).to_be_visible()
    observations["model_open"] = focus(page)
    page.keyboard.press("Escape")
    expect(options).to_have_count(0)
    observations["model_close"] = focus(page)
    page.keyboard.press("Escape")
    expect(page.locator(DIALOG)).to_have_count(0)
    observations["dialog_close"] = focus(page)
    return observations


def captures(page, out, locale, width, settings, jobs):
    results = []
    for name in SETTINGS_TABS:
        choose_tab(page, settings["tabs"][name]["label"], settings)
        print(f"  {locale} {width}px {name}", flush=True)
        slug = name.replace("_", "-")
        prefix = f"{locale}-{slug}"
        detail = page.locator(DETAIL)
        if name == "card_dispatch":
            expect(detail.get_by_role("spinbutton").first).to_have_value("4")
            expect(detail.get_by_text(jobs["dispatch"]["centralTitle"], exact=True)).to_be_visible()
            results.append(record(page, out, f"{prefix}-{width}", jobs["dispatch"]["nodeLimit"]))
        elif name == "recurring_jobs":
            row = page.locator("[data-settings-list-row]").filter(has_text=JOB_NAME)
            expect(row).to_be_visible()
            results.append(record(page, out, f"{prefix}-list-{width}", jobs["recurring"]["active"]))
            row.click()
            editor = page.get_by_test_id("recurring-schedule-editor")
            first_day = editor.get_by_role("button", name="월" if locale == "ko" else "Mon", exact=True)
            expect(first_day).to_have_attribute("aria-pressed", "true")
            expected = page.evaluate("(locale) => new Date('2026-12-01T00:00:00Z').toLocaleString(locale)", locale)
            expect(detail).to_contain_text(expected)
            editor.evaluate("(element, block) => element.scrollIntoView({block})", "nearest" if width == 1440 else "center")
            results.append(record(page, out, f"{prefix}-schedule-{width}", jobs["schedule"]["daysOfWeek"]))
        elif name == "persistent":
            page.locator("[data-settings-list-row]").filter(has_text="검수 PAS").click()
            expect(detail.locator('[data-section="instructions"]')).to_contain_text("Report the essential facts first.")
            for key, label in (("account", jobs["persistent"]["accountAndModel"]),
                               ("instructions", jobs["instructions"]["title"]),
                               ("record", jobs["persistent"]["record"])):
                section = detail.locator(f'[data-section="{key}"]')
                section.evaluate("element => element.scrollIntoView({block: 'start'})")
                if key == "record":
                    expect(section.get_by_text(jobs["monitoring"]["currentGeneration"], exact=True)).to_be_visible()
                    expect(section.get_by_test_id("persistent-session-history-row")).to_contain_text(jobs["monitoring"]["settingsChanged"])
                results.append(record(page, out, f"{prefix}-{key}-{width}", label))
        else:
            label = {
                "summaries": jobs["summary"]["turn"],
                "session_review": jobs["review"]["browserRequests"],
                "persistent_defaults": jobs["defaults"]["savedSource"],
            }[name]
            results.append(record(page, out, f"{prefix}-{width}", label))
    return results


def write_operations(out, metrics, op):
    overflows = [(name, result) for name, result in metrics if (
        result["document"] > result["viewport"] or result["panel"] > result["visible"] + 1
        or result["outside"] or result["clipped"] or any(lines != 1 for lines in result["dateLines"])
    )]
    arms = "통과" if not overflows else "관찰 사항 있음"
    inside = "통과" if op["after_tab"]["inside"] else "관찰 사항 있음"
    restored = op["dialog_close"]["testid"] == "config-button"
    focus_states = (op[key] for key in ("dialog_open", "retry_focus", "edit_cancel", "edit_saved"))
    control_focus = all(state["inside"] and state["label"] != "DIALOG" for state in focus_states)
    focus_result = "통과" if restored and control_focus else "관찰 사항 있음"
    summary = [
        "# 조작 결과", "", "## 14번부터 18번", "",
        "| 항목 | 결과 | 근거 |", "| :--- | :--- | :--- |",
        f"| 14 | {focus_result} | 설정 열기 {op['dialog_open']['label']}, 탭 {op['tab_focus']}, 오류 재시도 후 {op['retry_focus']['label']}, 설정 닫기 {op['dialog_close']['label']}. 줄 편집 초점은 아래 표 참조 |",
        f"| 15 | {inside} | 반복 주기에서 Tab 쳤을 때 {op['after_tab']['label']}. 보관 확인을 취소한 뒤 상세가 유지됐고 Esc로 설정을 닫음 |",
        f"| 16 | {arms} | 27장. 화면 및 패널 폭, 좌우로 벗어난 입력·단추, 잘린 글, 날짜 줄 수 측정 |",
        "| 17 | 통과 | 카드 실행 읽기에 503을 돌려 영어 안내 확인. 다시 불러온 뒤 기본 상한 4 표시 |",
        f"| 18 | {'통과' if op['resize_ok'] else '관찰 사항 있음'} | 1440 → 360 → 1440에서 반복 작업 상세와 {op['resize']} |",
        "", "## 대화상자와 줄 안 편집", "",
        "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| :--- | :--- | :--- | :--- | :--- | :--- |",
        f"| 설정 창 | 툴바 설정 단추 | {op['dialog_open']['label']} | 현재 단추 실행 | 설정 닫힘 | {op['dialog_close']['label']} |",
        f"| 반복 작업 보관 확인 | 보관 단추에서 Enter | 브라우저 확인 창 | 확인 열림 | 브라우저 대역에서 취소 | {op['confirm_focus']['label']} |",
        f"| 지속 지시 줄 편집 | 수정 클릭 | {op['edit_open']['label']} | 저장 | 원래 지시로 복귀 | 저장 뒤 {op['edit_saved']['label']}, 취소 뒤 {op['edit_cancel']['label']} |",
        f"| 기본 모델 목록 | 기본 모델에서 Enter | {op['model_open']['label']} | 모델 목록 열림 | 목록 닫힘 | {op['model_close']['label']} |",
        "", "## 측정과 실행", "",
        "- Vite 개발 서버와 Playwright API 대역. 운영 형태의 카드 정책, 주간 일정, 영구 세션·지침·세대 기록을 사용했습니다.",
        "- 기존 설정 창, 목록·상세 틀, 입력과 단추를 재사용했습니다. 추가 CSS와 픽셀 값은 없습니다.",
        f"- 실행 `python3 -P scripts/visual-check/jobs_i18n.py --output {out}`", f"- 산출물 `{out}`",
        f"- 보관 확인 문구는 {op['confirm_message']}",
    ]
    summary.extend(f"- {name} `{json.dumps(result, ensure_ascii=False)}`" for name, result in overflows)
    (out / "operations.md").write_text("\n".join(summary) + "\n", encoding="utf8")
    (out.parent / "samples" / "geometry.json").write_text(json.dumps(dict(metrics), ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def run_case(browser, base, out, case):
    if case == "operations":
        locale, width = "en", 1440
    else:
        locale, width_label = case.split("-")
        width = int(width_label)
    settings = json.loads((DICT_DIR / locale / "settings.json").read_text(encoding="utf8"))
    jobs = json.loads((DICT_DIR / locale / "jobs.json").read_text(encoding="utf8"))
    start_language = "ko" if width == 1440 and case != "operations" else locale
    context, page, fake = page_for(browser, base, width, start_language, JobsFake(start_language))
    try:
        open_settings(page)
        if locale != start_language:
            page.get_by_role("combobox", name="언어", exact=True).click()
            page.get_by_role("option", name="English", exact=True).click()
            expect(page.get_by_role("combobox", name="Language", exact=True)).to_be_visible()
        expect(page.locator("html")).to_have_attribute("lang", locale)
        return operation_check(page, fake, out, settings, jobs) if case == "operations" else captures(page, out, locale, width, settings, jobs)
    finally:
        context.close()


def main():
    cases = ("ko-1440", "en-1440", "en-360", "operations")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--only", choices=cases, help="Run one capture or interaction scenario.")
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    samples = out.parent / "samples"
    samples.mkdir(exist_ok=True)
    proc, base = start_vite()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for case in (args.only,) if args.only else cases:
                print(f"Running {case}", flush=True)
                result = run_case(browser, base, out, case)
                (samples / f"jobs-{case}.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf8")
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=20)
    if all((samples / f"jobs-{case}.json").is_file() for case in cases):
        results = [json.loads((samples / f"jobs-{case}.json").read_text(encoding="utf8")) for case in cases]
        write_operations(out, [metric for group in results[:-1] for metric in group], results[-1])


if __name__ == "__main__":
    main()

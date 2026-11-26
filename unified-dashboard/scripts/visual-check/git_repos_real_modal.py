"""실제 설정창(ConfigModal) 안에서 「Git과 저장소」와 설정창의 오류 상태를 찍고 잰다 (카드 #1909).

git_repos_tab.py가 부른다. 컴포넌트 검수 창은 설정창의 CSS(config-layout.css) 밖이라 설정창 안에서만 생기는 결함을
잡지 못한다. 그래서 settings_toolbar_fakes의 가짜 서버로 실제 설정창을 열어 같은 탭을 다시 잰다.

장면
    git        「Git과 저장소」 기본 화면 (위쪽, 아래쪽)
    ssh-ok     「연결 확인」 성공
    poll-failed 가져오기 진행 조회(GET /git/clones/<id>)가 한 번 504로 실패했다가 「다시 확인」으로 이어짐
    users-500  사용자 탭의 목록 조회 실패와 다시 불러오기
    dispatch-500 카드 실행 탭의 설정 조회 실패와 다시 불러오기
    coding     「코딩 에이전트 연결」 (이 PR이 건드리지 않은 탭이므로 기준 빌드와 배치를 견준다)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from playwright.sync_api import Page, expect

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts" / "visual-check"))
from settings_toolbar_fakes import NODE, Fake, new_page, open_settings, serve  # noqa: E402

Check = Callable[[str, bool, object], None]
Record = Callable[[str, int, str, str], None]

PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3vQ9wZr2m0lXb7s8dYhT4nUe1PqRcJf6aGoWkVxMiN soulstream@eiaserinnys"
SSH_OUTPUT = "Hi example! You've successfully authenticated, but GitHub does not provide shell access."
SNAPSHOT = {
    "identity": {"name": "서소영", "email": "soyoung@example.invalid"},
    "ssh": {"state": "ready", "key_path": "/home/eias/.ssh/id_ed25519", "public_key": PUBLIC_KEY},
    "projects": {"state": "ready", "root": "/home/eias/workspace/.projects", "repos": [
        {"name": "soulstream", "origin_url": "git@github.com:example/soulstream.git", "branch": "main", "dirty": True},
        {"name": "atom", "origin_url": "https://github.com/example/atom.git", "branch": "feat/card-1909-git-setup", "dirty": False},
    ]},
    "clone": None,
}
CLONE_URL = "git@github.com:example/atom-next.git"
USERS = {"users": [{"email": "qa@example.test", "displayName": "QA", "isAdmin": True, "allowedFolderIds": [], "createdAt": "2026-10-01T00:00:00Z", "createdBy": None}], "folders": []}
DISPATCH = {"settings": {"version": 1, "nodeConcurrency": {"default": 2}, "reviewMeetsDependency": False, "startReleasedDependents": False}}
ORCHESTRATION = {"settings": {"key": "card_orchestration", "version": 1, "updatedAt": "2026-10-01T00:00:00Z", "updatedBy": "admin", "policy": {
    "enabled": False, "candidates": [{"agentId": "ariella-orchestrator", "nodeId": "eiaserinnys", "modelPreset": "sample-sol", "minimumRemainingPercent": 15}],
    "usageMaxAgeMs": 300000, "sessionFolderId": None, "systemFolderParentId": None}}, "status": {"state": "blocked", "reason": "usage_stale"}}
PREFERENCES = {"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None}


class RealFake(Fake):
    """장면이 켜고 끄는 실패 스위치(failing)가 있는 Git, 사용자, 카드 실행 응답. 개발 서버는 효과를 두 번 돌리므로 횟수가 아니라 스위치로 건다."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.snapshot = json.loads(json.dumps(SNAPSHOT))
        self.failing = {"poll": False, "users": False, "dispatch": False}
        self.clone_polls = 0

    def node_list(self):
        git = {"node_git_setup_v1": True}
        return [{**NODE, "capabilities": git}, {**NODE, "nodeId": "eias-linegames", "port": 3106, "capabilities": {}},
                {**NODE, "nodeId": "silent-manari-ts", "port": 3107, "status": "disconnected", "capabilities": git}]

    def fail(self, key: str, route, status: int, body: dict) -> bool:
        """스위치가 켜져 있으면 실패 응답을 내고 True를 돌려준다."""
        if not self.failing[key]:
            return False
        route.fulfill(status=status, json=body)
        return True

    def handle(self, route):
        path = urlsplit(route.request.url).path
        method = route.request.method
        if path == "/api/admin/users" and method == "GET":
            return None if self.fail("users", route, 500, {}) else route.fulfill(json=USERS)
        if path == "/api/settings/card-dispatch" and method == "GET":
            return None if self.fail("dispatch", route, 500, {}) else route.fulfill(json=DISPATCH)
        if path == "/api/settings/card-orchestration":
            return route.fulfill(json=ORCHESTRATION)
        if path.startswith("/api/nodes/") and "/git" in path:
            return self.git(route, path.split("/git", 1)[1], method)
        return super().handle(route)

    def git(self, route, tail: str, method: str):
        job = {"clone_id": "c1", "repo_name": "atom-next", "url": CLONE_URL, "error": None, "started_at": "2026-11-27T00:00:00Z", "finished_at": None}
        if tail in ("", "/identity"):
            return route.fulfill(json=self.snapshot)
        if tail == "/ssh-check":
            return route.fulfill(json={"ok": True, "reason": "connected", "output": SSH_OUTPUT})
        if tail == "/clones" and method == "POST":
            return route.fulfill(status=202, json={**job, "state": "running"})
        if tail.startswith("/clones/"):
            if self.fail("poll", route, 504, {"code": "node_command_timeout", "message": "timeout"}):
                return None
            self.clone_polls += 1
            if not any(repo["name"] == "atom-next" for repo in self.snapshot["projects"]["repos"]):
                self.snapshot["projects"]["repos"].append({"name": "atom-next", "origin_url": CLONE_URL, "branch": "main", "dirty": False})
            return route.fulfill(json={**job, "state": "done"})
        return route.fulfill(status=404, json={"code": "not_found", "message": tail})


GEOMETRY = """() => {
  const rect = (element) => { if (!element) return null; const b = element.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const detail = document.querySelector('.config-detail');
  const tab = document.querySelector('[data-testid="git-repos-tab"], [data-testid="coding-agents-tab"]');
  return { dialog: rect(document.querySelector('[data-slot="dialog-popup"]')), detail: rect(detail), tab: rect(tab), aside: rect(tab?.querySelector('aside')),
    pane: rect(tab?.children[1]), groups: [...(tab?.querySelectorAll('.rounded-floor.border.p-3') ?? [])].map(rect),
    rows: [...(tab?.querySelectorAll('[data-testid="config-field-row"]') ?? [])].map((row) => ({ box: rect(row), border: getComputedStyle(row).borderBottomWidth, padding: getComputedStyle(row).padding })),
    docOverflow: document.documentElement.scrollWidth - window.innerWidth, detailOverflow: detail ? detail.scrollWidth - detail.clientWidth : null };
}"""

# 묶음 상자(SettingsGroupBox)마다 안쪽 가로선, 줄(config-field-row)의 아래 괘선과 안쪽 여백, 마지막 줄에서 상자 테두리까지의 거리를 잰다.
BOXES = """() => {
  const tab = document.querySelector('[data-testid="git-repos-tab"]');
  const sections = [...tab.querySelectorAll(':scope > div > .space-y-4 > .rounded-floor.border')];
  const rules = (root) => [...root.querySelectorAll('*')].filter((el) => {
    const s = getComputedStyle(el);
    return el.tagName === 'HR' || (parseFloat(s.borderBottomWidth) > 0 && parseFloat(s.borderTopWidth) === 0 && parseFloat(s.borderLeftWidth) === 0 && parseFloat(s.borderRightWidth) === 0);
  }).map((el) => ({ tag: el.tagName, testid: el.getAttribute('data-testid'), text: (el.textContent ?? '').trim().slice(0, 24) }));
  return sections.map((box) => {
    const style = getComputedStyle(box);
    const last = [...box.children].filter((el) => el.getBoundingClientRect().height > 0).at(-1);
    return { title: box.querySelector('p')?.textContent, rules: rules(box),
      lastToBorder: Math.round((box.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) * 10) / 10,
      inner: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) };
  });
}"""

ALIGN = """() => {
  const tab = document.querySelector('[data-testid="git-repos-tab"]');
  const sections = [...tab.querySelectorAll(':scope > div > .space-y-4 > .rounded-floor.border')];
  const round = (value) => Math.round(value * 10) / 10;
  const framed = (el) => { while (parseFloat(getComputedStyle(el).borderRightWidth) === 0) el = el.parentElement; return el; };
  const textLeft = (el) => { const range = document.createRange(); range.selectNodeContents(el); return round(range.getBoundingClientRect().left); };
  return sections.map((box) => {
    const style = getComputedStyle(box); const b = box.getBoundingClientRect();
    const rows = [...box.querySelectorAll('[data-testid="config-field-row"]')];
    return { title: box.querySelector('p')?.textContent, titleLeft: textLeft(box.querySelector('p')),
      contentRight: round(b.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)),
      labels: rows.map((row) => textLeft(row.querySelector('span'))),
      inputs: rows.map((row) => row.querySelector('input, textarea')).filter(Boolean).map((input) => round(framed(input).getBoundingClientRect().right)),
      lists: [...box.querySelectorAll('ul')].map((list) => round(list.closest('.rounded-floor.border').getBoundingClientRect().right)) };
  });
}"""


SSH_STATUS = """(root) => {
  const tab = document.querySelector(root ?? '[data-testid="git-repos-tab"]');
  const button = [...tab.querySelectorAll('button')].find((b) => b.textContent.trim() === '연결 확인');
  const status = [...tab.querySelectorAll('[role="status"]')].find((el) => el.textContent.includes('연결됨'));
  const raw = [...tab.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent ?? '').includes('successfully authenticated'));
  if (!button || !status) return { button: !!button, status: !!status, raw: !!raw };
  const b = button.getBoundingClientRect(); const s = status.getBoundingClientRect();
  const text = [...status.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
  const lines = text.map((n) => { const range = document.createRange(); range.selectNodeContents(n); return range.getClientRects().length; });
  return { button: true, status: true, sameRow: s.top < b.bottom && b.top < s.bottom, centerGap: Math.abs((s.top + s.bottom) / 2 - (b.top + b.bottom) / 2),
    textLines: lines, raw: !!raw, rawVisible: raw ? raw.checkVisibility() : false, rawInClosedDetails: raw ? raw.closest('details') !== null && !raw.closest('details').open : false };
}"""

FAILED_NOTICE = """(scope) => {
  const root = document.querySelector(scope);
  const notice = root?.querySelector('.v3-error-notice');
  const retry = notice ? [...notice.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
  const raw = notice?.querySelector('pre');
  return { notice: !!notice, retry, rawVisible: raw ? raw.checkVisibility() : false, text: (root?.innerText ?? '').slice(0, 400) };
}"""


def soft_wait(page: Page, selector: str, timeout: int = 6000) -> bool:
    try:
        page.locator(selector).first.wait_for(state="visible", timeout=timeout)
        return True
    except Exception:
        return False


def open_modal(playwright, base: str, fake: RealFake, width: int, theme: str):
    browser = playwright.chromium.launch()
    context, page = new_page(browser, base, fake, width, height=800 if width == 360 else 900, theme=theme, preferences=PREFERENCES)
    page.route("**/api/planner/starred-folders**", lambda route: route.fulfill(json={"items": [], "nextCursor": None}))
    page.set_default_timeout(90000)
    page.goto(base + "/", wait_until="domcontentloaded", timeout=90000)
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=60000)
    page.wait_for_timeout(400)
    open_settings(page)
    page.wait_for_timeout(500)
    return browser, page


def open_tab(page: Page, label: str, ready: str) -> None:
    back = page.locator(".config-back")
    if back.count() and back.first.is_visible():
        back.first.click()
        page.wait_for_timeout(300)
    page.get_by_role("button", name=label, exact=True).click()
    page.locator(ready).first.wait_for(state="visible", timeout=30000)
    page.wait_for_timeout(600)


def shoot(page: Page, out: Path, record: Record, name: str, width: int, theme: str, state: str, bottom: bool = False, into_view: str | None = None) -> None:
    """into_view를 주면 그 요소가 보이도록 스크롤하고, 아니면 맨 위(bottom이면 맨 아래)로 둔다."""
    if into_view:
        page.locator(into_view).first.scroll_into_view_if_needed()
    else:
        page.evaluate("(bottom) => { const d = document.querySelector('.config-detail'); if (d) d.scrollTop = bottom ? d.scrollHeight : 0; }", bottom)
    page.wait_for_timeout(250)
    file = f"{name}-{width}-{theme}.png"
    page.locator('[data-slot="dialog-popup"]').screenshot(path=str(out / file), animations="disabled")
    record(file, width, theme, state)


def git_scenes(page: Page, out: Path, check: Check, record: Record, fake: RealFake, width: int, theme: str) -> None:
    tag = f"{width}px {theme}"
    tab = '[data-testid="git-repos-tab"]'
    open_tab(page, "Git과 저장소", f'{tab} :text("Git 사용자")')
    shoot(page, out, record, "git-real", width, theme, "실제 설정창 · Git과 저장소")
    shoot(page, out, record, "git-real-bottom", width, theme, "실제 설정창 · Git과 저장소 · 아래쪽", bottom=True)
    geometry = page.evaluate(GEOMETRY)
    boxes = page.evaluate(BOXES)
    check(f"실제 설정창 {tag}: 입력 줄(config-field-row)의 아래 괘선이 0px", all(row["border"] == "0px" for row in geometry["rows"]) and len(geometry["rows"]) >= 6, geometry["rows"])
    check(f"실제 설정창 {tag}: 입력 줄의 안쪽 여백이 위아래 6px, 좌우 0px", all(row["padding"] == "6px 0px" for row in geometry["rows"]), geometry["rows"])
    check(f"실제 설정창 {tag}: 묶음 상자 안에 저장소 목록 상자 말고 다른 가로선이 없음", len(boxes) == 3 and all(not box["rules"] for box in boxes), boxes)
    check(f"실제 설정창 {tag}: 마지막 줄 아래부터 상자 테두리까지가 상자 안쪽 여백 하나", all(abs(box["lastToBorder"] - box["inner"]) <= 1 for box in boxes), boxes)
    align = page.evaluate(ALIGN)
    check(f"반려 4 {tag}: 세 묶음 상자 모두 이름표 시작선이 상자 제목과 1px 이내", len(align) == 3 and all(box["labels"] and all(abs(left - box["titleLeft"]) <= 1 for left in box["labels"]) for box in align), align)
    check(f"반려 4 {tag}: 세 묶음 상자 모두 입력 칸과 저장소 목록의 오른쪽 끝이 상자 내용 끝과 1px 이내", len(align) == 3 and any(box["inputs"] for box in align) and all(abs(right - box["contentRight"]) <= 1 for box in align for right in box["inputs"] + box["lists"]), align)
    check(f"실제 설정창 {tag}: 가로 넘침이 없음", geometry["docOverflow"] <= 0 and (geometry["detailOverflow"] or 0) <= 0, geometry)

    page.get_by_role("button", name="연결 확인").click()
    soft_wait(page, f'{tab} [role="status"]:has-text("연결됨")', 4000)
    page.wait_for_timeout(300)
    ssh = page.evaluate(SSH_STATUS)
    check_ssh_status(check, f"실제 설정창 {tag}", ssh)
    shoot(page, out, record, "git-real-ssh-ok", width, theme, "실제 설정창 · 연결 확인 성공", into_view=f'{tab} [role="status"]')

    page.get_by_label("원격 주소").fill(CLONE_URL)
    fake.failing["poll"] = True
    page.get_by_role("button", name="가져오기").click()
    appeared = soft_wait(page, f"{tab} .v3-error-notice", 8000)
    failed = page.evaluate(FAILED_NOTICE, tab)
    check(f"반려 2 {tag}: 가져오기 진행 조회가 실패하면 저장소 상자 안에 오류 안내(v3-error-notice)가 뜸", appeared and failed["notice"], failed)
    check(f"반려 2 {tag}: 오류 안내에 「다시 확인」 단추가 있음", "다시 확인" in failed["retry"], failed)
    shoot(page, out, record, "git-real-poll-failed", width, theme, "실제 설정창 · 가져오기 진행 조회 실패", into_view=f"{tab} .v3-error-notice")
    fake.failing["poll"] = False
    if "다시 확인" in failed["retry"]:
        page.get_by_role("button", name="다시 확인").click()
    soft_wait(page, f'{tab} :text("가져왔습니다")', 8000)
    done = page.evaluate("() => { const tab = document.querySelector('[data-testid=\"git-repos-tab\"]'); return { done: tab.innerText.includes('가져왔습니다: atom-next'), listed: !!tab.querySelector('li [title=\"atom-next\"]'), notice: !!tab.querySelector('.v3-error-notice') }; }")
    check(f"반려 2 {tag}: 「다시 확인」 뒤 「가져왔습니다: atom-next」가 뜨고 저장소 목록이 갱신되고 오류 안내가 사라짐", done["done"] and done["listed"] and not done["notice"], done)
    shoot(page, out, record, "git-real-cloned", width, theme, "실제 설정창 · 다시 확인 뒤 가져옴", into_view=f'{tab} [role="status"]:has-text("가져왔습니다")')


def failure_scenes(page: Page, out: Path, check: Check, record: Record, fake: RealFake, width: int, theme: str) -> None:
    tag = f"{width}px {theme}"
    scope = ".config-detail"
    open_tab(page, "사용자", f'{scope} :text("대시보드 로그인과 폴더 접근 권한")')
    page.wait_for_timeout(1200)
    users = page.evaluate(FAILED_NOTICE, scope)
    check(f"설정창 사용자 탭 {tag}: 목록 조회가 실패하면 빈 목록 문구(등록된 사용자가 없습니다)를 그리지 않음", "등록된 사용자가 없습니다" not in users["text"], users)
    check(f"설정창 사용자 탭 {tag}: 오류 안내와 「다시 불러오기」가 있고 HTTP 500 원문은 기본으로 보이지 않음", users["notice"] and "다시 불러오기" in users["retry"] and not users["rawVisible"], users)
    shoot(page, out, record, "users-500", width, theme, "사용자 탭 · 목록 조회 500")
    fake.failing["users"] = False
    if "다시 불러오기" in users["retry"]:
        page.get_by_role("button", name="다시 불러오기").click()
        soft_wait(page, f'{scope} :text("qa@example.test")', 6000)
    again = page.evaluate("() => ({ row: document.querySelector('.config-detail').innerText.includes('qa@example.test'), notice: !!document.querySelector('.config-detail .v3-error-notice') })")
    check(f"설정창 사용자 탭 {tag}: 다시 불러오면 목록이 서고 오류 안내가 사라짐", again["row"] and not again["notice"], again)

    open_tab(page, "카드 실행", f'{scope} :text("노드별 동시 실행 상한")')
    page.wait_for_timeout(1200)
    dispatch = page.evaluate(FAILED_NOTICE, scope)
    check(f"설정창 카드 실행 탭 {tag}: 설정 조회가 실패하면 「불러오는 중…」이 멈춤", "불러오는 중" not in dispatch["text"], dispatch)
    check(f"설정창 카드 실행 탭 {tag}: 오류 안내와 「다시 불러오기」가 있고 Error 원문은 기본으로 보이지 않음", dispatch["notice"] and "다시 불러오기" in dispatch["retry"] and not dispatch["rawVisible"], dispatch)
    shoot(page, out, record, "card-dispatch-500", width, theme, "카드 실행 탭 · 설정 조회 500")
    fake.failing["dispatch"] = False
    if "다시 불러오기" in dispatch["retry"]:
        page.get_by_role("button", name="다시 불러오기").first.click()
        soft_wait(page, f'{scope} input[aria-label="기본값 동시 실행 상한"]', 6000)
    after = page.evaluate("() => ({ input: !!document.querySelector('.config-detail input[aria-label=\"기본값 동시 실행 상한\"]'), notice: !!document.querySelector('.config-detail form .v3-error-notice') })")
    check(f"설정창 카드 실행 탭 {tag}: 다시 불러오면 입력 칸이 서고 오류 안내가 사라짐", after["input"] and not after["notice"], after)


def coding_scene(page: Page, out: Path, record: Record, width: int, theme: str) -> dict:
    open_tab(page, "코딩 에이전트 연결", '[data-testid="coding-agents-tab"] [data-settings-list-row]')
    shoot(page, out, record, "coding-real", width, theme, "실제 설정창 · 코딩 에이전트 연결(불변)")
    return page.evaluate(GEOMETRY)


def check_ssh_status(check: Check, tag: str, ssh: dict) -> None:
    check(f"{tag}: 연결 확인 성공 상태(연결됨)가 단추 곁에 섬", ssh.get("status") is True, ssh)
    check(f"{tag}: 영어 원문이 기본으로 보이지 않고 접힌 기술 상세에 있음", ssh.get("raw") is True and ssh.get("rawVisible") is False and ssh.get("rawInClosedDetails") is True, ssh)
    if ssh.get("status"):
        check(f"{tag}: 상태와 단추의 세로 중심이 1px 이내(같은 줄일 때)", not ssh["sameRow"] or ssh["centerGap"] <= 1, ssh)
        check(f"{tag}: 상태 문구가 한 줄이라 낱말 가운데서 끊기지 않음", bool(ssh["textLines"]) and all(lines == 1 for lines in ssh["textLines"]), ssh)


def run(playwright, base: str, out: Path, check: Check, record: Record, baseline_dist: Path | None) -> None:
    for width in (1280, 360):
        for theme in ("dark", "light"):
            fake = RealFake(atom=True, admin=True)
            browser, page = open_modal(playwright, base, fake, width, theme)
            try:
                coding = coding_scene(page, out, record, width, theme)
                git_scenes(page, out, check, record, fake, width, theme)
                fake.failing.update(users=True, dispatch=True)
                failure_scenes(page, out, check, record, fake, width, theme)
            finally:
                browser.close()
            if baseline_dist is None or theme != "dark":
                continue
            server, baseline_base = serve(baseline_dist)
            try:
                browser, page = open_modal(playwright, baseline_base, RealFake(atom=True, admin=True), width, theme)
                try:
                    before = coding_scene(page, out, lambda *_: None, width, theme)
                finally:
                    browser.close()
            finally:
                server.shutdown()
            check(f"불변 {width}px {theme}: 「코딩 에이전트 연결」 배치(창, 목록, 상세, 줄 수치)가 기준 빌드와 같음", before == coding, {"before": before, "after": coding})

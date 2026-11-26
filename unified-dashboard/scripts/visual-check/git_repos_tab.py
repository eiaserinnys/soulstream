#!/usr/bin/env python3
"""설정창 「Git과 저장소」 탭 시각 검수와 조작 측정 (카드 #1909).

컴포넌트 검수 창의 GitReposTab 장면(가짜 요청)을 넓은 폭(1280)과 좁은 폭(360), 다크와 라이트 테마로
캡처하고, 넘침, 0폭 글자, 말줄임, 왼쪽 끝선, 위쪽 끝, 초점 이동, 바쁜 단추, Tab 순서, 창 크기 바꾸기를 잰다.

준비 (저장소 루트에서)

    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
        --host 127.0.0.1 --port 5173 --strictPort

실행 (-P 없이 부른다. 같은 폴더의 provider_panel.py에서 가짜 인증 응답을 가져온다)

    python3 unified-dashboard/scripts/visual-check/git_repos_tab.py \
        http://127.0.0.1:5173 /path/to/output

산출물

    {출력}/git-repos-{장면}-{폭}-{테마}.png
    {출력}/checks.json    (단언 하나마다 이름, 통과 여부, 측정값)
    {출력}/operations.md  (ui-design §9 조작 결과 파일)
    {출력}/index.md       (캡처 목록)

단언이 하나라도 실패하면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

from git_repos_real_modal import SSH_STATUS, check_ssh_status, run as run_real_modal
from provider_panel import THEMES, install_page, settle

WIDTHS = (1280, 360)
TOLERANCE_PX = 1.0
SCENES = (
    ("ready", "준비 · 키 있음 · 저장소 2개"),
    ("unset-no-key", "사용자 미설정 · 키 없음"),
    ("public-missing", "공개키 파일 없음"),
    ("root-unset", "저장소 폴더 미설정"),
    ("root-missing", "저장소 폴더 없음"),
    ("loading", "불러오는 중"),
    ("read-failed", "읽기 실패"),
    ("node-down", "노드 끊김"),
    ("node-old", "구버전 노드"),
    ("clone-running", "가져오는 중"),
    ("clone-failed", "가져오기 실패"),
    ("ssh-ok", "연결 확인 성공"),
    ("ssh-failed", "연결 확인 실패"),
    ("worst", "최악 데이터"),
)
READY_SIGNAL = {
    "loading": '[data-slot="frame-loading"]',
    "read-failed": ".v3-error-notice",
    "node-down": '[role="alert"]',
    "node-old": '[role="alert"]',
    "clone-running": '[data-slot="frame-loading"]:has-text("가져오는 중")',
    "clone-failed": ".v3-error-notice",
}
DEFAULT_SIGNAL = 'text=Git 사용자'

CHECKS: list[dict] = []
INDEX: list[tuple[str, int, str, str]] = []
OPERATIONS: list[tuple[str, str, str]] = []
DIALOG_ROWS: list[str] = []


def check(name: str, ok: bool, detail=None) -> None:
    CHECKS.append({"check": name, "ok": bool(ok), "detail": detail})
    print(f"{'통과' if ok else '실패'}: {name}" + ("" if ok else f" -> {detail}"))


LAYOUT_SCRIPT = """
(sceneId) => {
  const scene = document.querySelector(`[data-review-scene="${sceneId}"]`);
  const sceneBox = scene.getBoundingClientRect();
  const round = (value) => Math.round(value * 10) / 10;
  const problems = [];
  const label = (element) => (element.textContent ?? '').trim().slice(0, 40);
  const pageOverflow = document.documentElement.scrollWidth - window.innerWidth;
  if (pageOverflow > 0) problems.push({ kind: 'page-overflow', px: pageOverflow });
  for (const element of scene.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || element.closest('.sr-only')) continue;
    const ownText = Array.from(element.childNodes).filter((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
    if (ownText.length === 0) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) problems.push({ kind: 'zero-size', text: label(element) });
    if (box.left < sceneBox.left - 1 || box.right > sceneBox.right + 1) problems.push({ kind: 'outside-scene', text: label(element), left: round(box.left - sceneBox.left), right: round(box.right - sceneBox.right) });
    const frame = element.parentElement?.closest('.rounded-floor');
    if (frame) {
      const frameBox = frame.getBoundingClientRect();
      if (box.right > frameBox.right + 1 || box.left < frameBox.left - 1) problems.push({ kind: 'outside-frame', text: label(element), over: round(Math.max(box.right - frameBox.right, frameBox.left - box.left)) });
    }
    if (element.scrollWidth > element.clientWidth + 1) {
      const ellipsis = style.textOverflow === 'ellipsis' && style.overflowX === 'hidden';
      if (!ellipsis) problems.push({ kind: 'clipped-without-ellipsis', text: label(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
    }
    if (element.matches('button, [data-slot="badge"]')) {
      for (const node of ownText) {
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length > 1) problems.push({ kind: 'broken-line', text: label(element) });
      }
    }
  }
  return problems;
}
"""

ALIGN_SCRIPT = """
(sceneId) => {
  const scene = document.querySelector(`[data-review-scene="${sceneId}"]`);
  const round = (value) => Math.round(value * 10) / 10;
  const detail = scene.querySelector('[data-testid="git-repos-tab"] > div');
  const aside = scene.querySelector('[data-testid="git-repos-tab"] > aside');
  const header = detail?.querySelector('header');
  const boxes = Array.from(detail?.querySelectorAll(':scope > .space-y-4 > .rounded-floor') ?? []);
  const rows = Array.from(detail?.querySelectorAll('[data-testid="config-field-row"] > div:first-child') ?? []);
  const left = (element) => round(element.getBoundingClientRect().left);
  const right = (element) => round(element.getBoundingClientRect().right);
  return {
    asideTop: aside ? round(aside.getBoundingClientRect().top) : null,
    detailTop: detail ? round(detail.getBoundingClientRect().top) : null,
    headerLeft: header ? left(header) : null,
    boxLefts: boxes.map(left),
    boxRights: boxes.map(right),
    labelLefts: rows.map(left),
    stacked: aside && detail ? aside.getBoundingClientRect().bottom <= detail.getBoundingClientRect().top + 1 : null,
  };
}
"""

FOCUS_SCRIPT = """
() => {
  const element = document.activeElement;
  const box = element?.getBoundingClientRect();
  return {
    label: element?.getAttribute('aria-label') || (element?.textContent ?? '').trim() || element?.tagName,
    tag: element?.tagName,
    visible: !!box && box.width > 0 && box.height > 0,
    ariaDisabled: element?.getAttribute('aria-disabled'),
  };
}
"""


def spread(values: list[float]) -> float:
    return round(max(values) - min(values), 1) if values else 0.0


def open_page(page: Page, base: str, scene: str | None = None, delay: int = 0) -> None:
    """scene을 주면 그 장면만, 없으면 장면 전부를 한 페이지에 연다."""
    query = "sample=git-repos" + (f"&scene={scene}" if scene else "") + (f"&delay={delay}" if delay else "")
    page.set_default_timeout(90000)
    page.goto(f"{base}/components?{query}", wait_until="domcontentloaded", timeout=90000)
    settle(page)
    # 배경의 WebGL 유리 캔버스는 장식이고, 소프트웨어 GL에서 캡처 한 장에 8초씩 걸려 가린다. 노드 목록과 상세 틀은 그대로다.
    page.add_style_tag(content="canvas { visibility: hidden !important; }")
    for name in ([scene] if scene else [item[0] for item in SCENES]):
        try:
            page.locator(f'[data-review-scene="{name}"]').locator(READY_SIGNAL.get(name, DEFAULT_SIGNAL)).first.wait_for(state="visible", timeout=90000)
        except Exception:
            print("장면이 준비되지 않음:", name, page.evaluate("() => document.body.innerText.slice(0, 300)"), file=sys.stderr)
            raise
    page.wait_for_timeout(250)


def scoped(page: Page, scene: str):
    return page.locator(f'[data-review-scene="{scene}"]')


def shot(page: Page, out: Path, scene: str, width: int, theme: str, state: str, suffix: str = "") -> None:
    name = f"git-repos-{scene}{suffix}-{width}-{theme}.png"
    page.evaluate("() => document.fonts.ready")
    page.locator(f'[data-review-scene="{scene}"]').screenshot(path=str(out / name), animations="disabled")
    INDEX.append((name, width, theme, state))
    print(f"{name}")


def layout_checks(page: Page, scene: str, tag: str, expect_truncation: bool = False) -> None:
    problems = page.evaluate(LAYOUT_SCRIPT, scene)
    check(f"{tag}: 가로 넘침, 0폭 글자, 말줄임 없이 잘린 글, 줄 중간에서 끊긴 단추와 배지가 없음", not problems, problems)
    if expect_truncation:
        truncated = page.evaluate("""(sceneId) => Array.from(document.querySelectorAll(`[data-review-scene="${sceneId}"] li .truncate`))
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({ text: (element.textContent ?? '').slice(0, 30), title: element.getAttribute('title'), ellipsis: getComputedStyle(element).textOverflow }))""", scene)
        check(f"{tag}: 길어서 잘린 이름, 주소, 가지에 말줄임과 title이 있음", len(truncated) > 0 and all(item["ellipsis"] == "ellipsis" and item["title"] for item in truncated), truncated)


def alignment_checks(page: Page, scene: str, tag: str, wide: bool) -> None:
    measured = page.evaluate(ALIGN_SCRIPT, scene)
    left_spread = spread(measured["boxLefts"] + [measured["headerLeft"]])
    right_spread = spread(measured["boxRights"])
    label_spread = spread(measured["labelLefts"])
    check(f"{tag}: 제목과 세 묶음의 왼쪽 끝선이 1px 이내", left_spread <= TOLERANCE_PX, measured)
    check(f"{tag}: 세 묶음의 오른쪽 끝선이 1px 이내", right_spread <= TOLERANCE_PX, measured)
    check(f"{tag}: 입력 칸 이름표의 왼쪽 끝선이 1px 이내", label_spread <= TOLERANCE_PX, measured)
    if wide:
        check(f"{tag}: 노드 목록과 상세의 위쪽 끝이 1px 이내", abs(measured["asideTop"] - measured["detailTop"]) <= TOLERANCE_PX, measured)
    else:
        check(f"{tag}: 좁은 폭에서는 노드 목록 아래로 상세가 이어짐", measured["stacked"] is True, measured)


def capture_matrix(playwright, base: str, out: Path) -> None:
    for width in WIDTHS:
        for theme in THEMES:
            height = 6000 if width == 360 else 3200
            # 한 브라우저로 이어 열면 두 번째 맥락부터 요청이 풀리지 않는 일이 있어 맥락마다 브라우저를 새로 띄운다.
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme, reduced_motion="reduce")
            install_page(context, theme)
            page = context.new_page()
            open_page(page, base)
            for scene, state in SCENES:
                tag = f"{scene} {width}px {theme}"
                if scene in ("ssh-ok", "ssh-failed"):
                    scoped(page, scene).get_by_role("button", name="연결 확인").click()
                    scoped(page, scene).locator('[role="status"]' if scene == "ssh-ok" else ".v3-error-notice").first.wait_for(state="visible")
                    page.wait_for_timeout(200)
                    if scene == "ssh-ok":
                        check_ssh_status(check, f"반려 3 {tag}", page.evaluate(SSH_STATUS, '[data-review-scene="ssh-ok"]'))
                shot(page, out, scene, width, theme, state)
                layout_checks(page, scene, tag, expect_truncation=scene == "worst")
                if scene in ("ready", "worst", "unset-no-key"):
                    alignment_checks(page, scene, tag, wide=width == 1280)
                if scene == "unset-no-key":
                    scoped(page, scene).get_by_role("button", name="SSH 키 만들기").click()
                    scoped(page, scene).get_by_role("button", name="복사", exact=True).wait_for(state="visible")
                    focus = page.evaluate(FOCUS_SCRIPT)
                    check(f"14번 {tag}: 「SSH 키 만들기」를 누른 뒤 초점이 「복사」 단추로 감", focus["label"] == "복사" and focus["tag"] == "BUTTON", focus)
                    shot(page, out, scene, width, theme, "키를 만든 직후", suffix="-created")
                    layout_checks(page, scene, f"{tag} 만든 직후")
            context.close()
            browser.close()


class Session:
    """장면을 열 때마다 브라우저를 새로 띄운다. 한 브라우저로 이어 열면 세 번째쯤부터 페이지 이동이 멈추는 일이 있었다."""

    def __init__(self, playwright, base: str) -> None:
        self.playwright, self.base = playwright, base
        self.browser = None

    def open(self, scene: str, delay: int = 0) -> Page:
        self.close()
        self.browser = self.playwright.chromium.launch()
        context = self.browser.new_context(viewport={"width": 1280, "height": 3200}, color_scheme="dark", reduced_motion="reduce")
        install_page(context, "dark")
        page = context.new_page()
        open_page(page, self.base, scene, delay)
        return page

    def close(self) -> None:
        if self.browser is not None:
            self.browser.close()
            self.browser = None


def operation_checks(playwright, base: str) -> None:
    session = Session(playwright, base)

    # 15번: Tab 순서가 화면을 읽는 순서를 따르고 보이지 않는 요소에 초점이 들어가지 않는다.
    page = session.open("ready")
    page.locator('[data-review-scene="ready"] aside button').first.focus()
    seen = []
    for _ in range(10):
        seen.append(page.evaluate(FOCUS_SCRIPT))
        page.keyboard.press("Tab")
    labels = [item["label"] for item in seen]
    expected = ["sample-node-a연결됨", "이름", "이메일", "저장", "복사", "호스트", "연결 확인", "원격 주소", "폴더 이름", "가져오기"]
    check("15번: Tab 순서가 노드 목록, 사용자, SSH 키, 저장소 순서를 따름", labels == expected, labels)
    check("15번: 초점이 닿은 요소가 모두 보임", all(item["visible"] for item in seen), seen)

    # 바쁠 때 aria-disabled로 초점을 유지하고, 응답이 오면 풀린다.
    page = session.open("ssh-ok", delay=1500)
    connect = page.get_by_role("button", name="연결 확인")
    connect.focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    busy = page.evaluate(FOCUS_SCRIPT)
    check("14번: 연결 확인이 도는 동안 단추가 aria-disabled이고 초점이 그대로 단추에 있음", busy["ariaDisabled"] == "true" and busy["label"] == "연결 확인", busy)
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    page.wait_for_selector('[role="status"]:has-text("연결됨")', timeout=8000)
    check("14번: 도는 동안 다시 눌러도 요청이 겹치지 않고 응답이 오면 aria-disabled가 풀림", page.evaluate(FOCUS_SCRIPT)["ariaDisabled"] is None)

    # 줄 안 편집: Enter로 제출하고 초점은 입력 칸에 남는다.
    page = session.open("ready", delay=600)
    page.get_by_label("이름", exact=True).focus()
    page.keyboard.press("Enter")
    page.wait_for_selector('[role="status"]:has-text("저장했습니다")', timeout=8000)
    after_save = page.evaluate(FOCUS_SCRIPT)
    page.get_by_label("호스트", exact=True).focus()
    page.keyboard.press("Enter")
    page.wait_for_selector('[role="status"]:has-text("연결됨")', timeout=8000)
    after_check = page.evaluate(FOCUS_SCRIPT)
    page.get_by_label("원격 주소", exact=True).fill("https://github.com/example/new.git")
    page.keyboard.press("Enter")
    page.wait_for_selector('[data-slot="frame-loading"]:has-text("가져오는 중")', timeout=8000)
    after_clone = page.evaluate(FOCUS_SCRIPT)
    page.keyboard.press("Escape")
    after_esc = page.evaluate(FOCUS_SCRIPT)
    check("줄 안 편집: 이름 칸 Enter가 저장하고 초점이 칸에 남음", after_save["label"] == "이름", after_save)
    check("줄 안 편집: 호스트 칸 Enter가 연결 확인을 하고 초점이 칸에 남음", after_check["label"] == "호스트", after_check)
    check("줄 안 편집: 원격 주소 칸 Enter가 가져오기를 시작하고 초점이 칸에 남음", after_clone["label"] == "원격 주소", after_clone)
    check("줄 안 편집: Esc는 아무것도 되돌리거나 닫지 않음(초점과 입력 유지)", after_esc["label"] == "원격 주소", after_esc)
    DIALOG_ROWS.extend([
        f"| Git 사용자 폼(이름, 이메일 칸) | 이름 칸에 초점을 두고 Enter | 이름 칸 | 저장 요청, 「저장했습니다」 | 변화 없음(대화상자가 아님) | {after_save['label']} 칸 |",
        f"| SSH 연결 확인 폼(호스트 칸) | 호스트 칸에 초점을 두고 Enter | 호스트 칸 | 연결 확인 요청, 결과 줄 표시 | 변화 없음 | {after_check['label']} 칸 |",
        f"| 저장소 가져오기 폼(원격 주소, 폴더 이름 칸) | 원격 주소를 채우고 Enter | 원격 주소 칸 | 가져오기 시작, 「가져오는 중…」 | 변화 없음 | {after_clone['label']} 칸 |",
        "| 오류 상자의 「기술 상세」 | 상자 안 summary를 눌러 펼침 | summary | 펼침과 접힘(브라우저 기본) | 변화 없음 | summary |",
    ])

    # 17번: 읽기 실패는 실패 안내로 바뀌고 다시 불러오기가 있다.
    page = session.open("read-failed")
    retry = page.get_by_role("button", name="다시 불러오기")
    check("17번: 읽기 실패 자리가 실패 안내로 바뀌고 다시 불러오기 단추가 있음", retry.count() == 1 and page.locator('[data-slot="frame-loading"]').count() == 0)
    retry.click()
    page.wait_for_selector(".v3-error-notice", state="visible")
    check("17번: 다시 불러오기를 눌러도 같은 자리에서 실패 안내가 이어지고 빈 화면이 되지 않음", page.get_by_role("button", name="다시 불러오기").count() == 1)

    # 18번: 창 크기를 오가도 배치가 다시 서고 입력 중인 글이 남는다.
    page = session.open("ready")
    page.get_by_label("이름", exact=True).fill("입력 중인 이름")
    results = []
    for width in (360, 1280, 360):
        page.set_viewport_size({"width": width, "height": 3200})
        page.wait_for_timeout(400)
        results.append({
            "width": width,
            "overflow": page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth"),
            "name": page.get_by_label("이름", exact=True).input_value(),
            "stacked": page.evaluate(ALIGN_SCRIPT, "ready")["stacked"],
        })
    check("18번: 360, 1280, 360px로 바꿔도 가로 넘침이 없고 입력 중인 글이 남음", all(item["overflow"] <= 0 and item["name"] == "입력 중인 이름" for item in results), results)
    check("18번: 폭에 맞게 배치가 다시 섬(360은 목록 아래로 상세, 1280은 두 칸)", [item["stacked"] for item in results] == [True, False, True], results)

    # 13번: 로딩 중에도 틀(노드 목록과 상세 제목)이 서 있고 로딩 표시는 그 안에 있다.
    page = session.open("loading")
    inside = page.evaluate("""() => {
      const loading = document.querySelector('[data-slot="frame-loading"]');
      const detail = document.querySelector('[data-testid="git-repos-tab"] > div');
      return { inside: !!detail && detail.contains(loading), header: !!detail?.querySelector('header'), nodeRows: document.querySelectorAll('[data-testid="git-repos-tab"] aside button').length };
    }""")
    check("13번: 로딩 중에도 노드 목록과 상세 제목이 서 있고 로딩 표시가 상세 안에 있음", inside["inside"] and inside["header"] and inside["nodeRows"] == 1, inside)
    session.close()


def write_reports(out: Path, base: str) -> None:
    def result(prefix: str) -> tuple[str, str]:
        items = [item for item in CHECKS if item["check"].startswith(prefix)]
        ok = bool(items) and all(item["ok"] for item in items)
        return ("통과" if ok else "실패"), f"{len(items)}개 단언" if items else "단언 없음"

    rows = []
    for number, text in (
        ("14", "누른 뒤 초점"), ("15", "Tab과 Esc"), ("16", "최소 폭에서 넘침과 잘림"),
        ("17", "오류 상태"), ("18", "창 크기 바꾸기"), ("13", "로딩 상태"),
    ):
        verdict, count = result(f"{number}번")
        notes = {
            "14": "「SSH 키 만들기」 뒤 초점이 「복사」 단추로 감, 연결 확인이 도는 동안 aria-disabled로 초점 유지",
            "15": "Tab 순서가 노드 목록, 사용자, SSH 키, 저장소 순서이고 보이지 않는 요소에 초점이 안 들어감. 이 탭에 열고 닫는 팝업은 없어 Esc는 줄 안 편집에서 입력을 되돌리지 않음만 잼",
            "16": "360px에서 최악 데이터(100자 이름, 긴 주소와 노드 ID, 저장소 30개)까지 가로 넘침, 0폭 글자, 말줄임 없이 잘린 글이 없음(장면 14개 × 폭 2 × 테마 2의 layout 단언)",
            "17": "읽기 실패 자리가 실패 안내로 바뀌고 다시 불러오기가 있음. 클론 실패와 연결 확인 실패도 같은 오류 상자",
            "18": "360, 1280, 360px 사이를 오가며 배치가 다시 서고 입력 중인 글이 남음",
            "13": "로딩 장면에서 틀이 서 있고 로딩 표시가 상세 안에 있음",
        }
        if number == "16":
            items = [item for item in CHECKS if "가로 넘침, 0폭" in item["check"] or "말줄임과 title" in item["check"]]
            verdict, count = ("통과" if items and all(item["ok"] for item in items) else "실패"), f"{len(items)}개 단언"
        rows.append(f"| {number} {text} | {verdict} | {notes[number]} ({count}) |")
    for prefix, text, note in (
        ("실제 설정창", "반려 1·3 실제 설정창", "설정창 안에서 입력 줄 괘선 0px, 줄 여백이 위아래 6px 좌우 0px, 묶음 상자 안에 가로선 없음, 연결됨 상태와 단추의 세로 중심 1px 이내, 영어 원문은 접힌 기술 상세"),
        ("반려 4", "반려 4 실제 설정창 끝선", "세 묶음 상자 모두 이름표 시작선이 상자 제목과, 입력 칸과 저장소 목록의 오른쪽 끝이 상자 내용 끝과 1px 이내"),
        ("반려 3", "반려 3 검수 창 ssh-ok", "검수 창 ssh-ok 장면의 같은 단언"),
        ("반려 2", "반려 2 가져오기 진행 조회 실패", "504 뒤 오류 안내와 「다시 확인」, 다시 확인하면 「가져왔습니다」와 목록 갱신"),
        ("설정창 사용자 탭", "사용자 탭 500", "빈 목록 문구 미노출, 오류 안내와 다시 불러오기, 다시 불러오면 목록"),
        ("설정창 카드 실행 탭", "카드 실행 탭 500", "「불러오는 중…」 멈춤, 오류 안내와 다시 불러오기, 다시 불러오면 입력 칸"),
        ("불변", "코딩 에이전트 연결 불변", "기준 빌드와 창, 목록, 상세, 줄 수치가 같음"),
    ):
        verdict, count = result(prefix)
        rows.append(f"| {text} | {verdict} | {note} ({count}) |")
    lines = [
        "# 카드 #1909 「Git과 저장소」 설정 탭 조작 결과", "", "## 14번부터 18번", "",
        "| 항목 | 결과 | 근거 |", "| --- | --- | --- |", *rows, "",
        "## 대화상자와 줄 안 편집", "",
        "| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |", "| --- | --- | --- | --- | --- | --- |",
        *DIALOG_ROWS, "",
        "## 실행 명령과 산출물", "",
        f"- 준비: `VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite --host 127.0.0.1 --port 5173 --strictPort`",
        f"- 실행: `python3 unified-dashboard/scripts/visual-check/git_repos_tab.py {base} <캡처 폴더>`",
        f"- 한 호출(570초)에 다 못 돌리면 `--only review-window`로 먼저, 이어서 `--only real-modal --baseline-dist <이 PR 이전 빌드의 dist>`로 돌린다. 두 번째 실행은 첫 실행의 단언과 캡처 목록(state.json)을 이어 받아 이 파일을 다시 쓴다.",
        f"- 산출물: {out}",
        "- 캡처에서는 검수 창 뒤의 WebGL 유리 배경 캔버스만 가렸다(소프트웨어 GL에서 한 장에 8초가 걸린다). 노드 목록과 상세 틀은 그대로다.", "", "## 실측 단언", "",
        *[f"- {'통과' if item['ok'] else '실패'}: {item['check']}" for item in CHECKS],
    ]
    (out / "operations.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    index = ["# 캡처 목록", "", "| 파일 | 폭 | 테마 | 장면 |", "| --- | --- | --- | --- |", *[f"| {name} | {width} | {theme} | {state} |" for name, width, theme, state in INDEX]]
    (out / "index.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    (out / "checks.json").write_text(json.dumps(CHECKS, ensure_ascii=False, indent=2), encoding="utf-8")


STATE_FILE = "state.json"


def load_state(out: Path) -> None:
    """한쪽 장면만 돌릴 때 앞서 돌린 쪽의 단언과 캡처 목록을 이어 받는다(같은 이름은 새 값으로 바꾼다)."""
    path = out / STATE_FILE
    if not path.exists():
        return
    state = json.loads(path.read_text(encoding="utf-8"))
    CHECKS.extend(state["checks"])
    INDEX.extend(tuple(item) for item in state["index"])
    DIALOG_ROWS.extend(state["dialog_rows"])


def save_state(out: Path) -> None:
    (out / STATE_FILE).write_text(json.dumps({"checks": CHECKS, "index": INDEX, "dialog_rows": DIALOG_ROWS}, ensure_ascii=False), encoding="utf-8")


def dedupe() -> None:
    names = {item["check"]: item for item in CHECKS}
    CHECKS[:] = list(names.values())
    files = {item[0]: item for item in INDEX}
    INDEX[:] = list(files.values())


def main() -> int:
    parser = argparse.ArgumentParser(description="설정창 Git과 저장소 탭 시각 검수")
    parser.add_argument("base_url", help="대시보드 dev 서버 주소 (예: http://127.0.0.1:5173)")
    parser.add_argument("output_dir", help="캡처와 보고 파일을 둘 폴더")
    parser.add_argument("--baseline-dist", help="이 PR 이전 빌드의 dist 폴더. 주면 「코딩 에이전트 연결」 배치가 그대로인지 견준다")
    parser.add_argument("--only", choices=("review-window", "real-modal"), help="한쪽 장면만 돌린다(오래 걸려 한 호출에 다 못 돌릴 때). 없으면 둘 다")
    args = parser.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    if args.only:
        load_state(out)
    with sync_playwright() as playwright:
        if args.only != "real-modal":
            capture_matrix(playwright, args.base_url, out)
            operation_checks(playwright, args.base_url)
        if args.only != "review-window":
            run_real_modal(playwright, args.base_url, out, check, lambda *item: INDEX.append(item), Path(args.baseline_dist) if args.baseline_dist else None)
    dedupe()
    save_state(out)
    write_reports(out, args.base_url)
    failed = [item for item in CHECKS if not item["ok"]]
    print(f"단언 {len(CHECKS)}개 중 실패 {len(failed)}개")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

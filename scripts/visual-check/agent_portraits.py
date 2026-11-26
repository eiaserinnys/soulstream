#!/usr/bin/env python3
"""중앙 에이전트 초상: 설정창 에이전트 탭의 YAML 전용 에이전트 화면과 세션 목록의 초상을 찍는다.

카드 #1864. 운영 형태의 데이터(에이전트 여럿, 초상 있는 것과 없는 것, 노드마다 초상 사본이 다른 YAML 전용 에이전트)를
가짜 서버 응답으로 내려, 바꾸기 전(--baseline-dist)과 뒤(--dist)를 같은 장면으로 찍는다.
초상 바이트는 이 노드의 작업 폴더에 있는 실제 초상 파일을 줄여서 쓴다. 파일이 없으면 단색 그림으로 대신한다.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

import settings_toolbar_fakes as fakes  # noqa: E402
from settings_toolbar_fakes import CHECKS, DIST, Fake, check, new_page, open_settings, serve  # noqa: E402

WORKSPACE = Path(__file__).resolve().parents[4]
WORKSPACE_PORTRAITS = [
    WORKSPACE / "seosoyoung/portrait/agent.png",
    WORKSPACE / "roselin_codex/portrait/agent.png",
    WORKSPACE / "keke/portrait/agent.png",
    WORKSPACE / "seosoyoung/portrait/user.png",
]
FALLBACK_COLORS = ["#c0617a", "#4a7bd0", "#58a37a", "#c9a24b"]
NODE_A, NODE_B = "silent-manari-ts", "eiaserinnys"
INDEX: list[tuple[str, int, str]] = []
OPEN_DASHBOARD = {"openOnStart": False, "lastSessionId": None, "showWeeklyUsage": False, "weeklyUsageNodeSelection": None}


def portrait_bytes(slot: int) -> bytes:
    source = WORKSPACE_PORTRAITS[slot % len(WORKSPACE_PORTRAITS)]
    buffer = io.BytesIO()
    if source.exists():
        image = Image.open(source).convert("RGBA")
        image.thumbnail((512, 512))
        image.save(buffer, format="PNG")
    else:
        Image.new("RGB", (256, 256), FALLBACK_COLORS[slot % len(FALLBACK_COLORS)]).save(buffer, format="PNG")
    return buffer.getvalue()


# agent_id -> (이름, 중앙 프로필 행 여부, 초상 칸, 노드 A가 가진 사본 여부)
AGENTS = {
    "seosoyoung": ("서소영", True, 0, True),
    "roselin": ("로젤린", True, 1, True),
    "keke": ("키키", True, 2, True),
    "remiel": ("레미엘", True, None, True),
    "blossom": ("블로썸", False, 3, False),
    "bubbles": ("버블", False, 1, False),
    "buttercup": ("버터컵", False, None, False),
    "utonium": ("유토니움", False, 0, False),
}
BYTES = {agent: portrait_bytes(slot) for agent, (_n, _c, slot, _a) in AGENTS.items() if slot is not None}
SHA = {agent: hashlib.sha256(body).hexdigest() for agent, body in BYTES.items()}


def profile_row(agent_id: str) -> dict:
    name, _central, slot, _copy = AGENTS[agent_id]
    return {
        "agent_id": agent_id, "name": name, "context_bundles": [], "atom_contexts": [], "effective_atom_contexts": [],
        "default_preset": None, "aliases": [], "has_portrait": slot is not None,
        "portrait": {"mime": "image/png", "size": len(BYTES[agent_id]), "sha256": SHA[agent_id]} if slot is not None else None,
        "version": 2, "created_at": "2026-11-01T00:00:00.000Z", "updated_at": "2026-11-20T00:00:00.000Z",
    }


class PortraitFake(Fake):
    """after=True면 서버가 중앙 버전 주소를, False면 바꾸기 전의 노드 주소를 낸다."""

    def __init__(self, after: bool, **kwargs):
        super().__init__(**kwargs)
        self.after = after
        self.portraits = dict(BYTES)
        self.uploaded: dict[str, bytes] = {}

    def node_list(self):
        node = {**fakes.NODE, "status": "connected"}
        return [{**node, "nodeId": NODE_A, "port": 4205}, {**node, "nodeId": NODE_B, "port": 3105}]

    def central_url(self, agent_id: str) -> str:
        body = self.portraits.get(agent_id)
        return "" if body is None else f"/api/agent-portraits/{agent_id}?v={hashlib.sha256(body).hexdigest()}"

    def node_agent_url(self, node_id: str, agent_id: str) -> str:
        if self.after:
            return self.central_url(agent_id)
        _name, central, slot, copy = AGENTS[agent_id]
        # 바꾸기 전: 중앙 행이 있거나 그 노드가 사본을 올린 에이전트만 주소가 있다.
        if slot is None or not (central or copy or node_id == NODE_B):
            return ""
        return f"/api/nodes/{node_id}/agents/{agent_id}/portrait"

    def session_row(self, session_id: str, agent_id: str, node_id: str, title: str) -> dict:
        name = AGENTS[agent_id][0]
        return {
            "agentSessionId": session_id, "displayName": title, "status": "running", "eventCount": 12, "agentId": agent_id,
            "agentName": name, "nodeId": node_id, "backend": "claude", "agentPortraitUrl": self.node_agent_url(node_id, agent_id) or None,
            "createdAt": "2026-11-25T01:00:00Z", "updatedAt": "2026-11-25T03:00:00Z", "lastEventId": 12, "lastReadEventId": 12,
            "prompt": f"{title} 작업을 이어서 합니다.", "folderId": "folder-1",
        }

    def session_rows(self) -> list[dict]:
        return [
            self.session_row("s-blossom", "blossom", NODE_A, "조사 꾸러미 정리"),
            self.session_row("s-bubbles", "bubbles", NODE_A, "배포 확인"),
            self.session_row("s-keke", "keke", NODE_A, "키키와 점심 메뉴"),
            self.session_row("s-buttercup", "buttercup", NODE_A, "수습 작업"),
            self.session_row("s-utonium", "utonium", NODE_A, "카드 담당 회의"),
            self.session_row("s-roselin", "roselin", NODE_B, "구현 위임"),
        ]

    def handle(self, route):
        request = route.request
        path = fakes.urlsplit(request.url).path
        method = request.method
        if path == "/api/agent-portraits" and method == "GET":
            self.calls.append((method, path))
            body = json.dumps({"portraits": [
                {"agent_id": agent, "sha256": hashlib.sha256(data).hexdigest(), "mime": "image/png", "byte_size": len(data),
                 "updated_at": "2026-11-25T00:00:00.000Z", "url": self.central_url(agent)}
                for agent, data in sorted(self.portraits.items())
            ]})
            etag = '"' + hashlib.sha256(body.encode()).hexdigest() + '"'
            if request.headers.get("if-none-match") == etag:
                return route.fulfill(status=304, headers={"etag": etag})
            return route.fulfill(body=body, content_type="application/json", headers={"etag": etag, "cache-control": "private, no-cache"})
        if path.startswith("/api/agent-portraits/"):
            agent_id = fakes.urlsplit(request.url).path.rsplit("/", 1)[-1]
            self.calls.append((method, path))
            if method == "PUT":
                payload = request.post_data_json
                import base64
                self.portraits[agent_id] = base64.b64decode(payload["data_base64"])
                digest = hashlib.sha256(self.portraits[agent_id]).hexdigest()
                return route.fulfill(json={"agent_id": agent_id, "sha256": digest, "mime": payload["mime"], "byte_size": len(self.portraits[agent_id]),
                                           "updated_at": "2026-11-25T04:00:00.000Z", "url": self.central_url(agent_id)})
            if method == "DELETE":
                self.portraits.pop(agent_id, None)
                return route.fulfill(status=204)
            data = self.portraits.get(agent_id)
            if data is None:
                return route.fulfill(status=404, json={"detail": "Portrait not found"})
            return route.fulfill(body=data, content_type="image/png", headers={"etag": f'"{hashlib.sha256(data).hexdigest()}"'})
        if path.startswith("/api/nodes/") and path.endswith("/portrait") and "/agents/" in path:
            parts = path.split("/")
            node_id, agent_id = parts[3], parts[5]
            url = self.node_agent_url(node_id, agent_id)
            data = self.portraits.get(agent_id)
            if not url or data is None or (not self.after and node_id == NODE_A and not AGENTS[agent_id][1] and not AGENTS[agent_id][3]):
                return route.fulfill(status=204)
            return route.fulfill(body=data, content_type="image/png")
        if path.startswith("/api/agent-profiles/") and path.endswith("/portrait"):  # 바꾸기 전 화면이 쓰는 중앙 행 초상 주소
            data = self.portraits.get(path.split("/")[3])
            return route.fulfill(status=204) if data is None else route.fulfill(body=data, content_type="image/png")
        if path == "/api/agent-profiles":
            return route.fulfill(json={"profiles": [profile_row(agent) for agent, row in AGENTS.items() if row[1]]})
        if path == "/api/context-bundles":
            return route.fulfill(json={"bundles": []})
        if path.startswith("/api/nodes/") and path.endswith("/agents") and path.count("/") == 4:
            node_id = path.split("/")[3]
            agents = []
            for agent_id, (name, central, _slot, _copy) in AGENTS.items():
                agents.append({"id": agent_id, "name": name, "portraitUrl": self.node_agent_url(node_id, agent_id), "backend": "claude",
                               "max_turns": None, "source": "db" if central else "yaml"})
            return route.fulfill(json={"agents": agents})
        if path.endswith("/agents/context-preview"):
            return route.fulfill(json={"manifest": {"sources": []}, "sections": [], "assembled": "", "atom_base_url": None})
        if path == "/api/folders":
            folder = {"id": "folder-1", "name": "✨ 소울스트림", "sortOrder": 0, "status": "open", "version": 1, "archived": False}
            return route.fulfill(json={"folders": [folder], "sessions": {row["agentSessionId"]: {"folderId": "folder-1", "displayName": row["displayName"]} for row in self.session_rows()}})
        if path == "/api/cards":
            return route.fulfill(json={"cards": []})
        if path == "/api/planner/starred-folders":
            return route.fulfill(json={"items": [], "nextCursor": None})
        if path == "/api/sessions":
            rows = self.session_rows()
            return route.fulfill(json={"sessions": rows, "total": len(rows)})
        if path == "/api/sessions/stream":
            rows = self.session_rows()
            return route.fulfill(content_type="text/event-stream", body=f"event: session_list\ndata: {json.dumps({'type': 'session_list', 'sessions': rows, 'total': len(rows)})}\n\n")
        return super().handle(route)


def shot(page, out: Path, name: str, width: int, state: str, locator=None):
    (locator if locator is not None else page).screenshot(path=str(out / name), animations="disabled")
    INDEX.append((name, width, state))


def open_agents_tab(page):
    open_settings(page)
    nav = page.locator('[data-testid="config-category-nav"]')
    if not nav.is_visible():  # 좁은 폭에서는 상세 쪽이 먼저 열려 있다.
        page.get_by_role("button", name="모든 설정").click()
    nav.get_by_role("button", name="에이전트 프로필", exact=True).click()
    expect(page.get_by_test_id("agent-profile-settings")).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)


def pick_node_agent(page, name: str):
    """좁은 폭에서는 위쪽 선택 칸으로, 넓은 폭에서는 왼쪽 목록으로 YAML 전용 에이전트를 고른다."""
    wide = page.locator("aside button", has_text=name)
    if wide.count() and wide.first.is_visible():
        wide.first.click()
    else:
        page.get_by_label("프로필", exact=True).select_option(label=name)
    page.wait_for_timeout(500)


def capture_settings(browser, base, out: Path, prefix: str, after: bool):
    for width in (1440, 390):
        fake = PortraitFake(after=after)
        context, page = new_page(browser, base, fake, width, height=900 if width > 600 else 844)
        page.goto(base + "/", wait_until="domcontentloaded")
        expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
        open_agents_tab(page)
        dialog = page.locator('[data-slot="dialog-popup"]')
        pick_node_agent(page, "블로썸")
        shot(page, out, f"{prefix}settings-yaml-agent-{width}.png", width, "설정창 에이전트 탭, 노드 설정 전용 에이전트(블로썸)를 고른 화면", dialog if width > 600 else None)
        if after:
            page.get_by_role("tab", name="편집", exact=True).click()
            expect(page.get_by_role("tab", name="편집", exact=True)).to_have_attribute("aria-selected", "true")
            page.wait_for_timeout(300)
            check(f"노드 설정 전용 에이전트의 편집 탭에 초상 칸이 보임 {width}px", page.get_by_label("초상화", exact=True).count() == 1, width)
            check(f"블로썸의 초상이 중앙 버전 주소로 보임 {width}px", page.locator('[data-testid="agent-profile-editor"] img').first.get_attribute("src") == fake.central_url("blossom"), width)
            shot(page, out, f"{prefix}settings-yaml-agent-portrait-{width}.png", width, "같은 에이전트의 편집 탭: 초상을 올리고 지우는 칸", dialog if width > 600 else None)
            if width == 1440:
                # 운영처럼 파일을 골라 올리고 목록과 미리보기가 새 버전 주소로 바뀌는지 본다.
                replacement = portrait_bytes(2)
                page.get_by_label("초상화", exact=True).set_input_files({"name": "new.png", "mimeType": "image/png", "buffer": replacement})
                page.get_by_role("button", name="초상화 저장").click()
                expect(page.locator('[data-testid="agent-profile-editor"] [role="status"]')).to_contain_text("초상화를 저장했습니다.", timeout=10000)
                new_url = f"/api/agent-portraits/blossom?v={hashlib.sha256(replacement).hexdigest()}"
                expect(page.locator('[data-testid="agent-profile-editor"] img').first).to_have_attribute("src", new_url, timeout=10000)
                expect(page.locator("aside button", has_text="블로썸").locator("img")).to_have_attribute("src", new_url, timeout=10000)
                check("올린 뒤 미리보기와 목록이 새 버전 주소로 바뀜", True, new_url)
        context.close()


def capture_session_list(browser, base, out: Path, prefix: str, after: bool):
    width = 1440
    fake = PortraitFake(after=after)
    context, page = new_page(browser, base, fake, width, height=900, preferences=OPEN_DASHBOARD)
    page.goto(base + "/", wait_until="domcontentloaded")
    expect(page.get_by_test_id("v3-global-toolbar")).to_be_visible(timeout=20000)
    page.wait_for_timeout(1500)
    shot(page, out, f"{prefix}session-list-{width}.png", width, "세션 목록: 노드 silent-manari-ts의 YAML 전용 에이전트 세션들")
    images = page.locator("main img, [data-testid] img").evaluate_all("els => els.map(e => ({src: e.getAttribute('src'), w: e.naturalWidth}))")
    INDEX.append((f"{prefix}session-list-images.json", width, json.dumps(images, ensure_ascii=False)))
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--dist", default=str(DIST))
    parser.add_argument("--baseline-dist")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    scenes = [("", Path(args.dist), True)]
    if args.baseline_dist:
        scenes.append(("baseline-", Path(args.baseline_dist), False))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for prefix, dist, after in scenes:
            server, base = serve(dist)
            try:
                capture_settings(browser, base, out, prefix, after)
                capture_session_list(browser, base, out, prefix, after)
            finally:
                server.shutdown()
        browser.close()
    (out / "agent-portraits-index.json").write_text(json.dumps({"shots": INDEX, "checks": CHECKS}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"shots": [name for name, _w, _s in INDEX], "checks": len(CHECKS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

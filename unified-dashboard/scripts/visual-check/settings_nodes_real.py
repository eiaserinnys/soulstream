#!/usr/bin/env python3
"""운영 `/cogito/briefs` 응답(노드 4개)으로 설정 화면의 cogito 행을 잰다.

샘플 화면(`/dialogues?sample=settings`)이 쓰는 표본 모듈(`CogitoNodeHealthSample.ts`)만 브라우저에서
갈아 끼워, 표본 카드 두 장(`sample-node`, `sample-usage-node`)에 운영 응답 노드를 두 개씩 나눠 싣는다.
두 번 돌면 운영 응답의 노드 4개가 모두 측정된다. 워크트리 코드는 바꾸지 않고 브라우저 요청만 갈아 끼운다.

실행

    python3 -P unified-dashboard/scripts/visual-check/settings_nodes_real.py \
        http://127.0.0.1:5173 /path/to/output-real /path/to/real-cogito-briefs.json

`real-cogito-briefs.json`은 운영 `/cogito/briefs` 응답을 그대로 저장한 파일이다(저장소에 넣지 않는다).

산출물

    {출력}/real-{nodeId}-{폭}-{테마}.png        운영 노드를 실은 카드를 펼치고 cogito 행을 화면 안에 들인 화면
    {출력}/real-card-{nodeId}-{폭}-{테마}.png   그 노드 카드 전체(머리부터 cogito까지)
    {출력}/real-zoom-startline-1280-dark.png    첫 노드의 cogito 행과 이웃 행 시작선 확대
    {출력}/real-measurements.json               노드별 측정
    {출력}/real-report.json                     판정과 종료 코드

운영 응답 노드 4개가 모두 서고, 점 크기·라벨 시작선·시각 HH:MM·배지 규칙·진단 값 선택·360 줄바꿈·
이름 표시가 어긋나면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))

from settings_nodes import (  # noqa: E402
    DETAIL_JS,
    HEAD_TIME_PATTERN,
    NAME_MIN_WIDTH_NARROW_PX,
    NAME_TRUNCATION_TOLERANCE_PX,
    NARROW,
    START_LABEL_DELTA_MAX_PX,
    THEMES,
    TIME_PATTERN,
    WIDE,
    card_for,
    expand_node,
    new_context,
    selection_probe,
    settle,
    sha256,
    shot,
    visible_head_time,
)

# 표본 카드 두 장에 운영 노드를 두 개씩 나눠 싣는다. 표본 노드 id는 화면이 행을 찾는 열쇠라 그대로 둔다.
CARD_IDS = ("sample-node", "sample-usage-node")
BADGE_BY_STATUS = {
    "ok": None,
    "timeout": "c724-badge-warn",
    "unavailable": "c724-badge-warn",
    "error": "c724-badge-danger",
}


def module_handler(source: str):
    # Playwright는 라우트 핸들러를 (route, request)로 부른다. 두 번째 인자를 흘려보낸다.
    def handle(route, *args) -> None:
        route.fulfill(status=200, content_type="application/javascript", body=source)

    return handle


def sample_module(real: dict, mapping: dict[str, str]) -> str:
    by_id = {node["node_id"]: node for node in real["nodes"]}
    mapped = {card: by_id[node_id] for card, node_id in mapping.items()}
    return (
        "const REAL = " + json.dumps(real, ensure_ascii=False) + ";\n"
        "const MAP = " + json.dumps(mapped, ensure_ascii=False) + ";\n"
        "export function sampleCogitoBriefs(nodes) {\n"
        "  return {...REAL, node_count: nodes.length, nodes: nodes.map((n) => ({...(MAP[n.nodeId] || REAL.nodes[0]), node_id: n.nodeId}))};\n"
        "}\n"
    )


def scroll_row_into_view(page: Page, card_id: str) -> None:
    # 펼친 뒤 공급자 패널이 자라 행이 푸터 아래로 밀리면 block: 'end'만으로는 부족하다.
    # 상세의 아래 끝을 넘은 만큼 scrollTop을 더 밀어 올린다.
    card_for(page, card_id).evaluate(
        """
        (card) => {
          const detail = document.querySelector('.config-detail');
          const row = card.querySelector('[data-testid="cogito-node-health"]');
          if (!detail || !row) return;
          row.scrollIntoView({block: 'end'});
          const rowBox = row.getBoundingClientRect();
          const detailBox = detail.getBoundingClientRect();
          const below = rowBox.bottom - detailBox.bottom;
          if (below > 0) detail.scrollTop += below;
        }
        """
    )
    page.wait_for_timeout(350)


def row_locator(page: Page, card_id: str) -> Locator:
    return card_for(page, card_id).locator('[data-testid="cogito-node-health"]').first


def measure_selection(page: Page, card_id: str) -> dict:
    row = row_locator(page, card_id)
    result: dict = {"lines": [], "label": None}
    count = row.locator(".c724-meta-inline, .c724-pool-error").count()
    for index in range(count):
        line = row.locator(".c724-meta-inline, .c724-pool-error").nth(index)
        text = (line.inner_text() or "").strip()
        result["lines"].append(selection_probe(page, line, text[:30]))
    result["label"] = selection_probe(page, row.locator(".c724-account-email").first, "label")
    return result


def open_settings_nodes(page: Page, base: str) -> None:
    page.goto(f"{base}/dialogues?sample=settings")
    settle(page)
    page.get_by_role("button", name="노드", exact=True).click()
    page.wait_for_selector('[data-testid="node-card-list"]', state="visible")


def add_real_assertions(measurements: dict, expected_status: dict[str, str]) -> dict:
    failures: dict[str, list] = {
        "rowsPresent": [],
        "startLine": [],
        "timeFormat": [],
        "selection": [],
        "wrapAndDependencies": [],
        "nameVisibility": [],
        "badges": [],
    }
    items: dict = {}
    measured_ids: set[str] = set()

    for key, entry in measurements["nodes"].items():
        if not entry.get("opened"):
            failures["rowsPresent"].append({"capture": key, "where": "settingsDidNotOpen"})
            continue
        for node_id, data in entry.get("rows", {}).items():
            measured_ids.add(node_id)
            detail = data.get("detail")
            if not detail or not detail.get("row"):
                failures["rowsPresent"].append({"capture": key, "node": node_id, "where": "missingRow"})
                continue
            row = detail["row"]
            head = detail.get("head", {})
            neighbors = [neighbor for neighbor in detail.get("neighbors", []) if neighbor.get("label")]
            item = {
                "dot": row.get("dot"),
                "label": row.get("label"),
                "head": head,
                "neighbors": neighbors,
                "status": expected_status.get(node_id),
            }
            items[f"{key}:{node_id}"] = item

            dot = row.get("dot")
            label = row.get("label")
            if not dot or "c724-status-dot" not in (dot.get("cls") or ""):
                failures["startLine"].append({"capture": key, "node": node_id, "where": "dotClass", "dot": dot})
            if not label:
                failures["startLine"].append({"capture": key, "node": node_id, "where": "missingLabel"})
            for neighbor in neighbors:
                neighbor_dot = neighbor.get("dot")
                neighbor_label = neighbor.get("label")
                if dot and neighbor_dot and (abs(dot["w"] - neighbor_dot["w"]) > 0.1 or abs(dot["h"] - neighbor_dot["w"]) > 0.1):
                    failures["startLine"].append({"capture": key, "node": node_id, "where": "dotSize", "dot": dot, "neighbor": neighbor_dot})
                if label and neighbor_label and abs(label["x"] - neighbor_label["x"]) > START_LABEL_DELTA_MAX_PX:
                    failures["startLine"].append({"capture": key, "node": node_id, "where": "labelLeft", "labelX": label["x"], "neighborX": neighbor_label["x"]})

            metas = row.get("metas", [])
            service = metas[0]["text"] if metas else ""
            if not TIME_PATTERN.match(service):
                failures["timeFormat"].append({"capture": key, "node": node_id, "where": "cogitoTimeFormat", "service": service})
            if "AM" in service or "PM" in service or re.search(r"\d{2}:\d{2}:\d{2}", service):
                failures["timeFormat"].append({"capture": key, "node": node_id, "where": "cogitoTimeNot24h", "service": service})
            head_time = head.get("time")
            if head_time and visible_head_time(detail):
                if not HEAD_TIME_PATTERN.match(head_time.get("text", "")):
                    failures["timeFormat"].append({"capture": key, "node": node_id, "where": "headTimeFormat", "head": head_time})
                if "AM" in head_time.get("text", "") or "PM" in head_time.get("text", "") or re.search(r"\d{2}:\d{2}:\d{2}", head_time.get("text", "")):
                    failures["timeFormat"].append({"capture": key, "node": node_id, "where": "headTimeNot24h", "head": head_time})

            status = expected_status.get(node_id)
            expected_badge = BADGE_BY_STATUS.get(status, None) if status is not None else "unknown"
            badge = row.get("badge")
            if expected_badge == "unknown":
                failures["badges"].append({"capture": key, "node": node_id, "where": "unknownStatus", "status": status})
            elif expected_badge is None and badge is not None:
                failures["badges"].append({"capture": key, "node": node_id, "where": "unexpectedBadge", "badge": badge})
            elif expected_badge is not None and (badge is None or expected_badge not in (badge.get("cls") or "")):
                failures["badges"].append({"capture": key, "node": node_id, "where": "badgeMismatch", "expected": expected_badge, "badge": badge})

            if key.startswith(str(NARROW)):
                for meta in metas:
                    line_height = float(meta.get("lineHeight", "0").replace("px", "") or 0)
                    rendered_lines = round(meta["h"] / line_height, 1) if line_height else 0
                    if meta["whiteSpace"] != "normal":
                        failures["wrapAndDependencies"].append({"capture": key, "node": node_id, "where": "whiteSpace", "text": meta["text"]})
                    if meta["scrollW"] - meta["clientW"] > 0.5:
                        failures["wrapAndDependencies"].append({"capture": key, "node": node_id, "where": "horizontalOverflow", "text": meta["text"], "scrollW": meta["scrollW"], "clientW": meta["clientW"]})
                    if meta["text"].startswith("runtime ") and rendered_lines < 2:
                        failures["wrapAndDependencies"].append({"capture": key, "node": node_id, "where": "runtimeDidNotWrap", "line": meta})
                deps = [meta for meta in metas if meta["text"].startswith("deps ")]
                if not deps:
                    failures["wrapAndDependencies"].append({"capture": key, "node": node_id, "where": "missingDependencies"})
                elif "orchestrator" not in deps[0]["text"]:
                    failures["wrapAndDependencies"].append({"capture": key, "node": node_id, "where": "missingOrchestratorDependency", "text": deps[0]["text"]})

            name = head.get("name")
            time = head.get("time")
            head_extras = [
                child for child in head.get("children", [])
                if child.get("display") != "none"
                and (
                    "c724-badge" in (child.get("cls") or "")
                    or (child.get("text") or "").endswith("갱신")
                )
            ]
            if not name:
                failures["nameVisibility"].append({"capture": key, "node": node_id, "where": "missingName"})
            else:
                truncated = name.get("textW", 0) > name.get("w", 0) + NAME_TRUNCATION_TOLERANCE_PX
                item["nameTruncated"] = truncated
                item["headVisibleExtras"] = head_extras
                if key.startswith(str(WIDE)) and truncated:
                    failures["nameVisibility"].append({"capture": key, "node": node_id, "where": "nameTruncatedAtWide", "name": name})
                if key.startswith(str(NARROW)):
                    # 360에서는 이름이 폭을 먼저 갖고, 시각 글과 배지는 머리에서 물러난다.
                    if time and time.get("display") != "none":
                        failures["nameVisibility"].append({"capture": key, "node": node_id, "where": "timeStillVisibleAt360", "time": time})
                    if head_extras:
                        failures["nameVisibility"].append({"capture": key, "node": node_id, "where": "headExtrasVisibleAt360", "extras": head_extras})
                    if name.get("w", 0) < NAME_MIN_WIDTH_NARROW_PX:
                        failures["nameVisibility"].append({"capture": key, "node": node_id, "where": "nameBoxTooNarrow", "name": name, "minimum": NAME_MIN_WIDTH_NARROW_PX})

        for node_id, probe in entry.get("selection", {}).items():
            for line in probe.get("lines", []):
                if line.get("error"):
                    failures["selection"].append({"capture": key, "node": node_id, "where": "lineError", "line": line})
                    continue
                if line.get("userSelect") != "text":
                    failures["selection"].append({"capture": key, "node": node_id, "where": "lineUserSelect", "line": line})
                if not line.get("dblclickSelection") or not line.get("dragSelection"):
                    failures["selection"].append({"capture": key, "node": node_id, "where": "lineNotSelectable", "line": line})
            label = probe.get("label")
            if not label or label.get("error"):
                failures["selection"].append({"capture": key, "node": node_id, "where": "labelMissing", "label": label})
            elif label.get("dblclickSelection") or label.get("dragSelection"):
                failures["selection"].append({"capture": key, "node": node_id, "where": "labelSelectable", "label": label})

    missing = sorted(set(expected_status) - measured_ids)
    if missing:
        failures["rowsPresent"].append({"where": "missingOperatingNodes", "nodeIds": missing})

    return {
        "realNodesPresent": {"passed": not failures["rowsPresent"], "failures": failures["rowsPresent"], "measuredNodeIds": sorted(measured_ids)},
        "realStartLine": {"passed": not failures["startLine"], "failures": failures["startLine"], "items": items},
        "realTimeFormat": {"passed": not failures["timeFormat"], "failures": failures["timeFormat"]},
        "realSelection": {"passed": not failures["selection"], "failures": failures["selection"]},
        "realWrapAndDependencies": {"passed": not failures["wrapAndDependencies"], "failures": failures["wrapAndDependencies"]},
        "realNameVisibility": {"passed": not failures["nameVisibility"], "failures": failures["nameVisibility"]},
        "realBadges": {"passed": not failures["badges"], "failures": failures["badges"]},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="운영 cogito 응답으로 설정 노드 구역 검수")
    parser.add_argument("base_url")
    parser.add_argument("output_dir")
    parser.add_argument("real_briefs", help="운영 /cogito/briefs 응답 JSON")
    args = parser.parse_args()

    real = json.loads(Path(args.real_briefs).expanduser().read_text(encoding="utf-8"))
    node_ids = [node["node_id"] for node in real["nodes"]]
    if len(node_ids) < 4:
        raise SystemExit(f"운영 응답 노드가 {len(node_ids)}개입니다. 4개를 기대합니다.")
    expected_status = {node["node_id"]: node.get("status") for node in real["nodes"]}
    pass_maps = [
        dict(zip(CARD_IDS, node_ids[index:index + 2]))
        for index in range(0, 4, 2)
    ]

    base = args.base_url.rstrip("/")
    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    measurements: dict = {"nodes": {}, "captures": [], "passes": pass_maps}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in (WIDE, NARROW):
                for theme in THEMES:
                    key = f"{width}-{theme}"
                    for pass_index, mapping in enumerate(pass_maps):
                        source = sample_module(real, mapping)
                        context = new_context(browser, width, theme)
                        context.route("**/CogitoNodeHealthSample.ts*", module_handler(source))
                        page = context.new_page()
                        page.on("pageerror", lambda error: print(f"pageerror: {error}", file=sys.stderr))
                        entry: dict = {"opened": False, "rows": {}, "selection": {}, "mapping": mapping}
                        measurements["nodes"][f"{key}:pass{pass_index + 1}"] = entry
                        try:
                            open_settings_nodes(page, base)
                            entry["opened"] = True
                            for card_id, node_id in mapping.items():
                                expand_node(page, card_id)
                                row = row_locator(page, card_id)
                                row.wait_for(state="visible", timeout=15_000)
                                page.wait_for_timeout(700)
                                scroll_row_into_view(page, card_id)
                                detail = card_for(page, card_id).evaluate(DETAIL_JS)
                                capture = shot(page, out, f"real-{node_id}-{key}")
                                card_path = out / f"real-card-{node_id}-{key}.png"
                                card_for(page, card_id).screenshot(path=str(card_path), animations="disabled")
                                print(f"real-card-{node_id}-{key}: {card_path}")
                                measurements["captures"].extend([capture, card_path.as_posix()])
                                entry["rows"][node_id] = {"detail": detail, "sampleCard": card_id, "captures": {"page": capture, "card": card_path.as_posix()}}
                                if width == WIDE and theme == "dark":
                                    entry["selection"][node_id] = measure_selection(page, card_id)
                                if pass_index == 0 and card_id == CARD_IDS[0] and width == WIDE and theme == "dark":
                                    row_box = row.bounding_box()
                                    previous_box = card_for(page, card_id).locator("[data-provider-id]").last.bounding_box()
                                    if row_box and previous_box:
                                        zoom = out / "real-zoom-startline-1280-dark.png"
                                        page.screenshot(
                                            path=str(zoom),
                                            clip={
                                                "x": row_box["x"] - 4,
                                                "y": previous_box["y"] - 4,
                                                "width": 300,
                                                "height": (row_box["y"] - previous_box["y"]) + 44,
                                            },
                                            animations="disabled",
                                        )
                                        measurements["captures"].append(zoom.as_posix())
                                        print(f"real-zoom-startline-1280-dark: {zoom.as_posix()}")
                        finally:
                            context.close()
        finally:
            browser.close()

    assertions = add_real_assertions(measurements, expected_status)
    report = {
        "baseUrl": base,
        "realBriefs": str(Path(args.real_briefs).expanduser()),
        "realBriefsSha256": sha256(str(Path(args.real_briefs).expanduser())),
        "nodeIds": node_ids,
        "passes": pass_maps,
        "captures": measurements["captures"],
        "assertions": assertions,
    }
    report["passed"] = all(entry["passed"] for entry in assertions.values())

    (out / "real-measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "real-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for name, entry in assertions.items():
        print(f"{name}: {'통과' if entry['passed'] else '실패'}")
    if report["passed"]:
        print(f"판정: 운영 응답 {len(node_ids)}개 노드 통과 (캡처 {len(measurements['captures'])}장)")
        return 0
    print(json.dumps({name: entry.get("failures") for name, entry in assertions.items() if not entry["passed"]}, ensure_ascii=False, indent=2), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

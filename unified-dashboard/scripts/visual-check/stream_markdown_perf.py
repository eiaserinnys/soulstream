#!/usr/bin/env python3
"""스트리밍 마크다운 갱신 성능 측정 (카드 #1808).

`scripts/visual-check/stream-markdown-perf.html`이 세우는 표본에 2만 자를 넘는 한글
마크다운을 64자씩 덧붙인다. 갱신 한 번이 화면에 그려질 때까지(React 갱신을 flush한 뒤
다음 프레임 콜백까지)의 시간을 재어 p50, p95, max, 갱신 수를 찍는다.

준비

    # 저장소 루트에서
    VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \\
        --host 127.0.0.1 --port 5288 --strictPort

실행

    python3 -P unified-dashboard/scripts/visual-check/stream_markdown_perf.py \\
        http://127.0.0.1:5288 /path/to/perf

산출물

    {출력}/perf.json                     시간 목록과 통계, 콘솔 오류
    {출력}/stream-markdown-perf-final.png   마지막 갱신 화면

p95가 50ms를 넘거나, 콘솔 오류와 페이지 오류가 있거나, 스트리밍 본문이 words
마크다운으로 그려지지 않았으면 종료 코드 1로 끝난다.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

STEP_CHARS = 64
MIN_CHARS = 20_000
P95_LIMIT_MS = 50.0
HASH = "8c05d01e24f96b70a612750a4f45795bacdab636"


def build_markdown() -> str:
    """2만 자를 넘길 때까지 한글 문단, 목록, 표, 코드 블록을 이어 붙인다."""
    sections: list[str] = []
    index = 0
    length = 0
    while length <= MIN_CHARS + STEP_CHARS:
        index += 1
        sections.append(
            f"## 확인 항목 {index}\n\n"
            "정리한 결과를 보고합니다. 좁은 폭에서도 한글 낱말은 낱말 단위로 접힙니다. "
            "이 문단은 스트리밍 중에 계속 길어지며, 갱신마다 마크다운을 다시 읽습니다.\n\n"
            f"- 커밋 {HASH}의 변경분을 확인합니다.\n"
            f"- 링크 [변경 파일 목록](https://example.com/check/{index})도 함께 둡니다.\n"
            "- `corepack pnpm -C unified-dashboard exec vitest run`으로 확인합니다.\n\n"
            "| 항목 | 상태 |\n| --- | --- |\n"
            "| 줄바꿈을 확인합니다 | 확인합니다 |\n"
            "| 표 넘침을 확인합니다 | 확인합니다 |\n\n"
            "```ts\n"
            f"const value = {index};\n"
            "console.log(value);\n"
            "```\n"
        )
        length = len("\n\n".join(sections))
    return "\n\n".join(sections)


def percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    rank = max(1, math.ceil(fraction * len(sorted_values)))
    return sorted_values[rank - 1]


def run(args: argparse.Namespace) -> int:
    base = args.base.rstrip("/")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    markdown = build_markdown()
    if len(markdown) <= MIN_CHARS:
        print(f"perf: 표본이 {MIN_CHARS}자를 넘지 못했습니다 ({len(markdown)}자)", file=sys.stderr)
        return 1

    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(device_scale_factor=1)
        page = context.new_page()
        page.set_default_timeout(120_000)
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(
            f"{base}/scripts/visual-check/stream-markdown-perf.html",
            wait_until="load",
        )
        page.wait_for_function("() => window.__streamPerfReady === true", timeout=120_000)
        result = page.evaluate(
            "(payload) => window.__streamPerfRun(payload.markdown, payload.step)",
            {"markdown": markdown, "step": STEP_CHARS},
        )
        page.screenshot(
            path=str(output / "stream-markdown-perf-final.png"),
            animations="disabled",
            timeout=30_000,
        )
        browser.close()

    durations = [float(value) for value in result["durations"]]
    ordered = sorted(durations)
    stats = {
        "p50": percentile(ordered, 0.5),
        "p95": percentile(ordered, 0.95),
        "max": max(ordered) if ordered else 0.0,
    }
    expected_updates = len(markdown) // STEP_CHARS
    problems: list[str] = []
    if result["updates"] != expected_updates:
        problems.append(
            f"갱신 수가 맞지 않습니다 ({result['updates']}, 기대 {expected_updates})"
        )
    if not result["wordsRoot"]:
        problems.append("스트리밍 본문이 words 마크다운으로 그려지지 않았습니다")
    if result["renderedLength"] <= MIN_CHARS * 0.7:
        problems.append(
            f"마지막 화면의 글자가 너무 적습니다 ({result['renderedLength']}자)"
        )
    if stats["p95"] > P95_LIMIT_MS:
        problems.append(f"p95가 {P95_LIMIT_MS}ms를 넘었습니다 ({stats['p95']:.2f}ms)")
    if console_errors:
        problems.append(f"콘솔 오류 {len(console_errors)}건: {console_errors[0]}")
    if page_errors:
        problems.append(f"페이지 오류 {len(page_errors)}건: {page_errors[0]}")

    record = {
        "markdownLength": len(markdown),
        "stepChars": STEP_CHARS,
        "updates": result["updates"],
        "renderedLength": result["renderedLength"],
        "wordsRoot": result["wordsRoot"],
        "p50": stats["p50"],
        "p95": stats["p95"],
        "max": stats["max"],
        "limitMs": P95_LIMIT_MS,
        "durations": durations,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "problems": problems,
    }
    (output / "perf.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        f"perf: 표본 {len(markdown)}자, 갱신 {result['updates']}회, "
        f"p50={stats['p50']:.2f}ms p95={stats['p95']:.2f}ms max={stats['max']:.2f}ms"
    )
    if problems:
        for problem in problems:
            print(f"perf: {problem}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="스트리밍 마크다운 갱신 성능 측정 (카드 #1808)")
    parser.add_argument("base", help="개발 서버 주소 (예: http://127.0.0.1:5288)")
    parser.add_argument("output", help="측정 결과와 캡처를 남길 폴더")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())

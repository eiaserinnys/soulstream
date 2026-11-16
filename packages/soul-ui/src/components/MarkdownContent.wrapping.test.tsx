/**
 * 카드 #1342: 마크다운 한글 줄바꿈 공용 규칙의 표식과 first:/last: 판정.
 *
 * 공용 규칙은 블록을 감싸는 요소가 아니라 MarkdownContent가 그리는 맨 위 블록
 * 마다 붙는 표식(data-markdown-block)으로 건다. 감싸는 요소가 있으면 마크다운
 * 앞뒤에 형제가 있는 곳에서 first:/last: 여백 판정이 main과 달라진다.
 *
 * @vitest-environment jsdom
 */

import { createElement, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}

function renderMarkdown(content: string, props: Partial<Parameters<typeof MarkdownContent>[0]> = {}) {
  return mount(createElement(MarkdownContent, { content, ...props }));
}

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const everyBlock = [
  "# 제목 하나",
  "## 제목 둘",
  "### 제목 셋",
  "#### 제목 넷",
  "##### 제목 다섯",
  "###### 제목 여섯",
  "",
  "본문 문단입니다.",
  "",
  "- 목록 하나",
  "- 목록 둘",
  "",
  "1. 번호 하나",
  "2. 번호 둘",
  "",
  "> 인용문입니다.",
  "",
  "| 머리 | 값 |",
  "| --- | --- |",
  "| 칸 | 값 |",
  "",
  "```text",
  "코드",
  "```",
  "",
  "---",
].join("\n");

describe("MarkdownContent — common wrapping marker", () => {
  it.each([
    ["default", {}],
    ["compact", { compact: true }],
    ["blockquote copy", { enableBlockquoteCopy: true }],
  ] as const)("marks every top-level block in the %s layout", (_label, props) => {
    const host = renderMarkdown(everyBlock, props);
    const blocks = [...host.children];

    expect(blocks.map((block) => block.tagName)).toEqual([
      "H1", "H2", "H3", "H4", "H5", "H6",
      "P", "UL", "OL",
      // 복사 부품을 켜면 인용은 복사 틀 div가 맨 위 블록이 된다.
      "enableBlockquoteCopy" in props ? "DIV" : "BLOCKQUOTE",
      "DIV", "DIV", "HR",
    ]);
    for (const block of blocks) {
      expect(block.getAttribute("data-markdown-block")).toBe("true");
    }
    // 블록을 감싸는 요소가 없어야 first:/last: 판정이 main과 같다.
    expect(host.querySelector('[style*="display: contents"]')).toBeNull();
  });

  it("keeps the first and last block judgments of a plain markdown render when siblings surround it", () => {
    const host = mount(
      createElement(
        "div",
        null,
        createElement("p", { "data-testid": "before" }, "앞"),
        createElement(MarkdownContent, { content: "# 제목\n\n본문입니다." }),
        createElement("p", { "data-testid": "after" }, "뒤"),
      ),
    );
    const parent = host.firstElementChild!;
    const before = parent.querySelector('[data-testid="before"]')!;
    const heading = parent.querySelector("h1")!;
    const paragraph = parent.querySelector("p[data-markdown-block]")!;
    const after = parent.querySelector('[data-testid="after"]')!;

    // main과 같은 구조: 앞 형제, 마크다운 블록들, 뒤 형제가 한 부모 아래 나란히 선다.
    expect(parent.children).toHaveLength(4);
    expect(parent.firstElementChild).toBe(before);
    expect(parent.lastElementChild).toBe(after);
    // 마크다운이 첫 자식/끝 자식이 아니므로 first:mt-0과 last:mb-0이 적용되지 않는다.
    expect(heading.matches(":first-child")).toBe(false);
    expect(paragraph.matches(":last-child")).toBe(false);
  });
});

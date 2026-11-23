/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { StreamingMarkdown, preloadStreamingMarkdown } from "./StreamingMarkdown";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(async () => {
  await preloadStreamingMarkdown();
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(content: string): Promise<HTMLDivElement> {
  const element = document.createElement("div");
  document.body.appendChild(element);
  host = element;
  root = createRoot(element);
  await act(async () => {
    root?.render(createElement(StreamingMarkdown, { content }));
  });
  return element;
}

describe("StreamingMarkdown", () => {
  it("완성되지 않은 강조도 요소로 그린다", async () => {
    const element = await render("이건 **굵");

    expect(element.querySelector("strong")?.textContent).toBe("굵");
  });

  it("완성되지 않은 링크도 링크로 그린다", async () => {
    const element = await render("보세요 [문서](https://exa");

    const link = element.querySelector("a");
    expect(link?.textContent).toBe("문서");
    expect(link?.getAttribute("href")).toBeNull();
  });

  it("열린 코드 펜스를 코드 블록 요소로 그린다", async () => {
    const element = await render("```ts\nconst a = 1;");

    const block = element.querySelector('[data-markdown="code-block"]');
    const pre = block?.querySelector("pre");
    expect(block).not.toBeNull();
    expect(pre?.className).toContain("bg-input");
    expect(pre?.className).toContain("pr-9 min-h-9");
    expect(pre?.textContent).toContain("const a = 1;");
  });

  it("문단 안의 단일 줄바꿈을 br로 그린다", async () => {
    const element = await render("한 줄\n다음 줄");

    expect(element.querySelector("p br")).not.toBeNull();
  });

  it("코드 펜스 안의 줄바꿈은 그대로 둔다", async () => {
    const element = await render("```\na\nb\n```");

    const block = element.querySelector('[data-markdown="code-block"]');
    expect(block?.querySelectorAll("br").length).toBe(0);
    expect(block?.querySelector("code")?.textContent).toContain("a\nb");
  });

  it("링크에 완료 렌더와 같은 클래스와 target, rel을 단다", async () => {
    const element = await render("[문서](https://example.com)");

    const link = element.querySelector("a");
    expect(link?.className).toContain("text-accent-blue");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("javascript: 링크를 링크로 만들지 않는다", async () => {
    const element = await render("[위험](javascript:alert(1))");

    expect(element.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(element.innerHTML).not.toContain("javascript:");
  });

  it("원문 HTML을 요소로 넣지 않는다", async () => {
    const element = await render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">');

    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("[onerror]")).toBeNull();
  });

  it("스트리밍 중 이미지를 그리지 않는다", async () => {
    const element = await render("![그림](https://example.com/a.png)");

    expect(element.querySelector("img")).toBeNull();
  });

  it("표를 완료 렌더와 같은 스크롤 상자 안에 그린다", async () => {
    const element = await render("| 항목 | 상태 |\n| --- | --- |\n| 하나 | 확인 |");

    const table = element.querySelector("table");
    const wrapper = table?.parentElement;
    expect(wrapper?.className).toContain("overflow-auto my-2 rounded-floor border border-border bg-card");
    expect(wrapper?.getAttribute("data-markdown-block")).toBe("true");
    expect(table?.className).toContain("text-xs border-collapse w-full");
  });

  it("글 끝에 스트리밍 커서를 둔다", async () => {
    const element = await render("마지막 글자");

    expect(element.querySelector('[data-markdown="caret"]')).not.toBeNull();
  });
});

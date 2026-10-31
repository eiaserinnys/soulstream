/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderMarkdown(
  content: string,
  enableBlockquoteCopy = false,
  compact = false,
  codeBlockLayout: "bounded" | "document" = "bounded",
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(createElement(MarkdownContent, { content, enableBlockquoteCopy, compact, codeBlockLayout }));
  });
  return container;
}

function resetRender() {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

afterEach(() => {
  resetRender();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MarkdownContent blockquote copy", () => {
  it("marks every blockquote so nested code can share the no-scroll contract", () => {
    const standard = renderMarkdown("> ```text\n> 일반 코드\n> ```");

    expect(standard.querySelectorAll("blockquote")).toHaveLength(1);
    expect(standard.querySelectorAll("blockquote[data-markdown-blockquote]")).toHaveLength(1);

    resetRender();

    const compact = renderMarkdown("> ```text\n> 컴팩트 코드\n> ```", false, true);
    expect(compact.querySelectorAll("blockquote")).toHaveLength(1);
    expect(compact.querySelectorAll("blockquote[data-markdown-blockquote]")).toHaveLength(1);

    resetRender();

    const copyable = renderMarkdown("> 바깥\n>\n> > ```text\n> > 중첩 코드\n> > ```", true);
    expect(copyable.querySelectorAll("blockquote")).toHaveLength(2);
    expect(copyable.querySelectorAll("blockquote[data-markdown-blockquote]")).toHaveLength(2);
  });

  it("keeps non-chat Markdown opt-out by default", () => {
    const view = renderMarkdown("> 인용문");

    expect(view.querySelector('[aria-label="인용문 복사"]')).toBeNull();
  });

  it("renders one icon-only button for the top-level quote, including nested quotes", () => {
    const view = renderMarkdown("> 바깥\n>\n> > 안쪽", true);
    const buttons = view.querySelectorAll<HTMLButtonElement>('[aria-label="인용문 복사"]');

    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("");
    expect(buttons[0].querySelector("svg")).not.toBeNull();
  });

  it("copies only the rendered quote text and swaps the icon to a check", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown("> 첫 문단\n>\n> 둘째 [링크](https://example.com)", true);
    const content = view.querySelector<HTMLElement>('[data-slot="blockquote-copy-content"]')!;
    Object.defineProperty(content, "innerText", { configurable: true, value: "첫 문단\n\n둘째 링크" });

    view.querySelector<HTMLButtonElement>('[aria-label="인용문 복사"]')!.click();
    await vi.waitFor(() => {
      expect(view.querySelector('[data-copy-state="success"]')).not.toBeNull();
    });

    expect(writeText).toHaveBeenCalledWith("첫 문단\n\n둘째 링크");
    expect(view.querySelector('[role="status"]')?.textContent).toBe("인용문을 복사했습니다");
  });

  it("copies nested visible text through the single top-level control", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown("> 바깥\n>\n> > 안쪽", true);
    const content = view.querySelector<HTMLElement>('[data-slot="blockquote-copy-content"]')!;
    Object.defineProperty(content, "innerText", { configurable: true, value: "바깥\n\n안쪽" });

    view.querySelector<HTMLButtonElement>('[aria-label="인용문 복사"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("바깥\n\n안쪽"));

    expect(view.querySelectorAll('[aria-label="인용문 복사"]')).toHaveLength(1);
  });

  it("copies an empty rendered quote as an empty string", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown(">", true);
    const content = view.querySelector<HTMLElement>('[data-slot="blockquote-copy-content"]')!;
    Object.defineProperty(content, "innerText", { configurable: true, value: "" });

    view.querySelector<HTMLButtonElement>('[aria-label="인용문 복사"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(""));
  });

  it("announces clipboard failures without adding a visible text label", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown("> 거부된 인용문", true);

    view.querySelector<HTMLButtonElement>('[aria-label="인용문 복사"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    const feedback = view.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe("인용문을 복사하지 못했습니다");
    expect(feedback?.className).toContain("sr-only");
    expect(view.querySelector<HTMLButtonElement>('[aria-label="인용문 복사"]')?.textContent).toBe("");
  });
});

describe("MarkdownContent fenced code copy", () => {
  it("renders one icon-only copy button for fenced blocks with and without a language", () => {
    const view = renderMarkdown(["```ts", "const typed = true;", "```", "", "```", "plain", "```"].join("\n"));
    const buttons = view.querySelectorAll<HTMLButtonElement>('[aria-label="코드 복사"]');

    expect(buttons).toHaveLength(2);
    expect(Array.from(buttons).every(button => button.querySelector("svg") !== null)).toBe(true);
    expect(view.querySelectorAll('[data-slot="codeblock-copy-content"]')).toHaveLength(2);
    expect(view.querySelectorAll('[data-slot="codeblock-copy-frame"]')).toHaveLength(2);
    expect(view.querySelectorAll('[data-slot="codeblock-copy-content"].pr-9.min-h-9')).toHaveLength(2);
  });

  it("copies the code text while preserving leading spaces and removes one parser newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown("```ts\n  const value = 1;\n```\n");

    view.querySelector<HTMLButtonElement>('[aria-label="코드 복사"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("  const value = 1;"));
    await vi.waitFor(() => expect(view.querySelector('[data-copy-state="success"]')).not.toBeNull());
    expect(view.querySelector('[role="status"]')?.textContent).toBe("코드를 복사했습니다");
  });

  it("keeps document copy controls outside the horizontal scroll area", () => {
    const view = renderMarkdown("```text\nlong line\n```", false, false, "document");
    const frame = view.querySelector<HTMLElement>('[data-slot="codeblock-copy-frame"]')!;
    const scroll = frame.querySelector<HTMLElement>('[data-markdown-code-scroll="horizontal"]')!;

    expect(scroll.className).toContain("overflow-x-auto overflow-y-hidden");
    expect(scroll.querySelector('[data-markdown-code-layout="document"]')).not.toBeNull();
    expect(frame.querySelector('[aria-label="코드 복사"]')?.parentElement).toBe(frame);
    expect(frame.querySelector('[aria-label="코드 복사"]')?.closest('[data-markdown-code-scroll]')).toBeNull();
  });

  it("announces clipboard failures without changing the code block layout", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = renderMarkdown("```\nconst denied = true;\n```");
    const pre = view.querySelector<HTMLElement>('[data-slot="codeblock-copy-content"]')!;
    const className = pre.className;

    view.querySelector<HTMLButtonElement>('[aria-label="코드 복사"]')!.click();
    await vi.waitFor(() => {
      expect(view.querySelector('[data-copy-state="error"]')).not.toBeNull();
    });

    expect(view.querySelector('[role="status"]')?.textContent).toBe("코드를 복사하지 못했습니다");
    expect(pre.className).toBe(className);
  });
});

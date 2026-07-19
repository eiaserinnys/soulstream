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

function renderMarkdown(content: string, enableBlockquoteCopy = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(createElement(MarkdownContent, { content, enableBlockquoteCopy }));
  });
  return container;
}

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MarkdownContent blockquote copy", () => {
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

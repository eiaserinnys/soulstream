/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ToolCallGroup } from "./ToolCallGroup";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function message(index: number, state: "running" | "done" | "error" = "running"): ChatMessage {
  return {
    id: `tool-${index}`,
    role: "tool",
    content: `tool-${index}-${"아주 긴 라벨 ".repeat(8)}`,
    treeNodeId: `root-tool-${index}`,
    treeNodeType: "tool",
    toolResult: state === "done" ? "ok" : undefined,
    isError: state === "error",
  } as ChatMessage;
}

function renderGroup(messages: ChatMessage[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(ToolCallGroup, { messages })));
  return container;
}

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ToolCallGroup compact header", () => {
  it.each([
    [0, "Tool Calls 0", "실행 중"],
    [1, "Tool Calls 1", "실행 중"],
    [14, "Tool Calls 14", "완료"],
    [100, "Tool Calls 100", "실패"],
  ] as const)("renders %i calls with a one-line status", (count, countLabel, statusLabel) => {
    const state = statusLabel === "완료" ? "done" : statusLabel === "실패" ? "error" : "running";
    const view = renderGroup(Array.from({ length: count }, (_, index) => message(index, state)));
    const row = view.querySelector<HTMLElement>('[data-slot="chat-tool-row"]')!;
    const toggle = view.querySelector<HTMLButtonElement>('[data-slot="tool-call-group-toggle"]')!;

    expect(row.className).toContain("py-1");
    expect(toggle.className).toContain("h-6");
    expect(toggle.className).toContain("text-xs");
    expect(toggle.className).toContain("leading-[18px]");
    expect(toggle.textContent).toContain(countLabel);
    expect(toggle.textContent).toContain(statusLabel);
    expect(toggle.querySelectorAll("svg")).toHaveLength(2);
    expect(Array.from(toggle.querySelectorAll("svg")).every((icon) => icon.classList.contains("size-3.5"))).toBe(true);
  });

  it("preserves native keyboard activation and exposes expanded state", () => {
    const view = renderGroup([message(0, "done"), message(1, "done")]);
    const toggle = view.querySelector<HTMLButtonElement>('[data-slot="tool-call-group-toggle"]')!;

    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.querySelector('[data-slot="tool-call-group-items"]')).not.toBeNull();

    const itemToggle = view.querySelector<HTMLButtonElement>('[data-slot="tool-call-item-toggle"]')!;
    expect(itemToggle.type).toBe("button");
    expect(itemToggle.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => itemToggle.click());
    expect(itemToggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.querySelector('[data-slot="chat-tool-body"]')?.textContent).toBe("ok");
  });
});

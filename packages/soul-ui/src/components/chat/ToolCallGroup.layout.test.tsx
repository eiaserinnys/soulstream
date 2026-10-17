/**
 * @vitest-environment jsdom
 */

import { createElement, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ToolCallGroup } from "./ToolCallGroup";
import { ShowFullContentButton } from "./ShowFullContentButton";

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

const ControlledToolCallGroup = ToolCallGroup as ComponentType<{
  messages: ChatMessage[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}>;

const TruncationToolCallGroup = ToolCallGroup as ComponentType<{
  messages: ChatMessage[];
  expanded: boolean;
  sessionId: string;
  presentation?: "default" | "manuscript";
}>;

function ControlledGroupHost({ messages, rowKey }: { messages: ChatMessage[]; rowKey: string }) {
  const [expanded, setExpanded] = useState(false);
  return createElement("div", { key: rowKey }, createElement(ControlledToolCallGroup, {
    messages,
    expanded,
    onExpandedChange: setExpanded,
  }));
}

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ToolCallGroup compact header", () => {
  it("separates the legacy full-content error from its retry button", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(ShowFullContentButton, {
      error: "로드 실패. 다시 시도해주세요.",
      onClick: vi.fn(),
    })));

    const error = container.querySelector(".chat-tone-danger-text");
    expect(error?.textContent).toBe("로드 실패. 다시 시도해주세요.");
    expect(error?.classList.contains("ml-2")).toBe(true);
  });

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

  it("renders manuscript activity with a compact count, mixed rows, short names, and durations", () => {
    const activity = [
      {
        ...message(1, "done"),
        toolName: "mcp__soulstream__Read",
        toolDurationMs: 1250,
      },
      {
        id: "thinking-1",
        role: "assistant" as const,
        content: "생각을 이어 갑니다.",
        treeNodeId: "root-thinking-1",
        treeNodeType: "thinking",
      },
      {
        ...message(2, "error"),
        toolName: "mcp__soulstream__Search",
        toolDurationMs: 2500,
      },
      {
        ...message(3, "running"),
        toolName: "mcp__soulstream__Fetch",
      },
    ] as ChatMessage[];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(ToolCallGroup, {
      messages: activity,
      presentation: "manuscript",
      expanded: true,
    })));

    const toggle = container.querySelector<HTMLButtonElement>("[data-slot='manuscript-activity-toggle']")!;
    const rows = container.querySelectorAll("[data-slot='manuscript-tool-call-item']");
    const itemToggles = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-slot='tool-call-item-toggle']"));
    const labels = itemToggles
      .map((button) => button.textContent);
    const headerIcons = Array.from(toggle.querySelectorAll("svg"));

    const bodyId = toggle.getAttribute("aria-controls");
    expect(bodyId).toBeTruthy();
    expect(container.querySelector("[data-slot='manuscript-activity-items']")?.id).toBe(bodyId);
    expect(toggle.textContent).toContain("도구 3회");
    expect(toggle.textContent).toContain("실행 중");
    expect(toggle.textContent).toContain("실패 1");
    expect(headerIcons[0]?.classList.contains("lucide-wrench")).toBe(true);
    expect(toggle.lastElementChild?.classList.contains("lucide-chevron-up")).toBe(true);
    expect(container.querySelector("[data-slot='chat-tool-row']")).toBeNull();
    expect(rows).toHaveLength(3);
    expect(labels[0]).toContain("Read");
    expect(labels[0]).toContain("(1.3s)");
    expect(labels[0]).not.toContain("mcp__soulstream__");
    expect(labels[0]).not.toContain("완료");
    expect(labels[1]).not.toContain("실패");
    expect(labels[2]).not.toContain("실행 중");
    expect(itemToggles[0].querySelector("svg.lucide-check")?.classList.contains("size-3.5")).toBe(true);
    expect(itemToggles[1].querySelector("svg.lucide-x")?.classList.contains("size-3.5")).toBe(true);
    expect(itemToggles[2].querySelector("svg.lucide-clock")?.classList.contains("size-3.5")).toBe(true);
    expect(itemToggles[0].className).toContain("text-muted-foreground");
    expect(itemToggles[1].className).toContain("chat-tone-danger-text");
    expect(labels[1]).toContain("(2.5s)");
    expect(labels[2]).not.toContain("(");
    expect(container.textContent).toContain("생각을 이어 갑니다.");
    expect(container.querySelector("[data-slot='chat-body']")?.className).toContain("text-base");
  });

  it("keeps the expanded group open when an appended tool changes its virtual row key", () => {
    const view = document.createElement("div");
    document.body.appendChild(view);
    container = view;
    root = createRoot(view);
    const initial = [message(0, "done"), message(1, "done")];
    flushSync(() => root!.render(createElement(ControlledGroupHost, {
      messages: initial,
      rowKey: "tg-root-tool-1",
    })));

    flushSync(() => view.querySelector<HTMLButtonElement>("[data-slot='tool-call-group-toggle']")?.click());
    expect(view.querySelector("[data-slot='tool-call-group-toggle']")?.getAttribute("aria-expanded"))
      .toBe("true");

    flushSync(() => root!.render(createElement(ControlledGroupHost, {
      messages: [...initial, message(2, "done")],
      rowKey: "tg-root-tool-2",
    })));

    expect(view.querySelector("[data-slot='tool-call-group-toggle']")?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(view.querySelectorAll("[data-slot='tool-call-item-toggle']")).toHaveLength(3);
  });

  it("opens a grouped truncated result attachment and returns focus to its link", async () => {
    const attachment = {
      attachment_id: "tool-result-full-content",
      name: "도구 결과 전문.txt",
      mime_type: "application/zip",
      byte_size: 1_048_576,
      checksum_sha256: null,
      width: null,
      height: null,
      preview_kind: "info",
      preview_mime_type: null,
    } as const;
    const inputAttachment = {
      ...attachment,
      attachment_id: "tool-input-full-content",
      name: "도구 입력 전문.txt",
      byte_size: 204_800,
    } as const;
    const messages = [
      {
        ...message(0, "done"),
        toolInput: "입력 미리보기\n[잘림]",
        toolInputTruncation: { original_bytes: 204_800, attachment: inputAttachment },
        toolResult: "결과 미리보기\n[잘림]",
        toolResultTruncation: { original_bytes: 1_048_576, attachment },
      },
      message(1, "done"),
    ] as unknown as ChatMessage[];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(TruncationToolCallGroup, {
      messages,
      expanded: true,
      sessionId: "session-one",
    })));
    flushSync(() => container!.querySelector<HTMLButtonElement>("[data-slot='tool-call-item-toggle']")?.click());

    const bodies = [...container.querySelectorAll<HTMLElement>("[data-slot='chat-tool-body']")];
    expect(bodies.map(body => body.textContent)).toEqual(["입력 미리보기", "결과 미리보기"]);
    const spans = [...container.querySelectorAll("span")];
    const inputPrefix = spans.find(span => span.textContent?.startsWith("잘림 · 전체 200.0 KB ·"));
    const resultPrefix = spans.find(span => span.textContent?.startsWith("잘림 · 전체 1.0 MB ·"));
    const inputGroup = bodies[0].parentElement!;
    const resultGroup = bodies[1].parentElement!;
    expect(inputGroup.tagName).toBe("DIV");
    expect(inputGroup.contains(inputPrefix!)).toBe(true);
    expect(resultGroup.contains(resultPrefix!)).toBe(true);
    expect(inputGroup).not.toBe(resultGroup);
    expect(inputGroup.parentElement).toBe(resultGroup.parentElement);
    expect(resultGroup.classList.contains("mt-2")).toBe(true);
    const ordered = [bodies[0], inputPrefix, bodies[1], resultPrefix];
    expect(ordered.every(Boolean)).toBe(true);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(ordered[index]!.compareDocumentPosition(ordered[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(inputPrefix?.parentElement?.textContent).toContain("잘림 · 전체 200.0 KB · 전문 열기");
    expect(resultPrefix?.parentElement?.textContent).toContain("잘림 · 전체 1.0 MB · 전문 열기");
    const link = resultPrefix?.parentElement?.querySelector<HTMLButtonElement>("button");
    expect(link).toBeDefined();
    flushSync(() => link!.click());

    const dialog = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLElement>("[role='dialog']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.textContent).toContain("도구 결과 전문.txt");
    expect([...dialog.querySelectorAll("button")].some(button => button.textContent?.includes("원본 저장"))).toBe(true);
    flushSync(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await vi.waitFor(() => expect(document.body.querySelector("[role='dialog']")).toBeNull());
    expect(document.activeElement).toBe(link);
  });

  it("shows tool and thinking truncation metadata in manuscript activity", () => {
    const tool = {
      ...message(0, "done"),
      toolInput: "입력 미리보기\n[잘림]",
      toolResult: "결과 미리보기\n[잘림]",
      toolInputTruncation: { original_bytes: 204_800, attachment: null },
      toolResultTruncation: { original_bytes: 716_800, attachment: null },
    } as unknown as ChatMessage;
    const thinking = {
      id: "thinking-truncated",
      role: "assistant",
      content: "생각 미리보기\n[잘림]",
      thinkingContent: "생각 미리보기\n[잘림]",
      treeNodeId: "thinking-truncated",
      treeNodeType: "thinking",
      truncation: { original_bytes: 409_600, attachment: null },
    } as unknown as ChatMessage;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(TruncationToolCallGroup, {
      messages: [tool, thinking],
      presentation: "manuscript",
      expanded: true,
      sessionId: "session-one",
    })));
    flushSync(() => container!.querySelector<HTMLButtonElement>("[data-slot='tool-call-item-toggle']")?.click());

    const toolBodies = [...container.querySelectorAll<HTMLElement>("[data-slot='chat-tool-body']")];
    expect(toolBodies.map(body => body.textContent)).toEqual(["입력 미리보기", "결과 미리보기"]);
    const toolItem = container.querySelector<HTMLElement>("[data-slot='manuscript-tool-call-item']")!;
    const toolSpans = [...toolItem.querySelectorAll("span")];
    const inputPrefix = toolSpans.find(span => span.textContent?.startsWith("잘림 · 전체 200.0 KB ·"));
    const resultPrefix = toolSpans.find(span => span.textContent?.startsWith("잘림 · 전체 700.0 KB ·"));
    const inputGroup = toolBodies[0].parentElement!;
    const resultGroup = toolBodies[1].parentElement!;
    expect(inputGroup.tagName).toBe("DIV");
    expect(inputGroup.contains(inputPrefix!)).toBe(true);
    expect(resultGroup.contains(resultPrefix!)).toBe(true);
    expect(inputGroup).not.toBe(resultGroup);
    expect(inputGroup.parentElement).toBe(resultGroup.parentElement);
    expect(resultGroup.classList.contains("mt-2")).toBe(true);
    const ordered = [toolBodies[0], inputPrefix, toolBodies[1], resultPrefix];
    expect(ordered.every(Boolean)).toBe(true);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(ordered[index]!.compareDocumentPosition(ordered[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(container.textContent).toContain("입력 미리보기");
    expect(container.textContent).not.toContain("[잘림]");
    expect(container.textContent).toContain("잘림 · 전체 200.0 KB · 전문 보관 실패");
    expect(container.textContent).toContain("잘림 · 전체 700.0 KB · 전문 보관 실패");
    expect(container.textContent).toContain("잘림 · 전체 400.0 KB · 전문 보관 실패");
    expect(container.textContent).not.toContain("[잘림]");
  });
});

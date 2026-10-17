/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("ToolMessage truncation attachment", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("opens a single tool result attachment and returns focus to its link", async () => {
    const msg = {
      id: "single-tool",
      role: "tool",
      content: "Read · 완료",
      treeNodeId: "single-tool",
      treeNodeType: "tool",
      toolResult: "preview\n[잘림]",
      toolResultTruncation: {
        original_bytes: 1_048_576,
        attachment: {
          attachment_id: "single-tool-full-content",
          name: "single-tool.txt",
          mime_type: "application/zip",
          byte_size: 1_048_576,
          checksum_sha256: null,
          width: null,
          height: null,
          preview_kind: "info",
          preview_mime_type: null,
        },
      },
    } as unknown as ChatMessage;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<ChatMessageItem msg={msg} sessionId="session-one" />));

    const row = host.querySelector<HTMLElement>("[data-slot='chat-tool-row']")!;
    expect(row.textContent).toContain("잘림 · 전체 1.0 MB · 전문 열기");
    const link = [...row.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("전문 열기"))!;
    await act(async () => link.click());

    const dialog = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLElement>("[role='dialog']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.textContent).toContain("single-tool.txt");
    expect([...dialog.querySelectorAll("button")].some(button => button.textContent?.includes("원본 저장"))).toBe(true);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await vi.waitFor(() => expect(document.body.querySelector("[role='dialog']")).toBeNull());
    expect(document.activeElement).toBe(link);
  });
});

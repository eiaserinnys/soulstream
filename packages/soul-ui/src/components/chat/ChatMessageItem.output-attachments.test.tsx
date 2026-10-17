/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatUiControllerProvider } from "../chat-ui/ChatUiControllerProvider";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { SessionEventAttachmentView } from "@soulstream/wire-schema/attachments";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function asset(attachmentId: string, name: string): SessionEventAttachmentView {
  return {
    kind: "asset",
    descriptor: {
      attachment_id: attachmentId,
      name,
      mime_type: "application/zip",
      byte_size: 4,
      checksum_sha256: null,
      width: null,
      height: null,
      preview_kind: "info",
      preview_mime_type: null,
    },
    read_context: { type: "session", id: "output-session" },
    legacy_sources: [],
  };
}

function outputMessage(eventId: number, attachmentIds: string[], attachmentDisplayIds: string[]): ChatMessage {
  return {
    id: `output-attachments:${eventId}`,
    role: "assistant",
    content: "",
    treeNodeId: `output-attachments:${eventId}`,
    treeNodeType: "assistant_message",
    eventId,
    attachmentIds,
    attachmentDisplayIds,
  } as ChatMessage;
}

describe("ChatMessageItem output attachment rows", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    root = null;
    host = null;
  });

  it("filters resolved assets by the complete's display allowlist and preserves unresolved legacy items", async () => {
    const projections: Record<number, SessionEventAttachmentView[]> = {
      601: [asset("already-shown", "already-shown.zip"), asset("new-output", "new-output.zip")],
      602: [asset("only-duplicate", "only-duplicate.zip")],
      603: [
        asset("only-duplicate", "only-duplicate.zip"),
        {
          kind: "legacy",
          node_id: "eiaserinnys",
          path: "/incoming/legacy.txt",
          name: "legacy.txt",
          mime_type: "text/plain",
          byte_size: 6,
          availability: "unresolved",
          read_context: { type: "session", id: "output-session" },
        },
      ],
      604: [
        asset("assistant-full-content", "응답 전문.txt"),
        asset("assistant-extra", "별도 결과.zip"),
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.origin);
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events\/(\d+)\/attachments$/);
      if (!match) throw new Error(`Unexpected request: ${url.pathname}`);
      const eventId = Number(match[2]);
      return new Response(JSON.stringify({ event_id: eventId, items: projections[eventId] ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ChatUiControllerProvider sessionId="output-session">
          <>
            <ChatMessageItem msg={outputMessage(601, ["already-shown", "new-output"], ["new-output"])} sessionId="output-session" />
            <ChatMessageItem msg={outputMessage(602, ["only-duplicate"], [])} sessionId="output-session" />
            <ChatMessageItem msg={outputMessage(603, ["only-duplicate"], [])} sessionId="output-session" />
            <ChatMessageItem msg={{
              id: "assistant-truncated",
              role: "assistant",
              content: "응답 앞부분\n[잘림]",
              treeNodeId: "assistant-truncated",
              treeNodeType: "assistant_message",
              eventId: 604,
              attachmentIds: ["assistant-full-content", "assistant-extra"],
              truncation: {
                original_bytes: 1_048_576,
                attachment: {
                  attachment_id: "assistant-full-content",
                  name: "응답 전문.txt",
                  mime_type: "text/plain",
                  byte_size: 1_048_576,
                  checksum_sha256: null,
                  width: null,
                  height: null,
                },
              },
            } as ChatMessage} sessionId="output-session" />
          </>
        </ChatUiControllerProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const allowedRows = host.querySelector<HTMLElement>('[data-tree-node-id="output-attachments:601"] [data-chat-attachment-rows]');
    expect(allowedRows?.textContent).toContain("new-output.zip");
    expect(allowedRows?.textContent).not.toContain("already-shown.zip");
    expect(host.querySelector('[data-tree-node-id="output-attachments:602"]')).toBeNull();
    const legacyRow = host.querySelector<HTMLElement>('[data-tree-node-id="output-attachments:603"] [data-chat-attachment-rows]');
    expect(legacyRow?.textContent).toContain("legacy.txt");
    expect(legacyRow?.textContent).not.toContain("only-duplicate.zip");
    const assistantRow = host.querySelector<HTMLElement>('[data-tree-node-id="assistant-truncated"] [data-chat-attachment-rows]');
    expect(host.querySelector('[data-tree-node-id="assistant-truncated"]')?.textContent).toContain("전문 열기");
    expect(assistantRow?.textContent).toContain("별도 결과.zip");
    expect(assistantRow?.textContent).not.toContain("응답 전문.txt");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/sessions/output-session/events/601/attachments"))).toBe(true);
  });
});

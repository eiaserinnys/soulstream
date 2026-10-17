import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { AssistantMessage } from "./AssistantMessage";

const message = {
  id: "assistant-message",
  role: "assistant",
  treeNodeId: "assistant-message",
  treeNodeType: "assistant_message",
  content: "응답 본문",
} as ChatMessage;

function renderBubble(props: {
  contentLayout?: "text" | "structured";
  presentation?: "default" | "manuscript";
} = {}) {
  const html = renderToStaticMarkup(createElement(AssistantMessage, {
    msg: message,
    children: createElement("p", null, "구조화 본문"),
    ...props,
  }));
  const className = html.match(/data-slot="chat-message-bubble"[^>]*class="([^"]*)"/)?.[1];
  if (!className) throw new Error("assistant bubble was not rendered");
  return className;
}

describe("AssistantMessage content layout", () => {
  it("keeps the existing text bubble width by default", () => {
    const className = renderBubble();

    expect(className).toContain("max-w-[86%]");
    expect(className).not.toContain("w-full");
  });

  it("lets structured replies fill the existing width while retaining the text bubble cap", () => {
    const className = renderBubble({ contentLayout: "structured" });

    expect(className).toContain("w-full");
    expect(className).toContain("min-w-0");
    expect(className).toContain("max-w-[86%]");
  });

  it("leaves manuscript width unchanged for structured replies", () => {
    expect(renderBubble({ presentation: "manuscript", contentLayout: "structured" }))
      .toBe(renderBubble({ presentation: "manuscript", contentLayout: "text" }));
  });

  it("strips the event suffix and shows assistant truncation size without a second link", () => {
    const messageWithTruncation = {
      ...message,
      content: "응답 앞부분\n[잘림]",
      truncation: { original_bytes: 1_048_576, attachment: null },
    } as unknown as ChatMessage;
    const markup = renderToStaticMarkup(createElement(AssistantMessage, {
      msg: messageWithTruncation,
      presentation: "manuscript",
    }));

    expect(markup).toContain("응답 앞부분");
    expect(markup).not.toContain("[잘림]");
    expect(markup).toContain("잘림 · 전체 1.0 MB · 전문 보관 실패");
    expect(markup).not.toContain("전문 열기");
  });

  it("opens assistant truncation attachments from its metadata row", () => {
    const messageWithAttachment = {
      ...message,
      content: "응답 앞부분",
      attachmentIds: ["assistant-full-content"],
      truncation: {
        original_bytes: 1_048_576,
        attachment: {
          attachment_id: "assistant-full-content",
          name: "assistant-output.txt",
          mime_type: "text/plain",
          byte_size: 1_048_576,
          checksum_sha256: null,
          width: null,
          height: null,
          preview_kind: "text",
          preview_mime_type: "text/plain",
        },
      },
    } as unknown as ChatMessage;
    const markup = renderToStaticMarkup(createElement(AssistantMessage, {
      msg: messageWithAttachment,
      presentation: "manuscript",
      sessionId: "session-one",
    }));

    expect(markup).toContain("잘림 · 전체 1.0 MB");
    expect(markup).toContain("전문 열기");
  });
});

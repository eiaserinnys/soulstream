import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { ThinkingMessage } from "./ThinkingMessage";

const thinkingMessage: ChatMessage = {
  id: "thinking-1",
  role: "assistant",
  content: "첫 문단입니다.\n\n둘째 문단입니다.",
  treeNodeId: "root-thinking-1",
  treeNodeType: "thinking",
};

describe("ThinkingMessage", () => {
  it("원고형 생각을 접지 않은 본문 문단으로 표시한다", () => {
    const markup = renderToStaticMarkup(
      <ThinkingMessage msg={thinkingMessage} presentation="manuscript" />,
    );

    expect(markup).toContain('data-chat-presentation="manuscript"');
    expect(markup).toContain('data-slot="chat-body"');
    expect(markup).toContain("text-base");
    expect(markup).toContain("첫 문단입니다.");
    expect(markup).toContain("둘째 문단입니다.");
    expect(markup).not.toContain("Thinking");
    expect(markup).not.toContain("data-slot=\"chat-collapsible-content\"");
  });

  it("기본 대화는 기존 Thinking 접기 레이블을 유지한다", () => {
    const markup = renderToStaticMarkup(<ThinkingMessage msg={thinkingMessage} />);

    expect(markup).toContain("Thinking");
  });

  it("removes the event marker from the body and places the full-content link below it", () => {
    const messageWithTruncation = {
      ...thinkingMessage,
      content: "첫 부분\n[잘림]",
      thinkingContent: "첫 부분\n[잘림]",
      truncation: {
        original_bytes: 1_048_576,
        attachment: {
          attachment_id: "thinking-full-content",
          name: "thinking.txt",
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
    const markup = renderToStaticMarkup(
      <ThinkingMessage msg={messageWithTruncation} presentation="manuscript" sessionId="session-one" />,
    );

    expect(markup).toContain("첫 부분");
    expect(markup).not.toContain("[잘림]");
    expect(markup).toContain("잘림 · 전체 1.0 MB ·");
    expect(markup).toContain("전문 열기");
  });
});

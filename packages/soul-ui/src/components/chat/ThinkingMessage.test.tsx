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
});

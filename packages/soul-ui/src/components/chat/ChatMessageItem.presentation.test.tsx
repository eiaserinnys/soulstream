import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";

function makeMessage(role: ChatMessage["role"], id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content: "첫 문장입니다.\n둘째 문장입니다.",
    treeNodeId: `root-${id}`,
    treeNodeType: role,
    ...extra,
  } as ChatMessage;
}

describe("ChatMessageItem presentation", () => {
  it("keeps the default bubbles and renders manuscript messages without avatars or bubbles", () => {
    const messages = [
      makeMessage("user", "user-1"),
      makeMessage("assistant", "assistant-1", { isStreaming: true }),
      makeMessage("intervention", "intervention-1"),
    ];

    const defaultHtml = messages.map((msg) => renderToStaticMarkup(
      createElement(ChatMessageItem, { msg }),
    )).join("");
    const manuscriptHtml = messages.map((msg) => renderToStaticMarkup(
      createElement(ChatMessageItem, { msg, presentation: "manuscript" }),
    )).join("");

    expect(defaultHtml).toContain("bg-gradient-to-b");
    expect(defaultHtml).toContain("w-8 h-8");
    expect(manuscriptHtml.match(/data-chat-presentation="manuscript"/g)).toHaveLength(3);
    expect(manuscriptHtml).not.toContain("bg-gradient-to-b");
    expect(manuscriptHtml).not.toContain("w-8 h-8");
    expect(manuscriptHtml).toContain("text-right");
    expect(manuscriptHtml).toContain("animate-caret-blink");
    expect(manuscriptHtml).toContain("text-muted-foreground");
  });
});

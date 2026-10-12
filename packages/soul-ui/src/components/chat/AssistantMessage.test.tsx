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

  it("lets structured replies fill the existing normal-chat width", () => {
    const className = renderBubble({ contentLayout: "structured" });

    expect(className).toContain("w-full");
    expect(className).toContain("min-w-0");
    expect(className).not.toContain("max-w-[86%]");
  });

  it("leaves manuscript width unchanged for structured replies", () => {
    expect(renderBubble({ presentation: "manuscript", contentLayout: "structured" }))
      .toBe(renderBubble({ presentation: "manuscript", contentLayout: "text" }));
  });
});

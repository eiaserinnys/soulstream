import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { SystemMessage } from "./SystemMessage";
import { ToolCallGroup } from "./ToolCallGroup";
import { ToolMessage } from "./ToolMessage";

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg-1",
    type: "system",
    content: "message",
    treeNodeId: "root-msg-1",
    ...overrides,
  } as ChatMessage;
}

describe("chat tone component classes", () => {
  it("uses calm tone classes for system result and error messages", () => {
    const resultHtml = renderToStaticMarkup(
      createElement(SystemMessage, {
        msg: makeMessage({ treeNodeType: "result", content: "done" }),
      }),
    );
    const errorHtml = renderToStaticMarkup(
      createElement(SystemMessage, {
        msg: makeMessage({ isError: true, content: "failed" }),
      }),
    );

    expect(resultHtml).toContain("chat-tone-success");
    expect(errorHtml).toContain("chat-tone-danger");
  });

  it("uses calm tone classes for tool done and error states", () => {
    const toolError = makeMessage({
      type: "tool",
      isError: true,
      content: "tool failed",
    });
    const toolDone = makeMessage({
      id: "msg-2",
      type: "tool",
      content: "tool done",
      toolResult: "ok",
      treeNodeId: "root-msg-2",
    });

    const errorHtml = renderToStaticMarkup(createElement(ToolMessage, { msg: toolError }));
    const groupHtml = renderToStaticMarkup(
      createElement(ToolCallGroup, { messages: [toolDone, { ...toolDone, id: "msg-3" }] }),
    );

    expect(errorHtml).toContain("chat-tone-danger-text");
    expect(groupHtml).toContain("chat-tone-success-text");
  });
});

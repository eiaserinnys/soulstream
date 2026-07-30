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
    role: "system",
    content: "message",
    treeNodeId: "root-msg-1",
    treeNodeType: "system",
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
    expect(resultHtml).toContain("text-left");
    expect(errorHtml).toContain("text-left");
    expect(resultHtml).not.toContain("text-center");
    expect(errorHtml).not.toContain("text-center");
  });

  it("uses calm tone classes for tool done and error states", () => {
    const toolError = makeMessage({
      role: "tool",
      isError: true,
      content: "tool failed",
    });
    const toolDone = makeMessage({
      id: "msg-2",
      role: "tool",
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

  it("turn summary는 기존 system 보조 톤을 재사용하고 여러 줄을 보존한다", () => {
    const summaryHtml = renderToStaticMarkup(
      createElement(SystemMessage, {
        msg: makeMessage({
          treeNodeType: "turn_summary",
          content: "결정 사항을 정리했다.\n다음 검증을 시작했다.",
        }),
      }),
    );

    expect(summaryHtml).toContain("text-xs");
    expect(summaryHtml).toContain("text-muted-foreground");
    expect(summaryHtml).toContain("bg-input");
    expect(summaryHtml).toContain("whitespace-pre-line");
    expect(summaryHtml).toContain("text-left");
    expect(summaryHtml).not.toContain("text-center");
  });

  it("턴 완료는 라벨과 수치 블록을 좌우 정렬하고 수치 줄바꿈도 우측 기준을 유지한다", () => {
    const completeHtml = renderToStaticMarkup(
      createElement(SystemMessage, {
        msg: makeMessage({
          treeNodeType: "complete",
          content: "턴 완료",
          captionStats:
            "최근 $1.23 · 누적 $3.31 · 입력 2,985,241 (캐시 2,985,234) · 출력 1,473",
          totalCostUsd: 3.31,
        }),
      }),
    );

    expect(completeHtml).toContain("justify-between");
    expect(completeHtml).toContain("flex-wrap");
    expect(completeHtml).toContain(">턴 완료</span>");
    expect(completeHtml).toContain("ml-auto");
    expect(completeHtml).toContain("text-right");
    expect(completeHtml).toContain(
      ">최근 $1.23 · 누적 $3.31 · 입력 2,985,241 (캐시 2,985,234) · 출력 1,473</span>",
    );
  });
});

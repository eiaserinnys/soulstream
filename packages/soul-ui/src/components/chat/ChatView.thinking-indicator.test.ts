import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { MessageOrGroup } from "../../lib/grouping";
import {
  buildChatTimelineItems,
  shouldShowChatThinkingIndicator,
} from "./ChatView.thinking-indicator";

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message-1",
  role: "assistant",
  content: "",
  treeNodeId: "node-text-1",
  treeNodeType: "text",
  ...overrides,
});

describe("shouldShowChatThinkingIndicator", () => {
  it("실행 중이며 응답 텍스트가 아직 없으면 표시한다", () => {
    expect(shouldShowChatThinkingIndicator("running", [])).toBe(true);
  });

  it("실행 중이 아니면 표시하지 않는다", () => {
    expect(shouldShowChatThinkingIndicator("completed", [])).toBe(false);
    expect(shouldShowChatThinkingIndicator(undefined, [])).toBe(false);
  });

  it("빈 text_start 노드는 아직 텍스트가 흐르지 않은 구간으로 본다", () => {
    expect(
      shouldShowChatThinkingIndicator("running", [
        makeMessage({ isStreaming: true, content: "   " }),
      ]),
    ).toBe(true);
  });

  it("assistant 텍스트가 흐르기 시작하면 숨긴다", () => {
    expect(
      shouldShowChatThinkingIndicator("running", [
        makeMessage({ isStreaming: true, content: "응답" }),
      ]),
    ).toBe(false);
  });

  it("이전 턴의 완료된 assistant 텍스트는 현재 생각 중 표시를 막지 않는다", () => {
    expect(
      shouldShowChatThinkingIndicator("running", [
        makeMessage({ isStreaming: false, content: "이전 답변" }),
      ]),
    ).toBe(true);
  });
});

describe("buildChatTimelineItems", () => {
  const message = makeMessage({ role: "user", treeNodeType: "user_message" });
  const grouped: MessageOrGroup[] = [{ type: "single", msg: message }];

  it("표시할 때 기존 행 reference를 보존하고 안정된 마지막 행을 붙인다", () => {
    const first = buildChatTimelineItems(grouped, [message], "running");
    const second = buildChatTimelineItems(grouped, [message], "running");

    expect(first).toHaveLength(2);
    expect(first[0]).toBe(grouped[0]);
    expect(first[1]).toBe(second[1]);
    expect(first[1]).toEqual({ type: "thinking-indicator" });
  });

  it("숨길 때 grouped 배열 자체를 반환한다", () => {
    expect(buildChatTimelineItems(grouped, [message], "completed")).toBe(grouped);
  });

  it("빈 streaming text 말풍선은 오브와 중복 렌더하지 않는다", () => {
    const emptyStreamingText = makeMessage({ isStreaming: true, content: "" });
    const items = buildChatTimelineItems(
      [{ type: "single", msg: emptyStreamingText }],
      [emptyStreamingText],
      "running",
    );

    expect(items).toEqual([{ type: "thinking-indicator" }]);
  });
});

import { describe, expect, it } from "vitest";
import type { EventTreeNode } from "@shared/types";
import { buildLlmHistory } from "./buildLlmHistory";

const node = (
  id: string,
  type: string,
  content: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type,
  content,
  completed: true,
  children: [],
  ...extra,
});

describe("buildLlmHistory turn summary projection", () => {
  it("summary가 응답 바로 뒤로 이동해도 user·assistant 상대 순서와 본문은 불변이다", () => {
    const tree = node("session-root", "session", "", {
      children: [
        node("user-100", "user_message", "첫 질문"),
        node("assistant-message-200", "assistant_message", "첫 답변"),
        node("complete-201", "complete", ""),
        node("user-300", "user_message", "둘째 질문"),
        node("turn-summary-400", "turn_summary", "첫 턴 요약", {
          finalResponseEventId: 200,
          summaryParentEventId: 200,
        }),
        node("assistant-message-500", "assistant_message", "둘째 답변"),
      ],
    }) as unknown as EventTreeNode;

    expect(buildLlmHistory(tree)).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "assistant", content: "첫 답변" },
      { role: "user", content: "둘째 질문" },
      { role: "assistant", content: "둘째 답변" },
    ]);
  });
});

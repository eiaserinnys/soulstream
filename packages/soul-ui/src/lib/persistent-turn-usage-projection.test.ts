import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./flatten-tree";
import { projectPersistentTurnUsage } from "./persistent-turn-usage-projection";

function makeMessage(
  id: string,
  treeNodeType: string,
  extra: Record<string, unknown> = {},
): ChatMessage {
  return {
    id,
    role: treeNodeType === "user_message" ? "user" : "system",
    content: "",
    treeNodeId: id,
    treeNodeType,
    ...extra,
  } as ChatMessage;
}

describe("projectPersistentTurnUsage", () => {
  it("pairs a context and price at the complete event and absorbs the context row", () => {
    const assistant = makeMessage("assistant-1", "assistant_message", { content: "응답" });
    const context = makeMessage("context-2", "context_usage", {
      contextUsageData: { usedTokens: 6_300, maxTokens: 10_000, percent: 63, estimated: true },
    });
    const complete = makeMessage("complete-3", "complete", {
      usage: { input_tokens: 1_200, output_tokens: 340 },
      turnCostUsd: 1.4,
      sessionCostUsd: 1.4,
    });

    const result = projectPersistentTurnUsage([assistant, context, complete], true);

    expect(result.map((message) => message.id)).toEqual(["assistant-1", "complete-3"]);
    expect(result[0]).toBe(assistant);
    expect(result[1]?.turnUsageCaption).toEqual({
      title: "컨텍스트 약 63.0% · 정가 $1.40",
      contextText: "컨텍스트 약 6,300 / 10,000 (63.0%)",
      completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40 (세션 $1.40)",
    });
  });

  it("uses only fields that exist for price-only and token-only turns", () => {
    const priceOnly = makeMessage("complete-1", "complete", { turnCostUsd: 2.4 });
    const tokenOnly = makeMessage("complete-2", "complete", {
      usage: { input_tokens: 8, output_tokens: 2 },
    });

    const result = projectPersistentTurnUsage([priceOnly, tokenOnly], true);

    expect(result[0]?.turnUsageCaption).toEqual({
      title: "정가 $2.40",
      completeText: "턴 완료 · 정가 $2.40",
    });
    expect(result[1]?.turnUsageCaption).toEqual({
      title: "입력 8 · 출력 2",
      completeText: "턴 완료 · 입력 8 · 출력 2",
    });
  });

  it("omits a complete row when no usage, price, or context value is visible", () => {
    const emptyComplete = makeMessage("complete-1", "complete");

    expect(projectPersistentTurnUsage([emptyComplete], true)).toEqual([]);
  });

  it("preserves a summary-bearing complete when usage is disabled or unavailable", () => {
    const complete = makeMessage("complete-1", "complete", {
      turnSummaryCaption: { treeNodeId: "summary-1", content: "응답 내용을 요약했습니다." },
    });

    expect(projectPersistentTurnUsage([complete], false)).toEqual([complete]);
    expect(projectPersistentTurnUsage([complete], true)).toEqual([complete]);
  });

  it("joins an anchored record to the existing complete caption without changing usage or summary", () => {
    const user = makeMessage("user-1", "user_message", { inputId: "input-1" });
    const assistant = makeMessage("assistant-2", "assistant_message", { role: "assistant", content: "응답" });
    const complete = makeMessage("complete-3", "complete", {
      usage: { input_tokens: 1_200, output_tokens: 340 },
      turnCostUsd: 1.4,
      sessionCostUsd: 1.4,
      turnSummaryCaption: { treeNodeId: "summary-4", content: "기존 요약" },
    });
    const record = makeMessage("record-5", "persistent_instruction_recorded", {
      preparedInputId: "input-1",
      persistentInstructionRecorded: {
        instructions: [{ id: "instruction-1", text: "간결하게 답합니다.", source_turns: ["T195"], action: "added" }],
        capReached: false,
      },
    });

    const result = projectPersistentTurnUsage([user, assistant, complete, record], true);

    expect(result.map((message) => message.id)).toEqual(["user-1", "assistant-2", "complete-3"]);
    expect(result[2]?.turnUsageCaption).toEqual({
      title: "정가 $1.40",
      contextText: undefined,
      completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40 (세션 $1.40)",
    });
    expect(result[2]?.turnSummaryCaption).toEqual({ treeNodeId: "summary-4", content: "기존 요약" });
    expect(result[2]?.persistentInstructionRecorded?.instructions[0]?.text).toBe("간결하게 답합니다.");
  });

  it("keeps an instruction caption when usage is disabled", () => {
    const record = { instructions: [], capReached: true };
    const complete = makeMessage("complete-1", "complete", { persistentInstructionRecorded: record });

    const result = projectPersistentTurnUsage([
      complete,
      makeMessage("record-2", "persistent_instruction_recorded", { persistentInstructionRecorded: record }),
    ], false);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "complete-1",
      persistentInstructionRecorded: record,
    });
  });

  it("keeps errors, adds their paired context below, and emits no row for context without a terminal", () => {
    const error = makeMessage("error-2", "error", {
      content: "실패",
      isError: true,
    });
    const contextOnly = makeMessage("context-3", "context_usage", {
      contextUsageData: { usedTokens: 500, maxTokens: 1_000, percent: 50 },
    });

    const result = projectPersistentTurnUsage([
      makeMessage("context-1", "context_usage", {
        contextUsageData: { usedTokens: 500, maxTokens: 1_000, percent: 50 },
      }),
      error,
      contextOnly,
    ], true);

    expect(result.map((message) => message.id)).toEqual(["error-2"]);
    expect(result[0]?.content).toBe("실패");
    expect(result[0]?.turnUsageCaption).toEqual({
      title: "컨텍스트 50.0%",
      contextText: "컨텍스트 500 / 1,000 (50.0%)",
    });
  });

  it("does not let a later complete take the prior turn's context", () => {
    const result = projectPersistentTurnUsage([
      makeMessage("context-1", "context_usage", {
        contextUsageData: { usedTokens: 100, maxTokens: 1_000, percent: 10 },
      }),
      makeMessage("complete-2", "complete", { turnCostUsd: 1 }),
      makeMessage("context-3", "context_usage", {
        contextUsageData: { usedTokens: 900, maxTokens: 1_000, percent: 90 },
      }),
      makeMessage("complete-4", "complete", { turnCostUsd: 2 }),
    ], true);

    expect(result.map((message) => message.turnUsageCaption?.title)).toEqual([
      "컨텍스트 10.0% · 정가 $1.00",
      "컨텍스트 90.0% · 정가 $2.00",
    ]);
  });

  it("hides usage rows while preserving errors and ordinary messages when disabled", () => {
    const user = makeMessage("user-1", "user_message", { content: "질문" });
    const error = makeMessage("error-2", "error", { content: "실패", isError: true });

    const result = projectPersistentTurnUsage([
      user,
      makeMessage("context-2", "context_usage", {
        contextUsageData: { usedTokens: 50, maxTokens: 100, percent: 50 },
      }),
      makeMessage("complete-3", "complete", { turnCostUsd: 1 }),
      error,
    ], false);

    expect(result).toEqual([user, error]);
    expect(result[1]?.isError).toBe(true);
    expect(result[1]?.turnUsageCaption).toBeUndefined();
  });
});

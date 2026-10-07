import { describe, expect, it } from "vitest";
import {
  formatPersistentInstructionRecorded,
  isPersistentInstructionRecordedDebugEvent,
  persistentInstructionRecordedTitle,
  placePersistentInstructionRecordedAtTurnEnds,
} from "./persistent-instruction-recorded";

const instruction = {
  id: "instruction-1",
  text: "답변은 간결하게 작성합니다.",
  source_turns: [195, 210],
  action: "updated" as const,
};

describe("persistent instruction recorded projection", () => {
  it("accepts the event contract and rejects unrelated debug events", () => {
    expect(isPersistentInstructionRecordedDebugEvent({
      type: "debug",
      kind: "persistent_instruction_recorded",
      instructions: [instruction],
      cap_reached: true,
      input_id: "input-195",
      timestamp: 1_700_000_000,
    })).toBe(true);
    expect(isPersistentInstructionRecordedDebugEvent({
      type: "debug",
      kind: "persistent_decision",
      timestamp: 1_700_000_000,
    })).toBe(false);
  });

  it("formats source turns and the cap notice, including a cap-only title", () => {
    expect(formatPersistentInstructionRecorded({ instructions: [instruction], capReached: true })).toEqual([
      "답변은 간결하게 작성합니다. (T195, T210)",
      "상한(50)에 닿아 더 기록하지 못했습니다",
    ]);
    expect(persistentInstructionRecordedTitle({ instructions: [], capReached: true }))
      .toBe("📌 지속 지시 상한에 닿았습니다");
    expect(persistentInstructionRecordedTitle({ instructions: [instruction], capReached: true }))
      .toBe("📌 지속 지시로 기록했습니다");
  });

  it("moves records to the exact input turn end and hides missing anchors or replies", () => {
    const input = { treeNodeId: "input", treeNodeType: "user_message", inputId: "input-195" };
    const answer = { treeNodeId: "answer", treeNodeType: "assistant_message", role: "assistant" };
    const otherInput = { treeNodeId: "other-input", treeNodeType: "user_message", inputId: "input-210" };
    const record = {
      treeNodeId: "record",
      treeNodeType: "persistent_instruction_recorded",
      preparedInputId: "input-195",
      eventId: 3,
    };
    const unmatched = { ...record, treeNodeId: "unmatched", preparedInputId: "missing" };
    const unanswered = { ...record, treeNodeId: "unanswered", preparedInputId: "input-210" };

    expect(placePersistentInstructionRecordedAtTurnEnds([input, record, answer, otherInput, unmatched, unanswered]))
      .toEqual([input, answer, record, otherInput]);
  });
});

import { describe, expect, it } from "vitest";

import { buildCompletedTurnSummaryJob } from "../../src/task/task_turn_summary.js";
import type { Task } from "../../src/task/task_models.js";
import type { TaskTurnInput } from "../../src/task/task_turn_input_builder.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "요청",
    status: "running",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    lastAssistantText: "최종 응답",
    currentTurnFinalResponseEventId: 20,
    ...overrides,
  };
}

const input: TaskTurnInput = {
  prompt: "조립된 프롬프트",
  imageAttachmentPaths: [],
  summaryInput: {
    userText: "원래 사용자 메시지",
    turnStartEventId: 10,
  },
};

describe("buildCompletedTurnSummaryJob", () => {
  it("builds a job only from the raw turn text and durable anchors", () => {
    expect(buildCompletedTurnSummaryJob(makeTask(), input, false)).toEqual({
      sessionId: "sess-1",
      userText: "원래 사용자 메시지",
      assistantText: "최종 응답",
      turnStartEventId: 10,
      finalResponseEventId: 20,
    });
  });

  it("keeps an attachment-only turn whose user text is empty", () => {
    expect(buildCompletedTurnSummaryJob(
      makeTask(),
      {
        ...input,
        summaryInput: {
          userText: "",
          turnStartEventId: 10,
        },
      },
      false,
    )).toMatchObject({
      userText: "",
      assistantText: "최종 응답",
    });
  });

  it.each([
    ["interrupted", makeTask({ status: "interrupted" }), input, false],
    ["error", makeTask({ status: "error" }), input, false],
    ["follow-up stall", makeTask(), input, true],
    [
      "missing start anchor",
      makeTask(),
      { prompt: "x", imageAttachmentPaths: [] } satisfies TaskTurnInput,
      false,
    ],
    [
      "missing final anchor",
      makeTask({ currentTurnFinalResponseEventId: undefined }),
      input,
      false,
    ],
    ["empty final response", makeTask({ lastAssistantText: " " }), input, false],
  ])("skips %s", (_label, task, turnInput, followupStalled) => {
    expect(buildCompletedTurnSummaryJob(
      task as Task,
      turnInput as TaskTurnInput,
      followupStalled as boolean,
    )).toBeUndefined();
  });
});

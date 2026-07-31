import { describe, expect, it } from "vitest";

import {
  reconstructTurnFromEvents,
  type TurnSummaryEventRow,
} from "../src/turn-summary/turn_summary_repository.js";

describe("turn reconstruction", () => {
  it("pairs each complete with the last start after the previous complete", () => {
    const rows: TurnSummaryEventRow[] = [
      event(1, "user_message", { text: "첫 요청" }),
      event(2, "assistant_message", { content: "첫 응답" }),
      event(3, "complete", {}),
      event(4, "intervention_sent", { text: "두 번째 요청" }),
      event(5, "assistant_message", { content: "두 번째 응답 초안" }),
      event(6, "assistant_message", { content: "두 번째 최종 응답" }),
      event(7, "complete", {}),
    ];

    expect(reconstructTurnFromEvents(rows, 3)).toEqual({
      turnStartEventId: 1,
      finalResponseEventId: 2,
      userText: "첫 요청",
      assistantText: "첫 응답",
    });
    expect(reconstructTurnFromEvents(rows, 7)).toEqual({
      turnStartEventId: 4,
      finalResponseEventId: 6,
      userText: "두 번째 요청",
      assistantText: "두 번째 최종 응답",
    });
  });

  it("ignores orphan starts before the current turn", () => {
    const rows: TurnSummaryEventRow[] = [
      event(1, "user_message", { text: "응답 없이 중단된 요청" }),
      event(2, "assistant_message", { content: "중단된 응답 초안" }),
      event(3, "intervention_sent", { text: "다시 시작한 요청" }),
      event(4, "assistant_message", { content: "완료된 응답" }),
      event(5, "complete", {}),
    ];

    expect(reconstructTurnFromEvents(rows, 5)).toEqual({
      turnStartEventId: 3,
      finalResponseEventId: 4,
      userText: "다시 시작한 요청",
      assistantText: "완료된 응답",
    });
  });

  it("does not inherit a fatal error from an orphaned previous turn", () => {
    const rows: TurnSummaryEventRow[] = [
      event(1, "user_message", { text: "이미 완료된 요청" }),
      event(2, "assistant_message", { content: "이미 완료된 응답" }),
      event(3, "complete", {}),
      event(4, "user_message", { text: "실패한 고아 요청" }),
      event(5, "error", { fatal: true }),
      event(6, "assistant_message", { content: "실패한 응답" }),
      event(7, "user_message", { text: "깨끗한 현재 요청" }),
      event(8, "assistant_message", { content: "깨끗한 현재 응답" }),
      event(9, "complete", {}),
    ];

    expect(reconstructTurnFromEvents(rows, 9)).toEqual({
      turnStartEventId: 7,
      finalResponseEventId: 8,
      userText: "깨끗한 현재 요청",
      assistantText: "깨끗한 현재 응답",
    });
  });

  it.each([
    ["user_message", "사용자 요청"],
    ["intervention_sent", "개입 요청"],
    ["session_notification", "자동 전달"],
  ])("accepts %s as a turn start", (eventType, text) => {
    expect(reconstructTurnFromEvents([
      event(10, eventType, { text }),
      event(11, "assistant_message", { content: "응답" }),
      event(12, "complete", {}),
    ], 12)?.userText).toBe(text);
  });

  it.each([
    [
      {
        source: "browser",
        display_name: "Jubok Kim",
        user_id: "eiaserinnys@gmail.com",
      },
      {
        kind: "user",
        displayName: "Jubok Kim",
        source: "browser",
        userId: "eiaserinnys@gmail.com",
      },
    ],
    [
      {
        source: "agent",
        agent_name: "로젤린",
        agent_id: "roselin",
      },
      {
        kind: "agent",
        agentName: "로젤린",
      },
    ],
    [
      {
        source: "completion_notifier",
      },
      {
        kind: "system",
      },
    ],
  ])("preserves the turn-start speaker from caller_info", (
    callerInfo,
    expectedSpeaker,
  ) => {
    expect(reconstructTurnFromEvents([
      event(10, "user_message", {
        text: "요청",
        caller_info: callerInfo,
      }),
      event(11, "assistant_message", { content: "응답" }),
      event(12, "complete", {}),
    ], 12)?.speaker).toEqual(expectedSpeaker);
  });

  it("uses caller_info for intervention starts", () => {
    expect(reconstructTurnFromEvents([
      event(10, "intervention_sent", {
        text: "개입 요청",
        caller_info: {
          source: "browser",
          display_name: "Jubok Kim",
          user_id: "eiaserinnys@gmail.com",
        },
      }),
      event(11, "assistant_message", { content: "응답" }),
      event(12, "complete", {}),
    ], 12)?.speaker).toEqual({
      kind: "user",
      displayName: "Jubok Kim",
      source: "browser",
      userId: "eiaserinnys@gmail.com",
    });
  });

  it.each(["user_message", "intervention_sent"])(
    "keeps legacy %s turns without caller_info unlabeled",
    (eventType) => {
      expect(reconstructTurnFromEvents([
        event(10, eventType, { text: "레거시 요청" }),
        event(11, "assistant_message", { content: "응답" }),
        event(12, "complete", {}),
      ], 12)).not.toHaveProperty("speaker");
    },
  );

  it("labels the live completion notification shape as a delegated session report", () => {
    expect(reconstructTurnFromEvents([
      event(1199, "session_notification", {
        text: "✅ 에이전트 세션 완료",
        source: "completion_notifier",
        delivery_intent: "completion_notification",
        relation_key:
          "child_session:6c958db1-f792-445e-b355-6c5537b0c5c1:1291",
      }),
      event(1225, "assistant_message", { content: "PR #610을 머지했다." }),
      event(1226, "complete", {}),
    ], 1226)?.speaker).toEqual({
      kind: "delegated_session",
      childSessionId: "6c958db1-f792-445e-b355-6c5537b0c5c1",
    });
  });

  it("labels non-completion session notifications as system turns", () => {
    expect(reconstructTurnFromEvents([
      event(10, "session_notification", {
        text: "업무 항목 후속 실행",
        source: "claude_runtime_task_followup",
        delivery_intent: "runtime_followup",
      }),
      event(11, "assistant_message", { content: "후속 실행을 처리했다." }),
      event(12, "complete", {}),
    ], 12)?.speaker).toEqual({ kind: "system" });
  });

  it("skips a turn with a fatal error or missing anchors", () => {
    expect(reconstructTurnFromEvents([
      event(1, "user_message", { text: "요청" }),
      event(2, "error", { fatal: true }),
      event(3, "assistant_message", { content: "부분 응답" }),
      event(4, "complete", {}),
    ], 4)).toBeNull();
    expect(reconstructTurnFromEvents([
      event(1, "user_message", { text: "요청" }),
      event(2, "complete", {}),
    ], 2)).toBeNull();
  });
});

function event(
  id: number,
  eventType: string,
  payload: Record<string, unknown>,
): TurnSummaryEventRow {
  return { id, eventType, payload, createdAt: new Date(id * 1_000) };
}

import { describe, expect, it } from "vitest";
import { projectCardProgress } from "../src/cards/card_progress_projection.js";

const time = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (minute: number, text: string, callerInfo: Record<string, unknown> = {}, sessionId = "assignee") => ({
  sessionId, eventId: minute, startedAt: time(minute), at: time(minute + 1), text, callerInfo,
});

describe("card progress projection", () => {
  it("filters quiet and already recorded turns and groups the rest under milestones", () => {
    const longText = "가".repeat(4001);
    const result = projectCardProgress({
      cardId: "card", sessionIds: ["assignee", "other"],
      turns: [
        turn(0, "첫 경과"), turn(2, " [SILENT] 응답 없음"),
        ...["네", "네.", "넵", "넵."].map(text => turn(4, text)),
        turn(6, "서버 확인", { source: "system" }),
        turn(8, "카드 실행", { source: "system", card_launch: true }),
        turn(10, "커멘트로 기록"), turn(12, "질문으로 기록"), turn(14, longText),
      ],
      milestones: [
        { id: "m1", at: time(7), text: "작업 중", ask: null, turn: "agent" },
        { id: "m2", at: time(17), text: "빈 이정표", ask: null, turn: null },
      ],
      recorded: [
        { sessionId: "assignee", at: time(10) }, { sessionId: "assignee", at: time(13) },
        { sessionId: "other", at: time(14) },
      ],
    });
    expect(result).toEqual({ cardId: "card", sessionIds: ["assignee", "other"], bundles: [
      { milestone: null, entries: [{ sessionId: "assignee", eventId: 0, startedAt: time(0), at: time(1), text: "첫 경과", truncated: false }] },
      { milestone: { id: "m1", at: time(7), text: "작업 중", ask: null, turn: "agent" }, entries: [
        { sessionId: "assignee", eventId: 8, startedAt: time(8), at: time(9), text: "카드 실행", truncated: false },
        { sessionId: "assignee", eventId: 14, startedAt: time(14), at: time(15), text: "가".repeat(4000), truncated: true },
      ] },
    ] });
  });
});

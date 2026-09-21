import { describe, expect, it } from "vitest";

import { buildSessionStoryPrompt } from
  "../src/turn-summary/session_story_fold_service.js";
import type { UnfoldedTurnSummary } from
  "../src/turn-summary/session_story_repository.js";

// A fold prompt pastes the stored narrative in verbatim and appends the new
// batch under `[Tn]` labels. If a label appears on both sides the model is
// handed two different turns under one name and writes that ambiguity into the
// narrative it returns -- corruption that no read-side assertion can undo.
// These run on the prompt itself, before any model call.
describe("session story turn marker contract", () => {
  const FOLDED_NARRATIVE = "[T1] turn ten [T2] turn twenty [T3] turn thirty";

  it("never reuses a marker the existing narrative already cites", () => {
    // Backfilled recovery of a turn between 10 and 20. Labelled by append
    // order, it takes the next free number.
    const prompt = buildSessionStoryPrompt(
      "instruction",
      FOLDED_NARRATIVE,
      [summary({ eventId: 304, turnNumber: 4, turnStart: 15 })],
    );

    const { existing, batch } = sections(prompt);
    expect(markers(batch)).toEqual([4]);
    expect(intersect(markers(existing), markers(batch))).toEqual([]);
  });

  it("detects the collision a conversation-position label would introduce", () => {
    // The same recovered turn, labelled by its position in the conversation:
    // turn 15 sits second, so it collides with the [T2] the narrative already
    // spent on turn 20.
    const prompt = buildSessionStoryPrompt(
      "instruction",
      FOLDED_NARRATIVE,
      [summary({ eventId: 304, turnNumber: 2, turnStart: 15 })],
    );

    const { existing, batch } = sections(prompt);
    expect(intersect(markers(existing), markers(batch))).toEqual([2]);
  });

  it("keeps every batch label free when several turns are recovered at once", () => {
    const prompt = buildSessionStoryPrompt(
      "instruction",
      FOLDED_NARRATIVE,
      [
        summary({ eventId: 304, turnNumber: 4, turnStart: 15 }),
        summary({ eventId: 305, turnNumber: 5, turnStart: 25 }),
        summary({ eventId: 306, turnNumber: 6, turnStart: 40 }),
      ],
    );

    const { existing, batch } = sections(prompt);
    expect(markers(batch)).toEqual([4, 5, 6]);
    expect(intersect(markers(existing), markers(batch))).toEqual([]);
  });

  // A label says where a summary was appended, not when its turn happened, so a
  // recovered turn carries a high label while describing an early part of the
  // conversation. The stored narrative holds bare markers, so the one fact the
  // model cannot derive -- the time order of every marker in play -- is stated
  // once. This supplies ordering data only; it does not make the model's
  // content correct.
  it("states the time order of narrative and batch markers as one line", () => {
    const prompt = buildSessionStoryPrompt(
      "instruction",
      FOLDED_NARRATIVE,
      [summary({ eventId: 304, turnNumber: 4, turnStart: 15 })],
      new Map([[1, 10], [2, 20], [3, 30]]),
    );

    expect(prompt).toContain("T1 < T4 < T2 < T3");
    // Raw conversation positions are never emitted beside a marker: a bare
    // integer there invites the model to echo it back as a marker, and the
    // output schema only requires that some marker exists.
    expect(prompt).not.toContain("대화 위치");
    const { batch } = sections(prompt);
    expect(batch).toContain("[T4] summary-for-turn-15");
  });

  it("omits the ordering line when no position is known", () => {
    const prompt = buildSessionStoryPrompt("instruction", null, [
      {
        ...summary({ eventId: 1, turnNumber: 1, turnStart: 5 }),
        turnStartEventId: null,
      },
    ]);

    expect(prompt).not.toContain("[마커 시간 순서]");
  });

  it("renders a recovered batch in conversation order, not label order", () => {
    const prompt = buildSessionStoryPrompt("instruction", null, [
      summary({ eventId: 310, turnNumber: 7, turnStart: 90 }),
      summary({ eventId: 311, turnNumber: 8, turnStart: 12 }),
    ]);

    const { batch } = sections(prompt);
    expect(batch.indexOf("[T8]")).toBeLessThan(batch.indexOf("[T7]"));
    expect(prompt).toContain("T8 < T7");
  });
});

function summary(
  input: { eventId: number; turnNumber: number; turnStart: number },
): UnfoldedTurnSummary {
  return {
    eventId: input.eventId,
    turnNumber: input.turnNumber,
    content: `summary-for-turn-${input.turnStart}`,
    turnStartEventId: input.turnStart,
    finalResponseEventId: input.turnStart + 1,
    createdAt: new Date("2026-09-21T00:00:00Z"),
  };
}

function sections(prompt: string): { existing: string; batch: string } {
  const [existing = "", batch = ""] = prompt.split("[새 턴 요약]");
  return { existing, batch };
}

function markers(text: string): number[] {
  return [...text.matchAll(/\[T(\d+)\]/g)].map((match) => Number(match[1]));
}

function intersect(left: number[], right: number[]): number[] {
  return left.filter((value) => right.includes(value));
}

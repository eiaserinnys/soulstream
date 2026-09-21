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

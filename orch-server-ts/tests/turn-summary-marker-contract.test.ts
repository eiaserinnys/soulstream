import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSessionStoryPrompt } from
  "../src/turn-summary/session_story_fold_service.js";
import type { UnfoldedTurnSummary } from
  "../src/turn-summary/session_story_repository.js";

describe("session story turn marker contract", () => {
  // Catches the corruption before it reaches the database: if the new batch
  // reuses a label the existing narrative already cites, the model is asked to
  // extend a story in which one marker means two different turns.
  it("never reuses a marker the existing narrative already cites", () => {
    const existingNarrative = "[T1] a [T2] b [T3] c";
    const batch = [summary({ eventId: 304, turnNumber: 4, content: "late" })];

    const prompt = buildSessionStoryPrompt("inst", existingNarrative, batch);
    const [, newSection = ""] = prompt.split("[새 턴 요약]");

    expect(markers(newSection)).toEqual([4]);
    expect(intersect(markers(existingNarrative), markers(newSection))).toEqual([]);
  });

  it("detects the collision when a batch is labelled by conversation position", () => {
    const existingNarrative = "[T1] a [T2] b [T3] c";
    // What conversation-position labelling would produce for a backfilled turn
    // that sits between T1 and T2.
    const batch = [summary({ eventId: 304, turnNumber: 2, content: "late" })];

    const prompt = buildSessionStoryPrompt("inst", existingNarrative, batch);
    const [, newSection = ""] = prompt.split("[새 턴 요약]");

    expect(intersect(markers(existingNarrative), markers(newSection))).toEqual([2]);
  });

  // Every producer of `turn_number` has to agree, or the same turn answers to
  // different labels depending on which read path the caller used.
});

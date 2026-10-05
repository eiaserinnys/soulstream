import { describe, expect, it } from "vitest";

import { isPersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";

const observation = {
  input_id: "input-1",
  selected: [{
    kind: "session",
    session_id: "session-2",
    label: "이전 작업",
    line: "요청의 배경을 정했습니다.",
    score: 2,
    raw_score: 2.65,
    sources: ["search", "recent_completed"],
  }],
  candidate_counts: {
    turn_summaries: 1,
    cards: 2,
    search_sessions: 3,
    recent_completed_sessions: 4,
  },
  model: "jev-latest",
  latency_ms: 250,
  top_raw_score: 2.65,
};

describe("persistent Jev debug event guard", () => {
  it("accepts the shared observation contract", () => {
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug",
      kind: "persistent_jev_candidates",
      observation,
    })).toBe(true);
  });

  it("rejects invalid scores and unrelated debug payloads", () => {
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug",
      kind: "persistent_jev_candidates",
      observation: { ...observation, selected: [{ ...observation.selected[0], score: 4 }] },
    })).toBe(false);
    for (const score of [0, 1]) {
      expect(isPersistentJevCandidatesDebugEvent({
        type: "debug",
        kind: "persistent_jev_candidates",
        observation: { ...observation, selected: [{ ...observation.selected[0], score }] },
      })).toBe(false);
    }
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug",
      kind: "assigned_card_context_snapshot",
      observation,
    })).toBe(false);
  });

  it("requires bounded raw scores in both the observation and selected candidates", () => {
    const { top_raw_score: _topRawScore, ...withoutTopRawScore } = observation;
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation: withoutTopRawScore,
    })).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates",
      observation: { ...observation, top_raw_score: 3.1 },
    })).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates",
      observation: { ...observation, selected: [{ ...observation.selected[0], raw_score: 1.9 }] },
    })).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates",
      observation: { ...observation, selected: [{ ...observation.selected[0], raw_score: 3.1 }] },
    })).toBe(false);
    const { raw_score: _rawScore, ...selectedWithoutRawScore } = observation.selected[0]!;
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates",
      observation: { ...observation, selected: [selectedWithoutRawScore] },
    })).toBe(false);
  });
});

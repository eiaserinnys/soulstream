import { describe, expect, it } from "vitest";

import { isPersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";

const observation = {
  input_id: "input-1",
  selected: [{
    kind: "session",
    session_id: "session-2",
    label: "이전 작업",
    line: "요청의 배경을 정했습니다.",
    score: 3,
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

  it("accepts optional unselected score details and unknown extension keys", () => {
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug",
      kind: "persistent_jev_candidates",
      observation: {
        ...observation,
        future_observation_key: true,
        candidate_counts: { ...observation.candidate_counts, future_count: 9 },
        selected: [{ ...observation.selected[0], future_candidate_key: "ignored" }],
        unselected_top: [
          { kind: "turn_summary", label: "T3", raw_score: 1.7, future_top_key: true },
          { kind: "session", label: "Other work", raw_score: 1.9, sources: ["search"], future_top_key: true },
        ],
        top_raw_scores: {
          turn_summaries: 1.7,
          cards: null,
          search_sessions: 1.9,
          recent_completed_sessions: null,
          future_kind: 2,
        },
      },
    })).toBe(true);
    expect(isPersistentJevCandidatesDebugEvent({
      type: "debug", kind: "persistent_jev_candidates", observation,
    })).toBe(true);
  });

  it("validates optional unselected score detail shapes when present", () => {
    for (const invalid of [
      { unselected_top: Array.from({ length: 6 }, () => ({ kind: "card", label: "#1", raw_score: 2 })) },
      { unselected_top: [{ kind: "other", label: "Unknown", raw_score: 2 }] },
      { unselected_top: [{ kind: "card", label: "", raw_score: 2 }] },
      { unselected_top: [{ kind: "card", label: "#1", raw_score: 3.1 }] },
      { unselected_top: [{ kind: "session", label: "Session", raw_score: 2 }] },
      { top_raw_scores: { turn_summaries: 1, cards: 1, search_sessions: 1 } },
      { top_raw_scores: { turn_summaries: 3.1, cards: null, search_sessions: null, recent_completed_sessions: null } },
    ]) {
      expect(isPersistentJevCandidatesDebugEvent({
        type: "debug", kind: "persistent_jev_candidates", observation: { ...observation, ...invalid },
      })).toBe(false);
    }
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

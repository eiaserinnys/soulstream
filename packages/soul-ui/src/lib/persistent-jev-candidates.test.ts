import { describe, expect, it } from "vitest";
import {
  formatPersistentJevCandidates,
  isPersistentJevCandidatesDebugEvent,
  placePersistentJevCandidatesAtInputAnchors,
  projectPersistentChatDisplayMessages,
} from "./persistent-jev-candidates";

const event = (input_id: string, eventId: number, selected: unknown[] = []) => ({
  type: "debug",
  kind: "persistent_jev_candidates",
  timestamp: eventId,
  observation: {
    input_id,
    selected,
    candidate_counts: { turn_summaries: 1, cards: 1, search_sessions: 0, recent_completed_sessions: 0 },
    model: "jev-latest",
    latency_ms: 20,
    top_raw_score: (selected[0] as { raw_score?: number } | undefined)?.raw_score ?? 1.9,
  },
});

describe("persistent Jev candidate projection", () => {
  it("validates its raw debug payload and formats only labels, short lines, and scores", () => {
    const raw = event("input-a", 12, [
      { kind: "turn_summary", session_id: "private-id", summary_event_id: 9, turn_number: 38, label: "T38", line: "짧은 요약", score: 3, raw_score: 2.65 },
    ]);
    expect(isPersistentJevCandidatesDebugEvent(raw)).toBe(true);
    if (isPersistentJevCandidatesDebugEvent(raw)) {
      expect(formatPersistentJevCandidates(raw.observation)).toEqual(["T38 · 짧은 요약 · 3/3"]);
    }
    expect(formatPersistentJevCandidates({ selected: [] })).toEqual(["2점 이상인 후보가 없습니다."]);
    expect(isPersistentJevCandidatesDebugEvent({ ...raw, observation: { ...raw.observation, selected: [{ kind: "card" }] } })).toBe(false);
    const card = { kind: "card", card_id: "card-1", label: "#412", line: "카드 한 줄", score: 0, raw_score: 2.3 };
    expect(isPersistentJevCandidatesDebugEvent(event("input-a", 13, [card]))).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent(event("input-a", 14, [{ ...card, score: 1 }]))).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent(event("input-a", 15, Array.from({ length: 6 }, (_, index) => ({ ...card, card_id: `card-${index}` }))))).toBe(false);
    expect(isPersistentJevCandidatesDebugEvent(event("input-a", 16, [{ ...card, unexpected: true }]))).toBe(false);
  });

  it("keeps displayed title and lines unchanged for extended and legacy observations", () => {
    const raw = event("input-a", 20, [
      { kind: "card", card_id: "card-a", label: "#9", line: "Prior work", score: 3, raw_score: 2.7 },
    ]);
    const baseObservation = raw.observation;
    const observations = [
      {
        ...baseObservation,
        unselected_top: [{ kind: "session", label: "Other session", raw_score: 1.9, sources: ["search"] }],
        top_raw_scores: { turn_summaries: null, cards: 2.7, search_sessions: 1.9, recent_completed_sessions: null },
        future_observation_key: "ignored",
      },
      { ...baseObservation, future_observation_key: "ignored" },
      baseObservation,
    ];

    for (const observation of observations) {
      const candidateEvent = { ...raw, observation };
      expect(isPersistentJevCandidatesDebugEvent(candidateEvent)).toBe(true);
      if (isPersistentJevCandidatesDebugEvent(candidateEvent)) {
        expect(formatPersistentJevCandidates(candidateEvent.observation)).toEqual(["#9 · Prior work · 3/3"]);
        expect(candidateEvent.observation.selected).toHaveLength(1);
      }
    }
  });

  it("anchors late records below their exact loaded input and preserves distinct records", () => {
    const input = { treeNodeId: "input-1", treeNodeType: "user_message", inputId: "same" };
    const answer = { treeNodeId: "answer", treeNodeType: "assistant_message" };
    const record = (treeNodeId: string, eventId: number, preparedInputId: string) => ({
      treeNodeId, treeNodeType: "persistent_jev_candidates", eventId, preparedInputId,
    });
    expect(placePersistentJevCandidatesAtInputAnchors([
      input, answer, record("jev-1", 20, "same"), record("jev-2", 21, "same"), record("jev-unloaded", 22, "later"),
    ]).map((item) => item.treeNodeId)).toEqual(["input-1", "jev-1", "jev-2", "answer"]);
    expect(placePersistentJevCandidatesAtInputAnchors([
      record("jev-unloaded", 22, "later"), input, answer,
    ]).map((item) => item.treeNodeId)).toEqual(["input-1", "answer"]);
    expect(placePersistentJevCandidatesAtInputAnchors([
      record("jev-unloaded", 22, "later"), input, answer,
      { treeNodeId: "later-input", treeNodeType: "intervention", inputId: "later" },
    ]).map((item) => item.treeNodeId)).toEqual(["input-1", "answer", "later-input", "jev-unloaded"]);
  });

  it("filters display rows without changing the identity of retained messages", () => {
    const input = { treeNodeId: "input", treeNodeType: "user_message" };
    const generation = { treeNodeId: "generation", treeNodeType: "generation_started" };
    const candidate = { treeNodeId: "candidate", treeNodeType: "persistent_jev_candidates" };
    const messages = [input, generation, candidate];
    const hidden = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: false,
      show_jev_candidates: false,
    });
    expect(hidden).toEqual([input]);
    const restored = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: true,
      show_jev_candidates: true,
    });
    expect(restored[0]).toBe(input);
    expect(restored[1]).toBe(generation);
    expect(restored[2]).toBe(candidate);
  });
});

import { describe, expect, it } from "vitest";
import {
  formatPersistentJevCandidates,
  isPersistentJevCandidatesDebugEvent,
  placePersistentJevCandidatesAtInputAnchors,
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
  },
});

describe("persistent Jev candidate projection", () => {
  it("validates its raw debug payload and formats only labels, short lines, and scores", () => {
    const raw = event("input-a", 12, [
      { kind: "turn_summary", session_id: "private-id", summary_event_id: 9, turn_number: 38, label: "T38", line: "짧은 요약", score: 3 },
    ]);
    expect(isPersistentJevCandidatesDebugEvent(raw)).toBe(true);
    if (isPersistentJevCandidatesDebugEvent(raw)) {
      expect(formatPersistentJevCandidates(raw.observation)).toEqual(["T38 · 짧은 요약 · 3/3"]);
    }
    expect(formatPersistentJevCandidates({ selected: [] })).toEqual(["2점 이상인 후보가 없습니다."]);
    expect(isPersistentJevCandidatesDebugEvent({ ...raw, observation: { ...raw.observation, selected: [{ kind: "card" }] } })).toBe(false);
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
});

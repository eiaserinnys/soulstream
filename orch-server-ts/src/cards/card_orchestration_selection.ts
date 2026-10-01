import { createHash } from "node:crypto";
import {
  parseOrchestrationDecision,
  type CandidateSnapshot,
  type OrchestrationDecision,
} from "@soulstream/wire-schema/card-orchestration";
import type { DispatchCard } from "./card_dispatch_repository.js";
export function validateDecisionSnapshot(
  input: unknown,
  snapshot: readonly CandidateSnapshot[],
): OrchestrationDecision {
  const parsed = parseOrchestrationDecision(input),
    versions = new Map(snapshot.map((c) => [c.cardId, c.cardVersion])),
    seen = new Set<string>();
  for (const item of parsed.decisions) {
    if (seen.has(item.cardId) || versions.get(item.cardId) !== item.cardVersion)
      throw new Error("Decision is outside the candidate snapshot");
    seen.add(item.cardId);
  }
  return parsed;
}
export function selectEligibleCards<
  T extends Pick<DispatchCard, "id" | "assignee_kind" | "assignee_agent_id">,
>(
  cards: readonly T[],
  occupancy: Record<string, number>,
  concurrency: Record<string, number>,
  resolve: (card: T) => { nodeId: string; available: boolean },
): T[] {
  return cards.filter((card) => {
    if (card.assignee_kind === "human" || !card.assignee_agent_id) return false;
    const target = resolve(card);
    return (
      target.available &&
      (occupancy[target.nodeId] ?? 0) <
        (concurrency[target.nodeId] ?? concurrency.default!)
    );
  });
}
/** Input excludes quota timestamps/percentages: sufficient quota is a cheap gate, not a reason to ask again. */
export function decisionInputFingerprint(input: {
  policyVersion: number;
  instructionsRevision?: string;
  candidates: readonly CandidateSnapshot[];
  running: unknown;
  capacity: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

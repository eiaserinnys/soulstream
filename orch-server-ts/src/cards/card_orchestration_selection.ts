import { createHash } from "node:crypto";
import {
  parseOrchestrationDecision,
  type CandidateSnapshot,
  type OrchestrationDecision,
} from "@soulstream/wire-schema/card-orchestration";
import type { CardDispatchRepository, DispatchCard } from "./card_dispatch_repository.js";
import { isUsageLimitTermination } from "../session/session_limit_termination.js";
type OwnerSession = Awaited<ReturnType<CardDispatchRepository["ownerSession"]>>;
type ExecutionCard = Pick<DispatchCard, "status" | "blocked_kind" | "assignee_session_id">;
export type ExecutionClassification =
  | { mode: "dispatch" }
  | { mode: "resume"; owner: NonNullable<OwnerSession> }
  | { mode: "skip"; reason: "limit_owner_missing" | "limit_owner_not_resumable" | "card_not_dispatchable" };

export function classifyExecution(card: ExecutionCard, owner: OwnerSession): ExecutionClassification {
  if (card.status === "queued") return { mode: "dispatch" };
  if (card.status === "blocked" && card.blocked_kind === "limit") {
    if (!card.assignee_session_id || !owner) return { mode: "skip", reason: "limit_owner_missing" };
    if (isUsageLimitTermination(owner)) return { mode: "resume", owner };
    return { mode: "skip", reason: "limit_owner_not_resumable" };
  }
  return { mode: "skip", reason: "card_not_dispatchable" };
}

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
  T extends Pick<DispatchCard, "id" | "assignee_kind" | "assignee_agent_id" | "assignee_session_id">,
>(
  cards: readonly T[],
  occupancy: Record<string, number>,
  concurrency: Record<string, number>,
  resolve: (card: T) => { nodeId: string; available: boolean; capacityClaimed?: boolean },
): T[] {
  return cards.filter((card) => {
    if (card.assignee_kind === "session" ? !card.assignee_session_id : card.assignee_kind === "human" || !card.assignee_agent_id) return false;
    const target = resolve(card);
    return (
      target.available &&
      (target.capacityClaimed || (occupancy[target.nodeId] ?? 0) <
        (concurrency[target.nodeId] ?? concurrency.default!))
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

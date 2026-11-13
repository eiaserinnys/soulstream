import {
  EVENT_SESSION_REJECTION_REASONS,
  type EventCanonicalSessionProjection,
  type EventIngressEnvelope,
  type EventSessionEffect,
  type EventSessionRejectionReason,
} from "./event_ingress_contract.js";
import type { EventIngressQuerySql } from "./event_ingress_repository.js";
import { decideSessionTransition } from "../session/state/session_decision.js";
import { SESSION_REJECTION_REASON_WIRE } from
  "../session/state/session_decision_labels.js";
import type {
  FiniteFacts,
  SessionCommand,
  SessionDecisionCommand,
} from "../session/state/session_decision_facts.js";
import {
  rowToStateValue,
  sessionTerminalTarget,
} from "../session/state/session_state_value.js";

/** lockSession이 FOR UPDATE로 잠근 세션 줄. 판정과 거절 응답의 정본이다. */
export type SessionGateRow = {
  node_id: string | null;
  status: string | null;
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  last_assistant_text: string | null;
  termination_event_id: number | null;
  last_event_id: number | null;
  updated_at: Date | string;
  worktree_id: string | null;
  execution_registration_id: string | null;
  execution_command_id: string | null;
};

export type EventSessionGateDecision =
  | { kind: "skip" }
  | { kind: "apply"; terminalResume: boolean }
  | { kind: "reject"; reason: EventSessionRejectionReason | null };

/**
 * 세션 기계 사유 → 와이어 rejection_reason. 표에 없거나 null인 사유는 싣지 않는다.
 * terminal_transition은 owner_node_changed만 싣는다(나머지는 표에 없다).
 */
export function wireRejectionReason(
  reason: string,
): EventSessionRejectionReason | null {
  const value = SESSION_REJECTION_REASON_WIRE[reason];
  return value !== null
    && value !== undefined
    && (EVENT_SESSION_REJECTION_REASONS as readonly string[]).includes(value)
    ? value as EventSessionRejectionReason
    : null;
}

type GatedSessionEffect = Extract<
  EventSessionEffect,
  {
    kind:
      | "execution_registration"
      | "execution_acquire"
      | "running_transition"
      | "terminal_transition";
  }
>;

const GATED_COMMANDS: Record<GatedSessionEffect["kind"], SessionDecisionCommand> = {
  execution_registration: "execution_registration",
  execution_acquire: "execution_registration",
  running_transition: "running_transition",
  terminal_transition: "terminal_transition",
};

function isGatedSessionEffect(
  effect: EventSessionEffect,
): effect is GatedSessionEffect {
  return effect.kind === "execution_registration"
    || effect.kind === "execution_acquire"
    || effect.kind === "running_transition"
    || effect.kind === "terminal_transition";
}

/** 문지기가 판정하는 상태 사건이면 그 명령, 아니면 null. */
export function gatedSessionCommand(
  effect: EventSessionEffect | null,
): SessionDecisionCommand | null {
  return effect !== null && isGatedSessionEffect(effect)
    ? GATED_COMMANDS[effect.kind]
    : null;
}

/** sessions.node_id가 NULL이면 어느 노드의 사건도 받는다(노드 규칙과 같다). */
export function sessionOwnerMatches(row: SessionGateRow, nodeId: string): boolean {
  return row.node_id === null || row.node_id === nodeId;
}

/**
 * 잇기 의도는 봉투 payload의 전이 id에서 읽는다. 노드는 실행 중 전환의
 * metadata 사건에 `adopt:<commandId|lastEventId>:<시도 UUID>`를 싣는다
 * (soul-server-ts event_transition_publisher.ts).
 */
export function isAdoptionEnvelope(envelope: EventIngressEnvelope): boolean {
  const payload = envelope.payload;
  if (!isRecord(payload)) return false;
  if (
    payload.type !== "metadata"
    || payload.metadata_type !== "session_status_transition"
  ) {
    return false;
  }
  const value = payload.value;
  if (!isRecord(value)) return false;
  return typeof value.transition_id === "string"
    && value.transition_id.startsWith("adopt:");
}

/**
 * 상태값과 사실을 세션 기계에 넘겨 적용, 거절을 받는다. 거절이면 SQL 함수를
 * 부르지 않고, 적용이면 R1(잇기 되살림)일 때만 종료 재개로 부른다.
 */
export async function decideEventSessionGate(
  sql: EventIngressQuerySql,
  input: {
    row: SessionGateRow;
    nodeId: string;
    eventId: number;
    envelope: EventIngressEnvelope;
  },
): Promise<EventSessionGateDecision> {
  const effect = input.envelope.session_effect;
  if (effect === null || !isGatedSessionEffect(effect)) return { kind: "skip" };
  const command = GATED_COMMANDS[effect.kind];

  const value = rowToStateValue(input.row);
  const owner = sessionOwnerMatches(input.row, input.nodeId)
    ? "match"
    : "mismatch";
  const facts: FiniteFacts = { owner };
  if (effect.kind === "terminal_transition") {
    facts.revision = revisionFact(
      input.row.termination_event_id,
      input.eventId,
    );
    facts.eventId = input.eventId > 0 ? "positive" : "non_positive";
  } else {
    facts.resume = resumeFact(
      effect.expected_terminal_event_id,
      input.row.termination_event_id,
    );
    if (owner === "match") {
      Object.assign(
        facts,
        await worktreeFacts(sql, input.row, input.envelope.session_id),
      );
    }
    if (command === "running_transition") {
      facts.adopt = isAdoptionEnvelope(input.envelope);
    }
  }

  const decision = decideSessionTransition(
    value,
    sessionCommand(command, effect),
    facts,
  );
  if (decision.kind === "apply") {
    return {
      kind: "apply",
      terminalResume: decision.reason === "adopt_resume",
    };
  }
  return {
    kind: "reject",
    reason: wireRejectionReason(decision.reason),
  };
}

/** 잠근 줄에서 거절 응답의 canonical_session을 만든다. */
export function sessionCanonicalProjection(
  row: SessionGateRow,
): EventCanonicalSessionProjection {
  if (typeof row.status !== "string") {
    throw new Error("session gate row has no status");
  }
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : row.updated_at;
  if (
    typeof updatedAt !== "string"
    || !Number.isFinite(new Date(updatedAt).getTime())
  ) {
    throw new Error("session gate row has an invalid updated_at");
  }
  return {
    status: row.status,
    termination_reason: row.termination_reason,
    termination_detail: row.termination_detail,
    review_state: row.review_state,
    last_assistant_text: row.last_assistant_text,
    termination_event_id: row.termination_event_id,
    updated_at: updatedAt,
    last_event_id: row.last_event_id,
  };
}

/**
 * 워크트리 사실. SQL 함수와 같은 잠금 차례(세션 → 워크트리)를 지키고,
 * 같은 워크트리의 다른 활성 세션 점유를 별개 사실로 읽는다.
 */
async function worktreeFacts(
  sql: EventIngressQuerySql,
  row: SessionGateRow,
  sessionId: string,
): Promise<{ worktree: string; worktreeBusy: boolean }> {
  if (row.worktree_id === null) {
    return { worktree: "none", worktreeBusy: false };
  }
  const worktrees = await sql<Array<{
    state: string;
    setup_required: boolean;
    setup_status: string;
  }>>`
    SELECT state, setup_required, setup_status
    FROM worktrees
    WHERE id = ${row.worktree_id}
    FOR UPDATE
  `;
  const worktree = worktrees[0];
  if (!worktree || worktree.state !== "ready") {
    return { worktree: "not_ready", worktreeBusy: false };
  }
  if (worktree.setup_required === true && worktree.setup_status !== "ready") {
    return { worktree: "setup_required", worktreeBusy: false };
  }
  const active = await sql<Array<{ session_id: string }>>`
    SELECT session_id
    FROM sessions
    WHERE worktree_id = ${row.worktree_id}
      AND session_id <> ${sessionId}
      AND status IN ('initializing', 'running')
    LIMIT 1
  `;
  return { worktree: "ready", worktreeBusy: active.length > 0 };
}

function resumeFact(
  expected: number | null | undefined,
  stored: number | null,
): string {
  if (expected === undefined) return "fresh";
  // SQL의 IS NOT DISTINCT FROM과 같은 규칙이다(NULL끼리 같다).
  return expected === stored ? "terminal_match" : "terminal_mismatch";
}

function revisionFact(stored: number | null, eventId: number): string {
  if (stored === null) return "none";
  if (eventId > stored) return "less";
  if (eventId === stored) return "equal";
  return "greater";
}

function sessionCommand(
  command: SessionDecisionCommand,
  effect: GatedSessionEffect,
): SessionCommand {
  if (effect.kind === "terminal_transition") {
    const target = sessionTerminalTarget(effect.status);
    return {
      type: command,
      ...(isReviewState(effect.review_state)
        ? { reviewNext: effect.review_state }
        : {}),
      ...(target === null ? {} : { target }),
    };
  }
  return {
    type: command,
    ...(isReviewState(effect.review_state)
      ? { reviewNext: effect.review_state }
      : {}),
  };
}

function isReviewState(
  value: string,
): value is NonNullable<SessionCommand["reviewNext"]> {
  return value === "not_required"
    || value === "needs_review"
    || value === "acknowledged";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

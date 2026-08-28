import { vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import { makeEventPersistenceTestDouble } from
  "../task/event_persistence_test_double.js";

type AcquireInput = Parameters<
  EventPersistence["acquireExecutionOwnershipAndWaitForApplication"]
>[1];
type ReleaseInput = Parameters<
  EventPersistence["releaseExecutionOwnershipAndWaitForApplication"]
>[2];

export interface CutoverOwnershipRow {
  readonly sessionId: string;
  readonly ownershipGeneration: number;
  readonly ownerKind: AcquireInput["ownerKind"];
  readonly manifestId: string;
  readonly runtimeEnvIdentity: string;
  readonly registrationId: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly executionCommandId: string;
  phase: "active" | "terminal";
  terminalAt: string | null;
  runnerFact: ReleaseInput["runnerFact"] | "closed" | null;
  failureReason: string | null;
}

/**
 * Stateful central-ownership observer for real runner composition scenarios.
 *
 * Host lock release and child PID exit never mutate this ledger. Only the
 * product's durable acquire/release persistence boundary may change a row, so
 * terminal rows are evidence of the TaskExecutor lifecycle rather than test
 * teardown.
 */
export class RunnerCutoverOwnershipLedger {
  private readonly rows: CutoverOwnershipRow[] = [];
  private eventId = 10_000;

  readonly trace: string[] = [];

  createHostPersistence(
    sideEffect?: (
      sessionId: string,
      event: SSEEventPayload,
      task: Task,
    ) => Promise<void>,
  ) {
    const base = makeEventPersistenceTestDouble(sideEffect);
    const acquireExecutionOwnershipAndWaitForApplication = vi.fn(
      async (sessionId: string, input: AcquireInput) => {
        const updatedAt = (input.updatedAt ?? new Date()).toISOString();
        const active = this.rows.find((row) =>
          row.sessionId === sessionId && row.phase === "active"
        );
        if (active) {
          const exactIdentity = active.manifestId === input.manifestId
            && active.runtimeEnvIdentity === input.runtimeEnvIdentity
            && active.registrationId === input.registrationId
            && active.pid === input.pid
            && active.startIdentity === input.startIdentity
            && active.executionCommandId === input.executionCommandId;
          this.trace.push(
            `${sessionId}:${exactIdentity ? "exact-adopt" : "conflict"}`
              + `:${active.ownershipGeneration}:${active.phase}`,
          );
          return {
            eventId: ++this.eventId,
            applied: exactIdentity,
            canonicalSession: runningProjection(input.reviewState, updatedAt),
            canonicalExecutionOwnership: canonicalOwnership(active, input.ownerKind),
          };
        }
        const ownershipGeneration = this.rows.reduce(
          (highest, row) => row.sessionId === sessionId
            ? Math.max(highest, row.ownershipGeneration)
            : highest,
          0,
        ) + 1;
        const row: CutoverOwnershipRow = {
          sessionId,
          ownershipGeneration,
          ownerKind: input.ownerKind,
          manifestId: input.manifestId,
          runtimeEnvIdentity: input.runtimeEnvIdentity,
          registrationId: input.registrationId,
          pid: input.pid,
          startIdentity: input.startIdentity,
          executionCommandId: input.executionCommandId,
          phase: "active",
          terminalAt: null,
          runnerFact: null,
          failureReason: null,
        };
        this.rows.push(row);
        this.trace.push(`${sessionId}:acquire:${ownershipGeneration}:active`);
        return {
          eventId: ++this.eventId,
          applied: true,
          canonicalSession: runningProjection(input.reviewState, updatedAt),
          canonicalExecutionOwnership: canonicalOwnership(row),
        };
      },
    );
    const releaseExecutionOwnershipAndWaitForApplication = vi.fn(
      async (sessionId: string, event: SSEEventPayload, input: ReleaseInput) => {
        const row = this.rows.find((candidate) =>
          candidate.sessionId === sessionId
          && candidate.ownershipGeneration === input.ownershipGeneration
          && candidate.executionCommandId === input.executionCommandId
        );
        if (!row || row.phase !== "active") {
          throw new Error(
            `ownership release did not match one active row: ${sessionId}`
              + ` generation=${input.ownershipGeneration}`,
          );
        }
        row.phase = "terminal";
        row.terminalAt = (input.updatedAt ?? new Date()).toISOString();
        row.runnerFact = input.runnerFact;
        this.trace.push(`${sessionId}:release:${row.ownershipGeneration}:terminal`);
        const terminal = await base.releaseExecutionOwnershipAndWaitForApplication(
          sessionId,
          event,
          input,
        );
        return {
          ...terminal,
          canonicalExecutionOwnership: null,
        };
      },
    );
    const persistence = Object.assign(base.persistence, {
      acquireExecutionOwnershipAndWaitForApplication,
      releaseExecutionOwnershipAndWaitForApplication,
    });
    return {
      ...base,
      persistence,
      acquireExecutionOwnershipAndWaitForApplication,
      releaseExecutionOwnershipAndWaitForApplication,
    };
  }

  rowsFor(sessionId: string): CutoverOwnershipRow[] {
    return this.rows
      .filter((row) => row.sessionId === sessionId)
      .map((row) => ({ ...row }));
  }

  nonTerminalRowsFor(sessionId: string): CutoverOwnershipRow[] {
    return this.rowsFor(sessionId).filter((row) => row.phase !== "terminal");
  }
}

function runningProjection(reviewState: string, updatedAt: string) {
  return {
    status: "running",
    termination_reason: null,
    termination_detail: null,
    review_state: reviewState,
    last_assistant_text: null,
    termination_event_id: null,
    updated_at: updatedAt,
    last_event_id: null,
  };
}

function canonicalOwnership(
  row: CutoverOwnershipRow,
  ownerKind: CutoverOwnershipRow["ownerKind"] = row.ownerKind,
) {
  return {
    ownershipGeneration: row.ownershipGeneration,
    ownerKind,
    manifestId: row.manifestId,
    runtimeEnvIdentity: row.runtimeEnvIdentity,
    registrationId: row.registrationId,
    pid: row.pid,
    startIdentity: row.startIdentity,
    executionCommandId: row.executionCommandId,
    phase: "active" as const,
    failureReason: null,
  };
}

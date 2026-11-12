/**
 * Intervention handoff receipts.
 *
 * The runner records the intervention number immediately before it hands the
 * input to its engine so a later lookup can tell "the engine received this"
 * apart from "this runner never saw it". The node asks over an invoke
 * capability; the answer carries both the row's registration and the answering
 * runner's registration so a receipt from a previous runner is not mistaken for
 * one from the current runner.
 */
export const RUNNER_INTERVENTION_RECEIPT_CAPABILITY = "runner.intervention_receipt";

export type RunnerInterventionReceiptState = "handing" | "applied" | "not_applied";

/** Node-side verdict. Unknown never triggers an automatic resend by itself. */
export type RunnerInterventionReceiptVerdict = "applied" | "not_applied" | "unknown";

export interface RunnerInterventionReceiptRow {
  state: RunnerInterventionReceiptState;
  registrationId: string;
}

export interface RunnerInterventionReceiptAnswer {
  /** null means this runner never received that intervention number. */
  row: RunnerInterventionReceiptRow | null;
  runnerRegistrationId: string;
}

/** The runner-side port the command dispatcher records through. */
export interface RunnerInterventionReceiptPort {
  recordHanding(interventionIds: readonly string[], executionCommandId: string | null): void;
  markApplied(interventionIds: readonly string[]): void;
  markNotApplied(interventionIds: readonly string[]): void;
  lookup(interventionId: string): RunnerInterventionReceiptAnswer;
}

/**
 * Additive table: the runner database schema version stays 11 because old
 * readers only check `user_version` and never enumerate tables. One row per
 * intervention number; a repeated handoff rewrites that row.
 */
export const RUNNER_INTERVENTION_RECEIPT_DDL = `
CREATE TABLE IF NOT EXISTS runner_intervention_receipt (
  intervention_id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL CHECK (length(registration_id) > 0),
  execution_command_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('handing', 'applied', 'not_applied')),
  updated_at TEXT NOT NULL
) STRICT;
`;

/**
 * The node attaches the intervention number to the engine input. An older
 * runner passes the unknown field through to its engine, whose intervention
 * method only reads the fields it knows.
 */
export function runnerInputInterventionId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).runnerInterventionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function judgeRunnerInterventionReceipt(
  answer: unknown,
  expectedRegistrationId: string,
): RunnerInterventionReceiptVerdict {
  const parsed = parseRunnerInterventionReceiptAnswer(answer);
  if (!parsed) return "unknown";
  // A different runner answered. Its "never received" says nothing about the
  // runner the node originally handed the intervention to.
  if (parsed.runnerRegistrationId !== expectedRegistrationId) return "unknown";
  if (parsed.row === null) return "not_applied";
  if (parsed.row.state === "applied") {
    return parsed.row.registrationId === expectedRegistrationId ? "applied" : "unknown";
  }
  if (parsed.row.state === "not_applied") return "not_applied";
  return "unknown";
}

function parseRunnerInterventionReceiptAnswer(
  value: unknown,
): RunnerInterventionReceiptAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (typeof answer.runnerRegistrationId !== "string" || answer.runnerRegistrationId.length === 0) {
    return null;
  }
  if (answer.row === null) {
    return { row: null, runnerRegistrationId: answer.runnerRegistrationId };
  }
  if (typeof answer.row !== "object" || Array.isArray(answer.row)) return null;
  const row = answer.row as Record<string, unknown>;
  if (
    !isReceiptState(row.state)
    || typeof row.registrationId !== "string"
    || row.registrationId.length === 0
  ) {
    return null;
  }
  return {
    row: { state: row.state, registrationId: row.registrationId },
    runnerRegistrationId: answer.runnerRegistrationId,
  };
}

function isReceiptState(value: unknown): value is RunnerInterventionReceiptState {
  return value === "handing" || value === "applied" || value === "not_applied";
}

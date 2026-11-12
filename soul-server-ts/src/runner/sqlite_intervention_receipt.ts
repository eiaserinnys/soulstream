import type { DatabaseSync } from "node:sqlite";

import {
  RUNNER_INTERVENTION_RECEIPT_DDL,
  type RunnerInterventionReceiptAnswer,
  type RunnerInterventionReceiptPort,
  type RunnerInterventionReceiptState,
} from "./runner_intervention_receipt.js";
import {
  openRunnerSqliteDatabase,
  requireRunnerSqliteWal,
  withRunnerSqliteTransactionSync,
} from "./runner_sqlite_connection.js";

export interface RunnerSqliteInterventionReceiptOptions {
  sessionId?: string;
  now?: () => Date;
}

/**
 * Owns the intervention receipt table on its own connection, like the
 * lifecycle store. It never touches the event ledger or the intervention inbox.
 */
export class RunnerSqliteInterventionReceipt implements RunnerInterventionReceiptPort {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly registrationId: string,
    private readonly options: RunnerSqliteInterventionReceiptOptions,
  ) {}

  static open(
    databasePath: string,
    registrationId: string,
    options: RunnerSqliteInterventionReceiptOptions = {},
  ): RunnerSqliteInterventionReceipt {
    requireId(registrationId, "runner registration id");
    const database = openRunnerSqliteDatabase(databasePath);
    try {
      requireRunnerSqliteWal(database);
      database.exec(RUNNER_INTERVENTION_RECEIPT_DDL);
      return new RunnerSqliteInterventionReceipt(database, registrationId, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  recordHanding(
    interventionIds: readonly string[],
    executionCommandId: string | null,
  ): void {
    const ids = uniqueIds(interventionIds);
    if (ids.length === 0) return;
    const updatedAt = this.timestamp();
    this.transaction("intervention_receipt.handing", () => {
      const statement = this.database.prepare(`
        INSERT INTO runner_intervention_receipt (
          intervention_id, registration_id, execution_command_id, state, updated_at
        ) VALUES (?, ?, ?, 'handing', ?)
        ON CONFLICT(intervention_id) DO UPDATE SET
          registration_id = excluded.registration_id,
          execution_command_id = excluded.execution_command_id,
          state = 'handing',
          updated_at = excluded.updated_at
      `);
      for (const interventionId of ids) {
        statement.run(interventionId, this.registrationId, executionCommandId, updatedAt);
      }
    });
  }

  markApplied(interventionIds: readonly string[]): void {
    this.mark("intervention_receipt.applied", interventionIds, "applied");
  }

  markNotApplied(interventionIds: readonly string[]): void {
    this.mark("intervention_receipt.not_applied", interventionIds, "not_applied");
  }

  lookup(interventionId: string): RunnerInterventionReceiptAnswer {
    requireId(interventionId, "runner intervention id");
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT registration_id, state
      FROM runner_intervention_receipt
      WHERE intervention_id = ?
    `).get(interventionId) as {
      registration_id: string;
      state: RunnerInterventionReceiptState;
    } | undefined;
    return {
      row: row === undefined
        ? null
        : { state: row.state, registrationId: row.registration_id },
      runnerRegistrationId: this.registrationId,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private mark(
    transactionLabel: string,
    interventionIds: readonly string[],
    state: Extract<RunnerInterventionReceiptState, "applied" | "not_applied">,
  ): void {
    const ids = uniqueIds(interventionIds);
    if (ids.length === 0) return;
    const updatedAt = this.timestamp();
    this.transaction(transactionLabel, () => {
      const statement = this.database.prepare(`
        UPDATE runner_intervention_receipt
        SET state = ?, updated_at = ?
        WHERE intervention_id = ?
      `);
      for (const interventionId of ids) {
        const result = statement.run(state, updatedAt, interventionId);
        if (result.changes !== 1) {
          throw new Error(`runner intervention receipt missing: ${interventionId}`);
        }
      }
    });
  }

  private transaction<T>(transactionLabel: string, operation: () => T): T {
    this.requireOpen();
    return withRunnerSqliteTransactionSync(this.database, operation, {
      transactionLabel,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
    });
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner intervention receipt store is closed");
  }
}

function uniqueIds(interventionIds: readonly string[]): string[] {
  const ids: string[] = [];
  for (const interventionId of interventionIds) {
    requireId(interventionId, "runner intervention id");
    if (!ids.includes(interventionId)) ids.push(interventionId);
  }
  return ids;
}

function requireId(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} required`);
}

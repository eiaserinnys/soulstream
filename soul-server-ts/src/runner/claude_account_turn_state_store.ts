import type { DatabaseSync } from "node:sqlite";

import type {
  ClaudeAccountTurnState,
  ClaudeAccountTurnStatePort,
} from "../engine/claude_account_pool.js";
import {
  openRunnerSqliteDatabase,
  requireRunnerSqliteWal,
  withRunnerSqliteTransaction,
} from "./runner_sqlite_connection.js";

export class RunnerClaudeAccountTurnStateStore implements ClaudeAccountTurnStatePort {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly sessionId: string,
  ) {}

  static open(databasePath: string, sessionId: string): RunnerClaudeAccountTurnStateStore {
    const database = openRunnerSqliteDatabase(databasePath);
    try {
      requireRunnerSqliteWal(database);
      database.exec(`
        CREATE TABLE IF NOT EXISTS runner_claude_account_turn (
          session_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          attempted_ids_json TEXT NOT NULL,
          continuation_uuid TEXT,
          continuation_sent INTEGER NOT NULL
        )
      `);
      return new RunnerClaudeAccountTurnStateStore(database, sessionId);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  read(): ClaudeAccountTurnState | null {
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT turn_id, account_id, attempted_ids_json, continuation_uuid, continuation_sent
      FROM runner_claude_account_turn WHERE session_id = ?
    `).get(this.sessionId) as {
      turn_id: string;
      account_id: string;
      attempted_ids_json: string;
      continuation_uuid: string | null;
      continuation_sent: number;
    } | undefined;
    if (!row) return null;
    let attemptedIds: unknown;
    try {
      attemptedIds = JSON.parse(row.attempted_ids_json);
    } catch (error) {
      throw new Error("runner Claude account turn has invalid attempted_ids_json", { cause: error });
    }
    if (!Array.isArray(attemptedIds) || attemptedIds.some((value) => typeof value !== "string")) {
      throw new Error("runner Claude account turn has invalid attempted_ids_json");
    }
    return {
      turn_id: row.turn_id,
      account_id: row.account_id,
      attempted_ids: attemptedIds,
      continuation_uuid: row.continuation_uuid,
      continuation_sent: row.continuation_sent === 1,
    };
  }

  async write(state: ClaudeAccountTurnState): Promise<void> {
    this.requireOpen();
    await withRunnerSqliteTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO runner_claude_account_turn (
          session_id, turn_id, account_id, attempted_ids_json,
          continuation_uuid, continuation_sent
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          turn_id = excluded.turn_id,
          account_id = excluded.account_id,
          attempted_ids_json = excluded.attempted_ids_json,
          continuation_uuid = excluded.continuation_uuid,
          continuation_sent = excluded.continuation_sent
      `).run(
        this.sessionId,
        state.turn_id,
        state.account_id,
        JSON.stringify(state.attempted_ids),
        state.continuation_uuid,
        state.continuation_sent ? 1 : 0,
      );
    }, { transactionLabel: "claude_account_turn.write", sessionId: this.sessionId });
  }

  async clear(turnId: string): Promise<void> {
    this.requireOpen();
    await withRunnerSqliteTransaction(this.database, () => {
      this.database.prepare(`
        DELETE FROM runner_claude_account_turn WHERE session_id = ? AND turn_id = ?
      `).run(this.sessionId, turnId);
    }, { transactionLabel: "claude_account_turn.clear", sessionId: this.sessionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner Claude account turn store is closed");
  }
}

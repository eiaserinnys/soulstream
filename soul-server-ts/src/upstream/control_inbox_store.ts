import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { ControlCommandFamily } from "./control_command_inventory.js";

const requireNodeBuiltin = createRequire(import.meta.url);
const CONTROL_INBOX_SCHEMA_VERSION = 1;

export type ControlInboxState = "pending" | "claimed" | "completed" | "rejected";

export type ControlInboxWork = {
  nodeId: string;
  commandFamily: ControlCommandFamily;
  requestId: string;
  payloadHash: string;
  command: Record<string, unknown>;
  state: "claimed";
  hostGeneration: string;
  leaseExpiresAt: number;
};

export type ControlInboxAdmission = {
  status: "accepted" | "duplicate" | "conflict";
  state: ControlInboxState;
  payloadHash: string;
  existingPayloadHash?: string;
};

export type ControlInboxResult = {
  resultId: string;
  nodeId: string;
  commandFamily: ControlCommandFamily;
  requestId: string;
  payloadHash: string;
  state: "completed" | "rejected";
  response: Record<string, unknown>;
};

export type ControlInboxStoreOptions = {
  databasePath: string;
  nodeId: string;
  hostGeneration: string;
  nowMs?: () => number;
};

type InboxRow = {
  node_id: string;
  command_family: ControlCommandFamily;
  request_id: string;
  payload_hash: string;
  command_json: string;
  state: ControlInboxState;
  host_generation: string | null;
  lease_expires_at: number | null;
  result_id: string | null;
  result_json: string | null;
  result_acked_at: number | null;
};

export class ControlInboxStore {
  private database: DatabaseSync | undefined;
  private readonly nowMs: () => number;

  constructor(private readonly options: ControlInboxStoreOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  initialize(): { reclaimed: number; pending: number; replayableResults: number } {
    if (this.database) throw new Error("ControlInboxStore is already initialized");
    mkdirSync(dirname(this.options.databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeBuiltin("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(this.options.databasePath);
    this.database = database;
    try {
      database.exec("PRAGMA busy_timeout = 1000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS control_inbox (
          node_id TEXT NOT NULL,
          command_family TEXT NOT NULL,
          request_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          command_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'rejected')),
          host_generation TEXT,
          lease_expires_at INTEGER,
          result_id TEXT,
          result_json TEXT,
          result_acked_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (node_id, command_family, request_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS control_inbox_result_id_uq
          ON control_inbox(result_id) WHERE result_id IS NOT NULL;
        PRAGMA user_version = ${CONTROL_INBOX_SCHEMA_VERSION};
      `);
      const now = this.nowMs();
      const reclaimed = database.prepare(`
        UPDATE control_inbox
        SET state = 'pending', host_generation = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE node_id = ? AND state = 'claimed'
          AND (host_generation <> ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).run(now, this.options.nodeId, this.options.hostGeneration, now).changes;
      return {
        reclaimed: Number(reclaimed),
        pending: this.count("state = 'pending'"),
        replayableResults: this.count(
          "state IN ('completed', 'rejected') AND result_json IS NOT NULL AND result_acked_at IS NULL",
        ),
      };
    } catch (error) {
      database.close();
      this.database = undefined;
      throw error;
    }
  }

  admit(
    commandFamily: ControlCommandFamily,
    command: Record<string, unknown>,
  ): ControlInboxAdmission {
    const database = this.requireDatabase();
    const requestId = requiredString(command.requestId ?? command.request_id, "requestId");
    const payloadHash = canonicalControlPayloadHash(command);
    return this.transaction(() => {
      const existing = this.read(commandFamily, requestId);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          return {
            status: "conflict",
            state: existing.state,
            payloadHash,
            existingPayloadHash: existing.payload_hash,
          };
        }
        if (
          (existing.state === "completed" || existing.state === "rejected")
          && existing.result_id !== null
          && existing.result_json !== null
        ) {
          database.prepare(`
            UPDATE control_inbox
            SET result_acked_at = NULL, updated_at = ?
            WHERE node_id = ? AND command_family = ? AND request_id = ?
          `).run(this.nowMs(), this.options.nodeId, commandFamily, requestId);
        }
        return { status: "duplicate", state: existing.state, payloadHash };
      }
      const now = this.nowMs();
      database.prepare(`
        INSERT INTO control_inbox (
          node_id, command_family, request_id, payload_hash, command_json,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        this.options.nodeId,
        commandFamily,
        requestId,
        payloadHash,
        JSON.stringify(command),
        now,
        now,
      );
      return { status: "accepted", state: "pending", payloadHash };
    });
  }

  claimPending(options: { leaseMs: number; limit: number }): ControlInboxWork[] {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new Error("Control inbox leaseMs must be a positive integer");
    }
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new Error("Control inbox claim limit must be a positive integer");
    }
    const database = this.requireDatabase();
    return this.transaction(() => {
      const rows = database.prepare(`
        SELECT * FROM control_inbox
        WHERE node_id = ? AND state = 'pending'
        ORDER BY created_at, command_family, request_id
        LIMIT ?
      `).all(this.options.nodeId, options.limit) as InboxRow[];
      const now = this.nowMs();
      const leaseExpiresAt = now + options.leaseMs;
      const claim = database.prepare(`
        UPDATE control_inbox
        SET state = 'claimed', host_generation = ?, lease_expires_at = ?, updated_at = ?
        WHERE node_id = ? AND command_family = ? AND request_id = ? AND state = 'pending'
      `);
      const claimed: ControlInboxWork[] = [];
      for (const row of rows) {
        const result = claim.run(
          this.options.hostGeneration,
          leaseExpiresAt,
          now,
          row.node_id,
          row.command_family,
          row.request_id,
        );
        if (Number(result.changes) !== 1) continue;
        claimed.push({
          nodeId: row.node_id,
          commandFamily: row.command_family,
          requestId: row.request_id,
          payloadHash: row.payload_hash,
          command: parseRecord(row.command_json, "control inbox command"),
          state: "claimed",
          hostGeneration: this.options.hostGeneration,
          leaseExpiresAt,
        });
      }
      return claimed;
    });
  }

  complete(
    work: ControlInboxWork,
    response: Record<string, unknown>,
    state: "completed" | "rejected" = response.type === "error"
      ? "rejected"
      : "completed",
  ): ControlInboxResult {
    const database = this.requireDatabase();
    const resultId = controlResultId(work);
    const updated = database.prepare(`
      UPDATE control_inbox
      SET state = ?, result_id = ?, result_json = ?, result_acked_at = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE node_id = ? AND command_family = ? AND request_id = ?
        AND state = 'claimed' AND host_generation = ? AND payload_hash = ?
    `).run(
      state,
      resultId,
      JSON.stringify(response),
      this.nowMs(),
      work.nodeId,
      work.commandFamily,
      work.requestId,
      work.hostGeneration,
      work.payloadHash,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error(`Control inbox claim fence rejected result: ${work.requestId}`);
    }
    return { ...work, state, resultId, response };
  }

  listReplayableResults(): ControlInboxResult[] {
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM control_inbox
      WHERE node_id = ? AND state IN ('completed', 'rejected')
        AND result_json IS NOT NULL AND result_id IS NOT NULL AND result_acked_at IS NULL
      ORDER BY updated_at, command_family, request_id
    `).all(this.options.nodeId) as InboxRow[];
    return rows.map((row) => ({
      resultId: row.result_id!,
      nodeId: row.node_id,
      commandFamily: row.command_family,
      requestId: row.request_id,
      payloadHash: row.payload_hash,
      state: row.state as "completed" | "rejected",
      response: parseRecord(row.result_json!, "control inbox result"),
    }));
  }

  acknowledgeResult(resultId: string): boolean {
    const result = this.requireDatabase().prepare(`
      UPDATE control_inbox SET result_acked_at = ?, updated_at = ?
      WHERE node_id = ? AND result_id = ? AND result_acked_at IS NULL
    `).run(this.nowMs(), this.nowMs(), this.options.nodeId, resultId);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private read(commandFamily: ControlCommandFamily, requestId: string): InboxRow | undefined {
    return this.requireDatabase().prepare(`
      SELECT * FROM control_inbox
      WHERE node_id = ? AND command_family = ? AND request_id = ?
    `).get(this.options.nodeId, commandFamily, requestId) as InboxRow | undefined;
  }

  private count(where: string): number {
    const row = this.requireDatabase().prepare(
      `SELECT COUNT(*) AS count FROM control_inbox WHERE node_id = ? AND ${where}`,
    ).get(this.options.nodeId) as { count: number };
    return Number(row.count);
  }

  private transaction<T>(operation: () => T): T {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original storage failure.
      }
      throw error;
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("ControlInboxStore is not initialized");
    return this.database;
  }
}

export function canonicalControlPayloadHash(value: unknown): string {
  return createHash("sha256")
    .update("soulstream-control-command-v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Control command payload must be finite JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, normalizeJson(input[key])]),
    );
  }
  throw new Error(`Control command payload is not JSON: ${typeof value}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Control inbox command requires ${field}`);
  }
  return value;
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function controlResultId(work: Pick<
  ControlInboxWork,
  "nodeId" | "commandFamily" | "requestId" | "payloadHash"
>): string {
  const digest = createHash("sha256")
    .update("soulstream-control-result-v1\0")
    .update(work.nodeId)
    .update("\0")
    .update(work.commandFamily)
    .update("\0")
    .update(work.requestId)
    .update("\0")
    .update(work.payloadHash)
    .digest("hex");
  return `control-result:${digest}`;
}

import { describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ClaudeBackgroundTaskRepository } from
  "../src/control_plane/repositories/claude_background_task_repository.js";
import { ClaudeTranscriptRepository } from
  "../src/control_plane/repositories/claude_transcript_repository.js";

type SqlCall = { text: string; values: unknown[] };

describe("runner host mutation owners", () => {
  it("commits transcript append and its correlation receipt once", async () => {
    const receipts = new Map<string, Record<string, unknown>>();
    let applications = 0;
    const { sql } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipts.has("runner:append:1") ? [receipts.get("runner:append:1")!] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipts.set(String(values[0]), {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        });
        return [];
      }
      if (text.includes("claude_transcript_append")) {
        applications += 1;
        return [{ claude_transcript_append: 2 }];
      }
      return [];
    });
    const repository = new ClaudeTranscriptRepository(sql);
    const input = {
      idempotencyKey: "runner:append:1",
      sessionId: "session-a",
      key: { projectKey: "project-a", sessionId: "session-a" },
      entries: [{ type: "user", message: { role: "user", content: "hello" } }],
    } as never;

    await expect(repository.appendClaudeTranscriptEntriesIdempotent(input)).resolves.toBe(2);
    await expect(repository.appendClaudeTranscriptEntriesIdempotent(input)).resolves.toBe(2);

    expect(applications).toBe(1);
  });

  it("commits background observation and its correlation receipt once", async () => {
    const receipts = new Map<string, Record<string, unknown>>();
    let applications = 0;
    const row = {
      source_node: "node-a",
      session_id: "session-a",
      task_id: "task-a",
      status: "running",
    };
    const { sql } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipts.has("runner:observe:1") ? [receipts.get("runner:observe:1")!] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipts.set(String(values[0]), {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        });
        return [];
      }
      if (text.includes("INSERT INTO claude_background_tasks")) {
        applications += 1;
        return [row];
      }
      return [];
    });
    const repository = new ClaudeBackgroundTaskRepository(sql);
    const input = {
      idempotencyKey: "runner:observe:1",
      sourceNode: "node-a",
      sessionId: "session-a",
      taskId: "task-a",
      status: "running" as const,
    };

    await expect(repository.observe(input)).resolves.toMatchObject(row);
    await expect(repository.observe(input)).resolves.toMatchObject(row);

    expect(applications).toBe(1);
  });

  it("commits transcript deletion and its correlation receipt once", async () => {
    const receipts = new Map<string, Record<string, unknown>>();
    let applications = 0;
    const { sql } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipts.has("runner:delete:1") ? [receipts.get("runner:delete:1")!] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipts.set(String(values[0]), {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        });
        return [];
      }
      if (text.includes("claude_transcript_delete")) applications += 1;
      return [];
    });
    const repository = new ClaudeTranscriptRepository(sql);
    const input = {
      idempotencyKey: "runner:delete:1",
      sessionId: "session-a",
      key: { projectKey: "project-a", sessionId: "sdk-session-a" },
    };

    await repository.deleteClaudeTranscriptIdempotent(input);
    await repository.deleteClaudeTranscriptIdempotent(input);

    expect(applications).toBe(1);
  });

  it("commits background terminalization, delivery, and correlation receipt once", async () => {
    const receipts = new Map<string, Record<string, unknown>>();
    let applications = 0;
    const backgroundRow = {
      source_node: "node-a",
      session_id: "session-a",
      task_id: "task-a",
      status: "completed",
      created_at: new Date("2026-08-06T00:00:00.000Z"),
      updated_at: new Date("2026-08-06T00:00:00.000Z"),
    };
    const deliveryRow = {
      delivery_id: "delivery-a",
      relation_key: "runtime:session-a:task-a",
      completion_id: "completion-a",
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      payload_hash: "hash-a",
      payload: {},
      created_at: new Date("2026-08-06T00:00:00.000Z"),
    };
    const { sql } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipts.has("runner:terminal:1") ? [receipts.get("runner:terminal:1")!] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipts.set(String(values[0]), {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        });
        return [];
      }
      if (text.includes("terminal_revision =")) {
        applications += 1;
        return [backgroundRow];
      }
      if (text.includes("INSERT INTO session_deliveries")) return [deliveryRow];
      if (text.includes("notification_delivery_id")) return [backgroundRow];
      return [];
    });
    const repository = new ClaudeBackgroundTaskRepository(sql);
    const input = {
      idempotencyKey: "runner:terminal:1",
      sourceNode: "node-a",
      sessionId: "session-a",
      taskId: "task-a",
      status: "completed" as const,
      closeReason: "done",
      terminalRevision: "1",
      delivery: {
        deliveryId: "delivery-a",
        relationKey: "runtime:session-a:task-a",
        completionId: "completion-a",
        intent: "runtime_followup" as const,
        source: "claude_runtime_task_followup",
        payloadHash: "hash-a",
        payload: {},
      },
    };

    await expect(repository.terminalize(input)).resolves.toMatchObject({ accepted: true });
    await expect(repository.terminalize(input)).resolves.toMatchObject({ accepted: true });

    expect(applications).toBe(1);
  });
});

function fakeSql(
  execute: (text: string, values: unknown[]) => readonly Record<string, unknown>[],
): { sql: SqlClient; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return execute(text, values);
  }) as unknown as SqlClient;
  const extended = query as unknown as {
    begin<T>(callback: (sql: SqlClient) => Promise<T>): Promise<T>;
    array(values: unknown[]): unknown[];
    json(value: unknown): unknown;
  };
  extended.begin = vi.fn(async <T>(callback: (sql: SqlClient) => Promise<T>) =>
    await callback(query)) as never;
  extended.array = (values) => values;
  extended.json = (value) => value;
  return { sql: query, calls };
}

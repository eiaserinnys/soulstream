import { describe, expect, it, vi } from "vitest";

import { SessionMutationRepository } from
  "../src/control_plane/repositories/session_mutation_repository.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";

type SqlCall = { text: string; values: unknown[] };

describe("SessionMutationRepository", () => {
  it("routes idempotent delete_session through canonical Y.Doc deletion", async () => {
    const { sql, calls } = fakeSql(() => []);
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const repository = new SessionMutationRepository(sql, { deleteSession });

    await repository.deleteSession({
      idempotencyKey: "delete-1",
      sessionId: "session-a",
    });

    expect(deleteSession).toHaveBeenCalledWith("session-a");
    expect(calls.some((call) => call.text.includes("session_delete("))).toBe(false);
  });

  it("applies an allowed transition once and reuses its receipt across timestamp retries", async () => {
    const receipt = new Map<string, Record<string, unknown>>();
    const { sql, calls } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipt.has("resume-1") ? [receipt.get("resume-1")!] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipt.set("resume-1", {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        });
      }
      return [];
    });
    const repository = new SessionMutationRepository(sql);

    await repository.transitionSession({
      idempotencyKey: "resume-1",
      sessionId: "session-a",
      fields: { status: "running", reviewState: "not_required" },
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    await repository.transitionSession({
      idempotencyKey: "resume-1",
      sessionId: "session-a",
      fields: { status: "running", reviewState: "not_required" },
      updatedAt: new Date("2026-08-06T00:00:01.000Z"),
    });

    const mutations = calls.filter((call) => call.text.includes("session_update("));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.values.slice(0, 3)).toEqual([
      "session-a",
      ["status", "review_state"],
      ["running", "not_required"],
    ]);
  });

  it("rejects the same idempotency key for a different semantic mutation", async () => {
    const { sql } = fakeSql((text) =>
      text.includes("FROM session_mutation_receipts")
        ? [{
            operation: "rename_session",
            session_id: "session-a",
            request_hash: "0".repeat(64),
            result_json: { ok: true },
          }]
        : [],
    );
    const repository = new SessionMutationRepository(sql);

    await expect(repository.renameSession({
      idempotencyKey: "rename-1",
      sessionId: "session-a",
      displayName: "새 이름",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects last_event_id and every unknown transition field at the host boundary", async () => {
    const { sql, calls } = fakeSql(() => []);
    const repository = new SessionMutationRepository(sql);

    await expect(repository.transitionSession({
      idempotencyKey: "forbidden-1",
      sessionId: "session-a",
      fields: { status: "running", lastEventId: 9 } as never,
      updatedAt: new Date(),
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toHaveLength(0);
  });

  it("registers through the model-preset stored procedure with the full invariant contract", async () => {
    const { sql, calls } = fakeSql(() => []);
    const repository = new SessionMutationRepository(sql);
    const now = new Date("2026-08-06T00:00:00.000Z");

    await repository.registerSession({
      idempotencyKey: "register-1",
      sessionId: "session-a",
      nodeId: "node-a",
      agentId: "roselin",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "inspect",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      notifyCompletion: true,
      reviewRequired: true,
      reviewState: "not_required",
      modelPreset: "claude-opus",
      model: "claude-opus-4-6",
    });

    const mutation = calls.find((call) =>
      call.text.includes("session_register_with_model_preset"),
    );
    expect(mutation?.values).toEqual([
      "session-a", "node-a", "roselin", null, "claude", "inspect", null,
      "running", now, now, null, true, true, "not_required", null,
      "claude-opus", "claude-opus-4-6",
    ]);
  });

  it("sanitizes only user-authored session text before PostgreSQL mutations", async () => {
    const { sql, calls } = fakeSql(() => []);
    const repository = new SessionMutationRepository(sql);
    const now = new Date("2026-08-06T00:00:00.000Z");

    await repository.registerSession({
      idempotencyKey: "register-sanitize",
      sessionId: "session-a",
      nodeId: "node-a",
      agentId: "roselin",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "inspect\u0000\ud800",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
    });
    await repository.transitionSession({
      idempotencyKey: "transition-sanitize",
      sessionId: "session-a",
      fields: {
        prompt: "resume\u0000\udfff",
        terminationDetail: "system\u0000detail",
      },
      updatedAt: now,
    });
    await repository.renameSession({
      idempotencyKey: "rename-sanitize",
      sessionId: "session-a",
      displayName: "name\u0000\ud800",
    });

    const register = calls.find((call) =>
      call.text.includes("session_register_with_model_preset"),
    );
    const transition = calls.find((call) => call.text.includes("session_update("));
    const rename = calls.find((call) => call.text.includes("session_rename("));
    expect(register?.values[5]).toBe("inspect�");
    expect(transition?.values.slice(1, 3)).toEqual([
      ["prompt", "termination_detail"],
      ["resume�", "system\u0000detail"],
    ]);
    expect(rename?.values).toEqual(["session-a", "name�"]);
  });

  it("reuses a register receipt when transport retry timestamps change", async () => {
    let receipt: Record<string, unknown> | undefined;
    const { sql, calls } = fakeSql((text, values) => {
      if (text.includes("FROM session_mutation_receipts")) {
        return receipt ? [receipt] : [];
      }
      if (text.includes("INSERT INTO session_mutation_receipts")) {
        receipt = {
          operation: values[1],
          session_id: values[2],
          request_hash: values[3],
          result_json: values[4],
        };
      }
      return [];
    });
    const repository = new SessionMutationRepository(sql);
    const input = {
      idempotencyKey: "register-retry",
      sessionId: "session-a",
      nodeId: "node-a",
      agentId: "roselin",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "inspect",
      clientId: null,
      status: "running",
      callerSessionId: null,
      predecessorSessionId: null,
    };

    await repository.registerSession({
      ...input,
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    await repository.registerSession({
      ...input,
      createdAt: new Date("2026-08-06T00:00:01.000Z"),
      updatedAt: new Date("2026-08-06T00:00:01.000Z"),
    });

    expect(calls.filter((call) =>
      call.text.includes("session_register_with_model_preset"),
    )).toHaveLength(1);
  });

  it("reconciles node disconnect and startup with terminal review semantics", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const { sql, calls } = fakeSql((text, values) => {
      if (
        text.includes("SET status = 'interrupted'")
        && !text.includes("termination_detail = 'startup_reconciliation'")
      ) {
        return ["old-a", "old-b"].map((session_id) => ({
          session_id,
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: values.find((value) =>
            value === "node_disconnect" || value === "node_disconnect_timeout"
          ),
          review_state: "acknowledged",
          updated_at: now,
        }));
      }
      if (text.includes("termination_detail = 'startup_reconciliation'")) {
        return ["old-a", "old-b"].map((session_id) => ({
          session_id,
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: "startup_reconciliation",
          review_state: "acknowledged",
          updated_at: now,
        }));
      }
      if (text.includes("SET status = 'running'")) {
        return ["session-live-a", "session-live-b"].map((session_id) => ({
          session_id,
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          updated_at: now,
        }));
      }
      return [];
    });
    const repository = new SessionMutationRepository(sql);

    for (const detail of ["node_disconnect", "node_disconnect_timeout"] as const) {
      await expect(repository.reconcileNodeDisconnected(
        "node-a",
        now,
        detail,
      )).resolves.toMatchObject({
        interrupted: 2,
        updates: [
          expect.objectContaining({ sessionId: "old-a", status: "interrupted" }),
          expect.objectContaining({ sessionId: "old-b", status: "interrupted" }),
        ],
      });
    }
    await expect(repository.reconcileNodeStartup("node-a", ["session-live"], now))
      .resolves.toMatchObject({
        interrupted: 2,
        restored: 2,
        updates: [
          expect.objectContaining({ sessionId: "old-a", status: "interrupted" }),
          expect.objectContaining({ sessionId: "old-b", status: "interrupted" }),
          expect.objectContaining({ sessionId: "session-live-a", status: "running" }),
          expect.objectContaining({ sessionId: "session-live-b", status: "running" }),
        ],
      });

    const statements = calls.map((call) => call.text).join("\n");
    expect(calls.some((call) =>
      call.values.includes("node_disconnect_timeout")
    )).toBe(true);
    expect(calls.some((call) => call.values.includes("node_disconnect"))).toBe(true);
    expect(statements).toContain("termination_detail = 'startup_reconciliation'");
    expect(statements).toContain("WHEN review_required THEN 'needs_review'");
    expect(statements).toContain("review_state = 'not_required'");
    expect(calls.some((call) => call.values.some(
      (value) => Array.isArray(value) && value.includes("session-live"),
    ))).toBe(true);
  });

  it("lists the distinct owner nodes that still have running sessions for startup grace", async () => {
    const { sql, calls } = fakeSql((text) =>
      text.includes("SELECT DISTINCT node_id")
        ? [{ node_id: "node-b" }, { node_id: "node-a" }]
        : [],
    );
    const repository = new SessionMutationRepository(sql);

    await expect(repository.listRunningNodeIds()).resolves.toEqual(["node-b", "node-a"]);
    expect(calls[0]?.text).toContain("status = 'running'");
    expect(calls[0]?.text).toContain("node_id IS NOT NULL");
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

import { describe, expect, it, vi } from "vitest";

import {
  createTaskUserStatusMutation,
  type LivePostgresSql,
  type TaskSnapshot,
} from "../src/index.js";

describe("task user status mutation", () => {
  it("commits completion and user attribution in one transaction", async () => {
    const harness = createSqlHarness({ taskVersion: 4 });
    const loadSnapshot = vi.fn(async (): Promise<TaskSnapshot> => ({
      task: {
        id: "task-1",
        board_item_id: "task:task-1",
        version: 5,
        status: "completed",
        completed_kind: "user",
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: "director@example.com",
      },
      sections: [],
      items: [],
    }));
    const mutate = createTaskUserStatusMutation({
      sqlResolver: {
        resolveSql: async () => harness.sql,
        close: async () => {},
      },
      loadSnapshot,
      createOperationId: () => "operation-1",
    });

    const result = await mutate({
      taskId: "task-1",
      status: "completed",
      expectedVersion: 4,
      idempotencyKey: "complete-user-1",
      reason: "done on iPhone",
      userId: "director@example.com",
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: "task-1",
      eventId: 0,
      idempotent: false,
      operation: {
        id: "operation-1",
        task_id: "task-1",
        operation_type: "set_task_status",
        actor_kind: "user",
        actor_session_id: null,
        actor_event_id: null,
        actor_user_id: "director@example.com",
      },
      snapshot: { task: { version: 5, status: "completed" } },
    });
    expect(harness.transactionCount).toBe(1);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("FROM task_operations"),
      expect.stringContaining("FROM tasks"),
      expect.stringContaining("UPDATE tasks"),
      expect.stringContaining("INSERT INTO task_operations"),
    ]);
    const update = harness.calls.find((call) => call.text.includes("UPDATE tasks"));
    expect(update?.values).toEqual(expect.arrayContaining([
      "completed",
      "user",
      "director@example.com",
      4,
      "task-1",
    ]));
    expect(loadSnapshot).toHaveBeenCalledWith("task-1");
  });

  it("clears completion attribution when a user reopens a task", async () => {
    const harness = createSqlHarness({ taskVersion: 7 });
    const mutate = createTaskUserStatusMutation({
      sqlResolver: {
        resolveSql: async () => harness.sql,
        close: async () => {},
      },
      loadSnapshot: async () => ({
        task: { id: "task-1", board_item_id: "task:task-1", status: "open" },
      }),
      createOperationId: () => "operation-open",
    });

    await mutate({
      taskId: "task-1",
      status: "open",
      expectedVersion: 7,
      idempotencyKey: "reopen-user-1",
      userId: "director@example.com",
    });

    expect(harness.normalizedCalls()).toContainEqual(expect.stringContaining("completed_kind = NULL"));
    expect(harness.normalizedCalls()).toContainEqual(expect.stringContaining("completed_user_id = NULL"));
  });

  it("returns an idempotent result without updating the task twice", async () => {
    const harness = createSqlHarness({
      taskVersion: 9,
      existingOperation: operationRow("operation-existing"),
    });
    const mutate = createTaskUserStatusMutation({
      sqlResolver: {
        resolveSql: async () => harness.sql,
        close: async () => {},
      },
      loadSnapshot: async () => ({
        task: { id: "task-1", board_item_id: "task:task-1", version: 9 },
      }),
      createOperationId: () => "operation-unused",
    });

    const result = await mutate({
      taskId: "task-1",
      status: "completed",
      expectedVersion: 8,
      idempotencyKey: "existing-idem",
      userId: "director@example.com",
    });

    expect(result.idempotent).toBe(true);
    expect(result.operation.id).toBe("operation-existing");
    expect(harness.normalizedCalls()).not.toContainEqual(expect.stringContaining("UPDATE tasks"));
  });

  it("reports a structured version conflict", async () => {
    const harness = createSqlHarness({ taskVersion: 6 });
    const mutate = createTaskUserStatusMutation({
      sqlResolver: {
        resolveSql: async () => harness.sql,
        close: async () => {},
      },
      loadSnapshot: async () => ({
        task: { id: "task-1", board_item_id: "task:task-1" },
      }),
      createOperationId: () => "operation-unused",
    });

    await expect(mutate({
      taskId: "task-1",
      status: "completed",
      expectedVersion: 5,
      idempotencyKey: "stale",
      userId: "director@example.com",
    })).rejects.toMatchObject({
      code: "TASK_VERSION_CONFLICT",
      statusCode: 409,
    });
  });
});

type SqlCall = { text: string; values: unknown[] };

function operationRow(id: string): Record<string, unknown> {
  return {
    id,
    task_id: "task-1",
    target_kind: "task",
    target_id: "task-1",
    operation_type: "set_task_status",
    actor_kind: "user",
    actor_session_id: null,
    actor_event_id: null,
    actor_user_id: "director@example.com",
    idempotency_key: "existing-idem",
    payload_json: { status: "completed" },
    reason: null,
  };
}

function createSqlHarness(options: {
  taskVersion: number;
  existingOperation?: Record<string, unknown>;
}) {
  const calls: SqlCall[] = [];
  let transactionCount = 0;
  const queryFunction = vi.fn(async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes("FROM task_operations")) {
      return options.existingOperation ? [options.existingOperation] : [];
    }
    if (text.includes("FROM tasks")) {
      return [{
        id: "task-1",
        board_item_id: "task:task-1",
        version: options.taskVersion,
      }];
    }
    if (text.includes("UPDATE tasks")) {
      return [{ id: "task-1", version: options.taskVersion + 1 }];
    }
    if (text.includes("INSERT INTO task_operations")) {
      return [operationRow(String(values[0]))];
    }
    return [];
  });
  const query = Object.assign(queryFunction, {
    json: (value: unknown) => value,
    array: (value: readonly unknown[]) => value,
    begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => {
      transactionCount += 1;
      return await callback(query as unknown as LivePostgresSql);
    },
  }) as unknown as LivePostgresSql & {
    begin<T>(callback: (transaction: LivePostgresSql) => Promise<T>): Promise<T>;
    array(values: readonly unknown[]): unknown;
  };

  return {
    sql: query,
    calls,
    get transactionCount() { return transactionCount; },
    normalizedCalls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}

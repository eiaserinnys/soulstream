import { describe, expect, it, vi } from "vitest";

import {
  TaskMutationRouteError,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB task route providers", () => {
  it("lists tasks from Postgres with linked session serialization", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("WITH RECURSIVE subtree")) {
        return [
          taskRow({
            id: "task-root",
            title: "Root",
            linked_session_id: "sess-linked",
          }),
        ];
      }
      if (text.includes("FROM sessions")) return [sessionRow("sess-linked")];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.taskReadProvider.listTasks({
        query: " root ",
        status: "open",
        rootTaskId: "task-root",
        linkedSessionId: "sess-linked",
        includeArchived: true,
        limit: 25,
      }),
    ).resolves.toMatchObject([
      {
        id: "task-root",
        title: "Root",
        linkedSessionId: "sess-linked",
        linkedSession: {
          agentSessionId: "sess-linked",
          displayName: "Linked sess-linked",
        },
      },
    ]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("WITH RECURSIVE subtree AS"),
      "SELECT * FROM sessions WHERE session_id = ANY(?::text[])",
    ]);
    expect(harness.calls[0]?.values).toEqual([
      "task-root",
      true,
      "open",
      "open",
      "sess-linked",
      "sess-linked",
      "%root%",
      "%root%",
      "%root%",
      "%root%",
      25,
    ]);
  });

  it("loads active task context with path and linked tasks", async () => {
    const harness = createSqlHarness((text, values) => {
      if (text.includes("WITH RECURSIVE ancestors")) {
        return [
          taskRow({ id: "task-root", title: "Root" }),
          taskRow({ id: "task-active", parent_id: "task-root", title: "Active" }),
        ];
      }
      if (text.includes("WHERE active_for_session_id")) {
        return [taskRow({ id: "task-active", parent_id: "task-root" })];
      }
      if (text.includes("SELECT * FROM task_items")) {
        expect(values).toContain("sess-1");
        return [taskRow({ id: "task-linked", linked_session_id: "sess-1" })];
      }
      if (text.includes("FROM sessions")) return [sessionRow("sess-1")];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.taskReadProvider.getTaskContext("sess-1")).resolves.toMatchObject({
      activeTask: { id: "task-active" },
      activeTaskPath: [{ id: "task-root" }, { id: "task-active" }],
      linkedTasks: [
        {
          id: "task-linked",
          linkedSession: { agentSessionId: "sess-1" },
        },
      ],
    });
  });

  it("creates task operations with event anchors and idempotent replay", async () => {
    const harness = createSqlHarness((text, values) => {
      if (text.includes("WHERE idempotency_key")) return [];
      if (text.includes("COALESCE(MAX(position_key)")) return [{ position_key: 3 }];
      if (text.includes("INSERT INTO task_items")) {
        return [taskRow({
          id: String(values[0]),
          title: String(values[3]),
          position_key: values[2],
          active_for_session_id: values[10],
          created_from_session_id: values[11],
        })];
      }
      if (text.includes("INSERT INTO task_operations")) {
        return [operationRow({
          id: String(values[0]),
          task_id: values[1],
          operation_type: values[2],
          actor_session_id: values[3],
          idempotency_key: values[4],
          payload_json: JSON.parse(String(values[5])),
          reason: values[6],
        })];
      }
      if (text.includes("event_append")) return [{ event_id: 42 }];
      if (text.includes("UPDATE task_operations")) {
        return [operationRow({
          id: String(values[1]),
          task_id: "task-created",
          operation_type: "create_task_item",
          actor_session_id: "sess-actor",
          actor_event_id: values[0],
          idempotency_key: "idem-create",
        })];
      }
      if (text.includes("created_from_event_id")) {
        return [taskRow({
          id: String(values[2]),
          title: "Created",
          position_key: 3,
          active_for_session_id: "sess-actor",
          created_from_session_id: "sess-actor",
          created_from_event_id: values[0],
          navigation_event_id: values[1],
          version: 2,
        })];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    const result = await repository.taskMutationProvider.createTask({
      sessionId: "sess-actor",
      title: "Created",
      description: "",
      acceptanceCriteria: "",
      verificationOwner: "agent",
      status: "open",
      setActive: true,
      idempotencyKey: "idem-create",
    });

    expect(result).toMatchObject({
      task: {
        title: "Created",
        activeForSessionId: "sess-actor",
        createdFromEventId: 42,
        navigationEventId: 42,
        version: 2,
      },
      operation: {
        operationType: "create_task_item",
        actorEventId: 42,
        idempotencyKey: "idem-create",
      },
      eventId: 42,
    });
    expect(harness.normalizedCalls()).toContain(
      "UPDATE task_items SET active_for_session_id = NULL, updated_at = NOW(), version = version + 1 WHERE active_for_session_id = ?",
    );
    const operationPayload = JSON.parse(
      String(harness.calls.find((call) => call.text.includes("INSERT INTO task_operations"))
        ?.values[5]),
    );
    expect(operationPayload).toMatchObject({
      parent_task_id: null,
      linked_session_id: null,
      linked_node_id: null,
      navigation_event_id: null,
    });
  });

  it("returns existing idempotent operation result without inserting again", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("WHERE idempotency_key")) {
        return [operationRow({
          id: "op-existing",
          task_id: "task-existing",
          operation_type: "set_task_status",
          actor_event_id: 77,
          idempotency_key: "idem-existing",
        })];
      }
      if (text.includes("SELECT * FROM task_items WHERE id")) {
        return [taskRow({ id: "task-existing", status: "blocked" })];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.taskMutationProvider.setTaskStatus("task-existing", {
        sessionId: "sess-actor",
        status: "blocked",
        idempotencyKey: "idem-existing",
      }),
    ).resolves.toMatchObject({
      idempotent: true,
      task: { id: "task-existing", status: "blocked" },
      operation: { id: "op-existing", actorEventId: 77 },
      eventId: 77,
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM task_operations WHERE idempotency_key = ? LIMIT 1",
      "SELECT * FROM task_items WHERE id = ?",
    ]);
  });

  it("rejects move cycles before writing", async () => {
    const harness = createSqlHarness();
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.taskMutationProvider.moveTask("task-1", {
        sessionId: "sess-actor",
        newParentTaskId: "task-1",
      }),
    ).rejects.toMatchObject(new TaskMutationRouteError(422, "task tree cycle is not allowed"));
    expect(harness.calls).toEqual([]);
  });
});

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    parent_id: null,
    position_key: 1,
    title: "Task",
    description: "",
    acceptance_criteria: "",
    verification_owner: "agent",
    status: "open",
    linked_session_id: null,
    linked_node_id: null,
    active_for_session_id: null,
    created_from_session_id: null,
    created_from_event_id: null,
    navigation_session_id: null,
    navigation_node_id: null,
    navigation_event_id: null,
    archived: false,
    pinned: false,
    version: 1,
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:01:00.000Z"),
    ...overrides,
  };
}

function operationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "op-1",
    task_id: "task-1",
    operation_type: "create_task_item",
    actor_kind: "agent",
    actor_session_id: "sess-actor",
    actor_event_id: null,
    actor_user_id: null,
    idempotency_key: null,
    payload_json: {},
    reason: null,
    created_at: new Date("2026-07-09T00:02:00.000Z"),
    ...overrides,
  };
}

function sessionRow(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    status: "completed",
    prompt: "linked",
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:02:00.000Z"),
    session_type: "claude",
    last_message: null,
    client_id: null,
    metadata: {},
    display_name: `Linked ${sessionId}`,
    node_id: "node-a",
    folder_id: null,
    last_event_id: 4,
    last_read_event_id: 4,
    caller_session_id: null,
    agent_id: null,
  };
}

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}

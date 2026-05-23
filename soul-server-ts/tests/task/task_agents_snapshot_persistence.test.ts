import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
} from "../../src/engine/protocol.js";
import { TaskAgentsSnapshotPersistence } from "../../src/task/task_agents_snapshot_persistence.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "agent-openai",
    createdAt: new Date(),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeDeps() {
  const updateSession = vi.fn(async () => undefined);
  const db = { updateSession } as unknown as SessionDB;
  const logger = { warn: vi.fn() } as unknown as Logger;
  return { db, logger, updateSession };
}

describe("TaskAgentsSnapshotPersistence", () => {
  it("replaces run-state metadata while updating runtime resume fields", async () => {
    const deps = makeDeps();
    const persistence = new TaskAgentsSnapshotPersistence(deps);
    const task = makeTask({
      metadata: [
        { type: "caller_info", value: { source: "agent", agent_id: "caller" } },
        { type: "agents_run_state", value: { backend: "openai-agents", serialized: "old" } },
        { type: "other", value: { keep: true } },
      ],
    });
    const snapshot: EngineRunStateSnapshot = {
      backendId: "openai-agents",
      serialized: "state-v2",
      pendingApprovalId: "approval-1",
      previousResponseId: "resp-2",
      conversationId: "conv-2",
      schemaVersion: "1.11",
    };

    await persistence.persistRunStateSnapshot(task, snapshot);

    expect(task.agentsRunState).toBe("state-v2");
    expect(task.agentsPendingApprovalId).toBe("approval-1");
    expect(task.agentsPreviousResponseId).toBe("resp-2");
    expect(task.agentsConversationId).toBe("conv-2");
    expect(task.agentsRunStateSchemaVersion).toBe("1.11");
    expect(task.metadata).toEqual([
      { type: "caller_info", value: { source: "agent", agent_id: "caller" } },
      { type: "other", value: { keep: true } },
      {
        type: "agents_run_state",
        value: {
          backend: "openai-agents",
          serialized: "state-v2",
          pendingApprovalId: "approval-1",
          previousResponseId: "resp-2",
          conversationId: "conv-2",
          schemaVersion: "1.11",
          updatedAt: expect.any(String),
        },
      },
    ]);
    expect(deps.updateSession).toHaveBeenCalledWith("sess-1", {
      metadata: task.metadata,
    });
  });

  it("stores nullable run-state metadata values while clearing runtime fields", async () => {
    const deps = makeDeps();
    const persistence = new TaskAgentsSnapshotPersistence(deps);
    const task = makeTask({
      agentsRunState: "old-state",
      agentsPendingApprovalId: "old-approval",
      agentsPreviousResponseId: "old-resp",
      agentsConversationId: "old-conv",
      agentsRunStateSchemaVersion: "old-schema",
    });

    await persistence.persistRunStateSnapshot(task, {
      backendId: "openai-agents",
      serialized: null,
    });

    expect(task.agentsRunState).toBeUndefined();
    expect(task.agentsPendingApprovalId).toBeUndefined();
    expect(task.agentsPreviousResponseId).toBeUndefined();
    expect(task.agentsConversationId).toBeUndefined();
    expect(task.agentsRunStateSchemaVersion).toBeUndefined();
    expect(task.metadata).toEqual([
      {
        type: "agents_run_state",
        value: {
          backend: "openai-agents",
          serialized: null,
          pendingApprovalId: null,
          previousResponseId: null,
          conversationId: null,
          schemaVersion: null,
          updatedAt: expect.any(String),
        },
      },
    ]);
  });

  it("keeps in-memory run-state metadata when DB update fails", async () => {
    const deps = makeDeps();
    deps.updateSession.mockRejectedValueOnce(new Error("db down"));
    const persistence = new TaskAgentsSnapshotPersistence(deps);
    const task = makeTask();

    await persistence.persistRunStateSnapshot(task, {
      backendId: "openai-agents",
      serialized: "state-v2",
      pendingApprovalId: "approval-1",
    });

    expect(task.agentsRunState).toBe("state-v2");
    expect(task.agentsPendingApprovalId).toBe("approval-1");
    expect(task.metadata).toEqual([
      {
        type: "agents_run_state",
        value: expect.objectContaining({
          backend: "openai-agents",
          serialized: "state-v2",
          pendingApprovalId: "approval-1",
        }),
      },
    ]);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-1" },
      "agents_run_state metadata update failed",
    );
  });

  it("replaces session-items metadata and persists the full metadata array", async () => {
    const deps = makeDeps();
    const persistence = new TaskAgentsSnapshotPersistence(deps);
    const task = makeTask({
      metadata: [
        { type: "agents_session_items", value: { backend: "openai-agents", items: ["old"] } },
        { type: "caller_info", value: { source: "slack" } },
      ],
    });
    const snapshot: EngineSessionItemsSnapshot = {
      backendId: "openai-agents",
      items: [{ role: "user", content: "hello" }],
    };

    await persistence.persistSessionItemsSnapshot(task, snapshot);

    expect(task.agentsSessionItems).toEqual([{ role: "user", content: "hello" }]);
    expect(task.metadata).toEqual([
      { type: "caller_info", value: { source: "slack" } },
      {
        type: "agents_session_items",
        value: {
          backend: "openai-agents",
          items: [{ role: "user", content: "hello" }],
          updatedAt: expect.any(String),
        },
      },
    ]);
    expect(deps.updateSession).toHaveBeenCalledWith("sess-1", {
      metadata: task.metadata,
    });
  });

  it("ignores non-openai-agents snapshots", async () => {
    const deps = makeDeps();
    const persistence = new TaskAgentsSnapshotPersistence(deps);
    const task = makeTask({
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
    });

    await persistence.persistRunStateSnapshot(task, {
      backendId: "codex",
      serialized: "ignored",
    });
    await persistence.persistSessionItemsSnapshot(task, {
      backendId: "claude",
      items: ["ignored"],
    });

    expect(task).toMatchObject({
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
    });
    expect(task.agentsRunState).toBeUndefined();
    expect(task.agentsSessionItems).toBeUndefined();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  TaskItemRow,
  TaskOperationRow,
} from "../../src/task_tree/task_tree_repository.js";
import { TaskTreeService } from "../../src/task_tree/task_tree_service.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<TaskItemRow> = {}): TaskItemRow {
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
    created_from_session_id: "parent-session",
    created_from_event_id: null,
    navigation_session_id: "parent-session",
    navigation_node_id: "node-1",
    navigation_event_id: null,
    archived: false,
    pinned: false,
    version: 1,
    created_at: new Date("2026-05-26T00:00:00Z"),
    updated_at: new Date("2026-05-26T00:00:00Z"),
    ...overrides,
  };
}

function makeOperation(overrides: Partial<TaskOperationRow> = {}): TaskOperationRow {
  return {
    id: "operation-1",
    task_id: "task-1",
    operation_type: "create_task_item",
    actor_kind: "agent",
    actor_session_id: "parent-session",
    actor_event_id: null,
    actor_user_id: null,
    idempotency_key: null,
    payload_json: {},
    reason: null,
    created_at: new Date("2026-05-26T00:00:00Z"),
    ...overrides,
  };
}

function makeHarness(options: {
  callerFolderId?: string | null;
  callerBoardItems?: Array<{
    id: string;
    folderId: string;
    containerKind?: "folder" | "runbook";
    containerId?: string;
    membershipKind?: "primary" | "reference";
    itemType: "session";
    itemId: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }>;
} = {}) {
  let currentTask = makeTask({
    linked_session_id: "child-session",
    linked_node_id: "node-child",
    navigation_session_id: "child-session",
    navigation_node_id: "node-child",
    navigation_event_id: 77,
  });
  const repo = {
    nextPositionKey: vi.fn().mockResolvedValue(1),
    createTaskItem: vi.fn(async (params) => {
      currentTask = makeTask({
        id: params.id,
        parent_id: params.parentId ?? null,
        title: params.title,
        status: params.status ?? "open",
        linked_session_id: params.linkedSessionId ?? null,
        linked_node_id: params.linkedNodeId ?? null,
        active_for_session_id: params.activeForSessionId ?? null,
        created_from_session_id: params.createdFromSessionId ?? null,
        navigation_session_id: params.navigationSessionId ?? null,
        navigation_node_id: params.navigationNodeId ?? null,
        navigation_event_id: params.navigationEventId ?? null,
      });
      return currentTask;
    }),
    patchTaskItem: vi.fn(async (_taskId, fields) => {
      currentTask = {
        ...currentTask,
        ...fields,
        version: currentTask.version + 1,
      };
      return currentTask;
    }),
    clearActiveTaskForSession: vi.fn().mockResolvedValue(undefined),
    getTaskItem: vi.fn(async (taskId) =>
      taskId === currentTask.id ? currentTask : null,
    ),
    wouldCreateCycle: vi.fn().mockResolvedValue(false),
    appendTaskOperation: vi.fn(async (params) =>
      makeOperation({
        id: params.id,
        task_id: params.taskId,
        operation_type: params.operationType,
        actor_session_id: params.actorSessionId,
        idempotency_key: params.idempotencyKey ?? null,
        payload_json: params.payload,
        reason: params.reason ?? null,
      }),
    ),
    setTaskOperationEventId: vi.fn(async (operationId, eventId) =>
      makeOperation({ id: operationId, actor_event_id: eventId }),
    ),
    getTaskOperationByIdempotencyKey: vi.fn().mockResolvedValue(null),
  };
  const appendEvent = vi
    .fn()
    .mockResolvedValueOnce(101)
    .mockResolvedValueOnce(102);
  const createdSessions: Array<Record<string, unknown>> = [];
  const runtime = {
    nodeId: "node-1",
    db: {
      taskTree: () => repo,
      appendEvent,
      getSession: vi.fn(async (sessionId: string) =>
        sessionId === "parent-session"
          ? { folder_id: options.callerFolderId ?? null }
          : null,
      ),
      ensureBoardItems: vi.fn(async () => undefined),
      getBoardItems: vi.fn(async () => options.callerBoardItems ?? []),
      resolveBoardYjsContainerScope: vi.fn(async (container) =>
        container.containerKind === "runbook"
          ? {
              folderId: options.callerFolderId ?? "root",
              containerKind: container.containerKind,
              containerId: container.containerId,
            }
          : {
              folderId: container.containerId,
              containerKind: "folder",
              containerId: container.containerId,
            },
      ),
    },
    agentRegistry: {
      list: () => [{ id: "child-agent", name: "Child Agent" }],
      get: (id: string) =>
        id === "child-agent" || id === "parent-agent"
          ? { id, name: `${id} name`, portrait_path: null }
          : undefined,
    },
    taskManager: {
      getTask: vi.fn().mockReturnValue({ profileId: "parent-agent" }),
      createTask: vi.fn(async (params) => {
        createdSessions.push(params);
        return {
          agentSessionId: params.agentSessionId,
          profileId: params.profileId,
        };
      }),
    },
    taskExecutor: {
      startExecution: vi.fn(),
    },
    logger: silentLogger,
  };

  return {
    service: new TaskTreeService(runtime as never),
    repo,
    appendEvent,
    runtime,
    createdSessions,
  };
}

describe("TaskTreeService", () => {
  it.each([
    ["createTaskItem", (h: ReturnType<typeof makeHarness>) =>
      h.service.createTaskItem({
        sessionId: "parent-session",
        title: "New task",
      })],
    ["delegateTaskItem", (h: ReturnType<typeof makeHarness>) =>
      h.service.delegateTaskItem({
        sessionId: "parent-session",
        parentTaskId: "task-parent",
        title: "Child task",
        prompt: "Do the work",
        agentId: "child-agent",
      })],
  ])("%s blocks v1 task creation before any side effect", async (_name, run) => {
    const h = makeHarness();

    await expect(run(h)).rejects.toThrow(
      "업무는 create_runbook으로 생성하세요 — folder_id 지정이 필수입니다",
    );
    expect(h.repo.createTaskItem).not.toHaveBeenCalled();
    expect(h.repo.clearActiveTaskForSession).not.toHaveBeenCalled();
    expect(h.runtime.taskManager.createTask).not.toHaveBeenCalled();
    expect(h.runtime.taskExecutor.startExecution).not.toHaveBeenCalled();
  });

  it.each([
    ["setStatus", async (h: ReturnType<typeof makeHarness>) =>
      h.service.setStatus({
        sessionId: "parent-session",
        taskId: "task-1",
        status: "agent_done",
      })],
    ["moveTaskItem", async (h: ReturnType<typeof makeHarness>) =>
      h.service.moveTaskItem({
        sessionId: "parent-session",
        taskId: "task-1",
        newParentTaskId: "task-parent-2",
        positionKey: 2,
      })],
    ["updateTaskItem", async (h: ReturnType<typeof makeHarness>) =>
      h.service.updateTaskItem({
        sessionId: "parent-session",
        taskId: "task-1",
        title: "Updated task",
      })],
    ["setActiveTask", async (h: ReturnType<typeof makeHarness>) =>
      h.service.setActiveTask({
        sessionId: "parent-session",
        taskId: "task-1",
      })],
    ["archiveTaskItem", async (h: ReturnType<typeof makeHarness>) =>
      h.service.archiveTaskItem({
        sessionId: "parent-session",
        taskId: "task-1",
      })],
    ["setPinned", async (h: ReturnType<typeof makeHarness>) =>
      h.service.setPinned({
        sessionId: "parent-session",
        taskId: "task-1",
        pinned: true,
      })],
    ["holdTaskItem", async (h: ReturnType<typeof makeHarness>) =>
      h.service.holdTaskItem({
        sessionId: "parent-session",
        taskId: "task-1",
      })],
  ])("%s preserves the existing row navigation anchor", async (_name, run) => {
    const h = makeHarness();

    const result = await run(h);

    expect(result.task).toMatchObject({
      navigation_session_id: "child-session",
      navigation_node_id: "node-child",
      navigation_event_id: 77,
    });
    expect(h.repo.patchTaskItem).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        navigation_session_id: "parent-session",
        navigation_event_id: expect.any(Number),
      }),
    );
  });

  it("links a task to the linked session top when navigation event is omitted", async () => {
    const h = makeHarness();

    const result = await h.service.linkSession({
      sessionId: "parent-session",
      taskId: "task-1",
      linkedSessionId: "new-child-session",
      linkedNodeId: "node-child",
    });

    expect(result.task).toMatchObject({
      linked_session_id: "new-child-session",
      navigation_session_id: "new-child-session",
      navigation_node_id: "node-child",
      navigation_event_id: null,
    });
  });
});

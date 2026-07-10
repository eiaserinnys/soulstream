import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  SessionCreateLifecycleError,
  createSessionCreateLifecycle,
  type BoardItemRouteProvider,
  type BoardItemFolderRecord,
  type BoardItemRecord,
  type SessionResourceAccessProvider,
  type TaskScopedSessionProvider,
} from "../src/index.js";

describe("session create lifecycle", () => {
  it("inherits a source session primary runbook container and removes sourceSessionId", async () => {
    const boardItems = boardItemProvider({
      boardItems: [{
        id: "session:source",
        folderId: "folder-a",
        containerKind: "runbook",
        containerId: "runbook-a",
        membershipKind: "primary",
        itemType: "session",
        itemId: "source",
      }],
    });
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems,
      access: accessProvider({ restricted: false, allowedFolderIds: [] }),
      tasks: taskProvider(),
    });

    const prepared = await lifecycle.prepare({
      request: request(),
      body: {
        prompt: "continue",
        folderId: "folder-a",
        sourceSessionId: "source",
      },
    });

    expect(prepared.existingResponse).toBeUndefined();
    expect(prepared.payload).toMatchObject({
      folderId: "folder-a",
      container: { kind: "runbook", id: "runbook-a" },
      caller_info: { source: "browser" },
    });
    expect(prepared.payload).not.toHaveProperty("sourceSessionId");
  });

  it("defaults restricted users to their first allowed folder and rejects forbidden folders", async () => {
    const requireFolderAccess = vi.fn(async ({ folderId }: { folderId: string | null }) => {
      if (folderId === "folder-denied") {
        throw new SessionCreateLifecycleError(
          "SESSION_ACCESS_DENIED",
          "Folder access denied",
          403,
        );
      }
    });
    const access = accessProvider(
      { restricted: true, allowedFolderIds: ["folder-allowed"] },
      requireFolderAccess,
    );
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems: boardItemProvider({
        folders: [
          { id: "folder-allowed" },
          { id: "folder-child", parentFolderId: "folder-allowed" },
        ],
      }),
      access,
      tasks: taskProvider(),
    });

    const prepared = await lifecycle.prepare({
      request: request(),
      body: { prompt: "hello" },
    });

    expect(prepared.payload.folderId).toBe("folder-allowed");
    expect(requireFolderAccess).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "folder-allowed",
    }));

    await expect(lifecycle.prepare({
      request: request(),
      body: { prompt: "hello", folderId: "folder-denied" },
    })).rejects.toMatchObject({ statusCode: 403, code: "SESSION_ACCESS_DENIED" });
  });

  it("returns an existing task-scoped session before node dispatch", async () => {
    const tasks = taskProvider({
      existing: {
        task: {
          id: "child-task",
          status: "in_progress",
          linkedSessionId: "child-session",
          linkedNodeId: "node-a",
        },
        operation: { id: "op-a", operationType: "start_child_session" },
        eventId: 303,
        idempotent: true,
      },
    });
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems: boardItemProvider(),
      access: accessProvider({ restricted: false, allowedFolderIds: [] }),
      tasks,
    });

    const prepared = await lifecycle.prepare({
      request: request(),
      body: {
        prompt: "child",
        parentTaskId: "parent-task",
        taskIdempotencyKey: "idem-child",
      },
    });

    expect(prepared.existingResponse).toEqual({
      agentSessionId: "child-session",
      nodeId: "node-a",
      task: expect.objectContaining({ id: "child-task" }),
      taskOperation: expect.objectContaining({ operationType: "start_child_session" }),
      taskEventId: 303,
      idempotent: true,
    });
    expect(tasks.getTask).not.toHaveBeenCalled();
  });

  it("adds parent context before dispatch and links the child after the node ack", async () => {
    const tasks = taskProvider({
      parent: {
        id: "parent-task",
        title: "Parent task",
        description: "parent description",
        acceptanceCriteria: "parent acceptance",
        verificationOwner: "both",
        status: "in_progress",
        navigationSessionId: "owner-session",
      },
    });
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems: boardItemProvider(),
      access: accessProvider({ restricted: false, allowedFolderIds: [] }),
      tasks,
    });
    const prepared = await lifecycle.prepare({
      request: request(),
      body: {
        prompt: "하위 대화 내용",
        parentTaskId: "parent-task",
        taskIdempotencyKey: "idem-child",
      },
    });

    expect(prepared.payload.extra_context_items).toEqual([
      expect.objectContaining({
        key: "task_tree_parent",
        label: "Task Tree parent",
        content: expect.stringContaining("Parent task"),
      }),
    ]);

    await expect(lifecycle.complete({
      prepared,
      childSessionId: "child-session",
      childNodeId: "node-a",
      prompt: "하위 대화 내용",
    })).resolves.toEqual({
      task: expect.objectContaining({
        id: "created-child-task",
        parentId: "parent-task",
        linkedSessionId: "child-session",
      }),
      taskOperation: expect.objectContaining({ operationType: "start_child_session" }),
      taskEventId: 404,
    });
    expect(tasks.createTaskScopedChild).toHaveBeenCalledWith(expect.objectContaining({
      parentTask: expect.objectContaining({ id: "parent-task" }),
      childSessionId: "child-session",
      childNodeId: "node-a",
      idempotencyKey: "idem-child",
    }));
  });
});

function request(): FastifyRequest {
  return {
    headers: {},
    ip: "203.0.113.9",
  } as unknown as FastifyRequest;
}

function boardItemProvider(input: {
  folders?: readonly BoardItemFolderRecord[];
  boardItems?: readonly BoardItemRecord[];
} = {}): BoardItemRouteProvider {
  const folders = input.folders ?? [];
  const boardItems = input.boardItems ?? [];
  return {
    listFolders: vi.fn(async () => folders),
    listBoardItems: vi.fn(async () => boardItems),
    resolveBoardContainerFolderId: vi.fn(async (container) => {
      if (container.kind === "folder") return container.id;
      const runbook = boardItems.find((item) =>
        item.itemType === "runbook" && item.itemId === container.id
      );
      if (typeof runbook?.folderId !== "string") throw new Error("missing runbook");
      return runbook.folderId;
    }),
    getCatalogSnapshot: vi.fn(async () => ({ folders, boardItems })),
  };
}

function accessProvider(
  resolved: { restricted: boolean; allowedFolderIds: readonly string[] },
  requireFolderAccess = vi.fn(async () => undefined),
): SessionResourceAccessProvider {
  return {
    resolveAccess: vi.fn(async () => resolved),
    requireSessionAccess: vi.fn(async () => undefined),
    requireFolderAccess,
  };
}

function taskProvider(input: {
  existing?: Awaited<ReturnType<TaskScopedSessionProvider["findTaskScopedSession"]>>;
  parent?: Awaited<ReturnType<TaskScopedSessionProvider["getTask"]>>;
} = {}): TaskScopedSessionProvider & {
  findTaskScopedSession: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  createTaskScopedChild: ReturnType<typeof vi.fn>;
} {
  return {
    findTaskScopedSession: vi.fn(async () => input.existing ?? null),
    getTask: vi.fn(async () => input.parent ?? null),
    createTaskScopedChild: vi.fn(async ({ parentTask, childSessionId, childNodeId }) => ({
      task: {
        id: "created-child-task",
        parentId: parentTask.id,
        status: "in_progress" as const,
        linkedSessionId: childSessionId,
        linkedNodeId: childNodeId,
      },
      operation: {
        id: "created-op",
        operationType: "start_child_session",
      },
      eventId: 404,
    })),
  };
}

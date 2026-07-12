import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import { TaskCreation } from "../../src/task/task_creation.js";
import type { TaskCreationHook } from "../../src/task/task_creation_hook.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeHarness(options: {
  logger?: typeof silentLogger;
  taskCreationHook?: TaskCreationHook;
} = {}) {
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const appendMetadata = vi.fn().mockResolvedValue(1);
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  const getFolderById = vi
    .fn()
    .mockResolvedValue({
      id: "claude",
      name: "사용자가 바꾼 클로드 폴더 이름",
      sort_order: 0,
      settings: {},
      parent_folder_id: null,
    });
  const getCatalog = vi.fn().mockResolvedValue({ folders: [], sessions: {} });
  const resolveBoardYjsContainerScope = vi.fn().mockResolvedValue({
    folderId: "root",
    containerKind: "runbook",
    containerId: "rb-1",
  });
  const loadBoardYjsSeed = vi.fn().mockResolvedValue({
    boardItems: [],
    markdownDocuments: [],
  });
  const db = {
    registerSession,
    appendMetadata,
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    resolveBoardYjsContainerScope,
    loadBoardYjsSeed,
  } as unknown as SessionDB;

  const upsertSessionBoardItem = vi.fn().mockResolvedValue({
    id: "session:sess-runbook",
    folderId: "root",
    containerKind: "runbook",
    containerId: "rb-1",
    membershipKind: "primary",
    sourceRunbookItemId: "runbook-item-1",
    itemType: "session",
    itemId: "sess-runbook",
    x: 0,
    y: 160,
    metadata: {},
  });

  const emitCatalogUpdated = vi.fn().mockResolvedValue(undefined);
  const emitSessionCreated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = {
    emitCatalogUpdated,
    emitSessionCreated,
  } as unknown as SessionBroadcaster;

  const tasks = new Map<string, Task>();
  const creation = new TaskCreation({
    nodeId: "node-1",
    db,
    boardYjsService: { upsertSessionBoardItem },
    broadcaster,
    logger: options.logger ?? silentLogger,
    taskCreationHook: options.taskCreationHook,
    hasTask: (sessionId) => tasks.has(sessionId),
    rememberTask: (task) => {
      tasks.set(task.agentSessionId, task);
    },
  });

  return {
    creation,
    tasks,
    registerSession,
    appendMetadata,
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    resolveBoardYjsContainerScope,
    loadBoardYjsSeed,
    upsertSessionBoardItem,
    emitCatalogUpdated,
    emitSessionCreated,
  };
}

describe("TaskCreation", () => {
  it("runs the binding hook after durable registration and metadata but before remembering or projection", async () => {
    const order: string[] = [];
    const taskCreationHook: TaskCreationHook = {
      afterSessionRegistered: vi.fn(async ({ task, params }) => {
        order.push("hook");
        expect(task.agentSessionId).toBe("sess-hook-order");
        expect(params.prompt).toBe("hook prompt");
      }),
    };
    const h = makeHarness({ taskCreationHook });
    h.registerSession.mockImplementation(async () => {
      order.push("register");
    });
    h.appendMetadata.mockImplementation(async () => {
      order.push("metadata");
      return 1;
    });
    h.assignSessionToFolder.mockImplementation(async () => {
      order.push("folder");
    });
    h.emitSessionCreated.mockImplementation(async () => {
      order.push("created");
    });

    await h.creation.createTask({
      agentSessionId: "sess-hook-order",
      prompt: "hook prompt",
      profileId: "codex-default",
      callerInfo: { source: "browser" },
      folderId: "folder-1",
    });

    expect(order).toEqual(["register", "metadata", "hook", "folder", "created"]);
  });

  it("isolates binding hook failures and preserves session creation", async () => {
    const logger = {
      warn: vi.fn(),
      child: () => logger,
    } as unknown as typeof silentLogger;
    const hookError = new Error("binding unavailable");
    const h = makeHarness({
      logger,
      taskCreationHook: {
        afterSessionRegistered: vi.fn().mockRejectedValue(hookError),
      },
    });

    const task = await h.creation.createTask({
      agentSessionId: "sess-hook-failure",
      prompt: "still starts",
      profileId: "codex-default",
      folderId: "folder-1",
    });

    expect(h.tasks.get(task.agentSessionId)).toBe(task);
    expect(h.assignSessionToFolder).toHaveBeenCalled();
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "folder-1");
    expect(logger.warn).toHaveBeenCalledWith(
      { err: hookError, sessionId: "sess-hook-failure" },
      "post-registration task creation hook failed",
    );
  });

  it("creates the runtime task, registers the session, persists caller metadata, and broadcasts after folder assignment", async () => {
    const h = makeHarness();

    const task = await h.creation.createTask({
      agentSessionId: "sess-1",
      prompt: "hello",
      profileId: "codex-default",
      sessionType: "llm",
      callerInfo: { source: "slack", display_name: "Alice" },
      folderId: "folder-42",
      reasoningEffort: "high",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
    });

    expect(task).toMatchObject({
      agentSessionId: "sess-1",
      prompt: "hello",
      status: "running",
      reviewRequired: true,
      reviewState: "not_required",
      profileId: "codex-default",
      sessionType: "llm",
      reasoningEffort: "high",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
      metadata: [
        {
          type: "caller_info",
          value: { source: "slack", display_name: "Alice" },
        },
      ],
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    });
    expect(h.tasks.get("sess-1")).toBe(task);

    expect(h.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        nodeId: "node-1",
        agentId: "codex-default",
        claudeSessionId: null,
        sessionType: "llm",
        prompt: "hello",
        status: "running",
        callerSessionId: null,
        reviewRequired: true,
        reviewState: "not_required",
      }),
    );
    expect(h.appendMetadata).toHaveBeenCalledWith("sess-1", {
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });
    expect(h.assignSessionToFolder).toHaveBeenCalledWith("sess-1", "folder-42");
    expect(h.getFolderById).not.toHaveBeenCalled();
    expect(h.emitCatalogUpdated).toHaveBeenCalledWith({ folders: [], sessions: {} });
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "folder-42");

    expect(h.appendMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
    expect(h.emitCatalogUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
  });

  it("uses the session type default folder when no folderId is provided", async () => {
    const h = makeHarness();
    h.getFolderById.mockResolvedValueOnce({
      id: "llm",
      name: "사용자가 바꾼 LLM 폴더 이름",
      sort_order: 1,
      settings: {},
      parent_folder_id: null,
    });

    const task = await h.creation.createTask({
      agentSessionId: "sess-default",
      prompt: "p",
      profileId: "codex-default",
      sessionType: "llm",
    });

    expect(h.getFolderById).toHaveBeenCalledWith("llm");
    expect(h.assignSessionToFolder).toHaveBeenCalledWith("sess-default", "llm");
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "llm");
  });

  it("continues without folder assignment when the default folder is missing", async () => {
    const h = makeHarness();
    h.getFolderById.mockResolvedValueOnce(null);

    const task = await h.creation.createTask({
      agentSessionId: "sess-no-folder",
      prompt: "p",
      profileId: "codex-default",
    });

    expect(h.assignSessionToFolder).not.toHaveBeenCalled();
    expect(h.emitCatalogUpdated).not.toHaveBeenCalled();
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, null);
    expect(h.tasks.get("sess-no-folder")).toBe(task);
  });

  it("places delegated runbook sessions through the runbook board Y-doc before catalog broadcast", async () => {
    const h = makeHarness();
    h.loadBoardYjsSeed.mockResolvedValueOnce({
      boardItems: [
        {
          id: "runbook:rb-1",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          itemType: "runbook",
          itemId: "rb-1",
          x: 0,
          y: 0,
          metadata: {},
        },
        {
          id: "markdown:doc-1",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          itemType: "markdown",
          itemId: "doc-1",
          x: 0,
          y: 160,
          metadata: {},
        },
      ],
      markdownDocuments: [],
    });

    const task = await h.creation.createTask({
      agentSessionId: "sess-runbook",
      prompt: "runbook task",
      profileId: "roselin_codex",
      sessionType: "llm",
      container: { containerKind: "runbook", containerId: "rb-1" },
      sourceRunbookItemId: "runbook-item-1",
    });

    expect(h.resolveBoardYjsContainerScope).toHaveBeenCalledWith({
      containerKind: "runbook",
      containerId: "rb-1",
    });
    expect(h.assignSessionToFolder).toHaveBeenCalledWith("sess-runbook", "root");
    expect(h.loadBoardYjsSeed).toHaveBeenCalledWith({
      containerKind: "runbook",
      containerId: "rb-1",
    });
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "root",
      container: { containerKind: "runbook", containerId: "rb-1" },
      sessionId: "sess-runbook",
      sourceRunbookItemId: "runbook-item-1",
      x: 280,
      y: 160,
    });
    expect(h.upsertSessionBoardItem.mock.invocationCallOrder[0]).toBeLessThan(
      h.getCatalog.mock.invocationCallOrder[0],
    );
    expect(h.emitCatalogUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "root");
  });

  it("logs target container when runbook session board enrollment falls back to folder assignment", async () => {
    const logger = {
      warn: vi.fn(),
      child: () => logger,
    } as unknown as typeof silentLogger;
    const h = makeHarness({ logger });
    h.upsertSessionBoardItem.mockRejectedValueOnce(new Error("host proxy 401"));

    const task = await h.creation.createTask({
      agentSessionId: "sess-runbook-fallback",
      prompt: "runbook task",
      profileId: "roselin_codex",
      sessionType: "llm",
      container: { containerKind: "runbook", containerId: "rb-1" },
      sourceRunbookItemId: "runbook-item-1",
    });

    expect(h.assignSessionToFolder).toHaveBeenCalledWith("sess-runbook-fallback", "root");
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "root");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sessionId: "sess-runbook-fallback",
        assignedFolderId: "root",
        targetContainer: { containerKind: "runbook", containerId: "rb-1" },
        sourceRunbookItemId: "runbook-item-1",
      }),
      expect.stringContaining("folder fallback"),
    );
  });

  it("isolates folder, catalog, and session_created broadcast failures after DB registration", async () => {
    const h = makeHarness();
    h.assignSessionToFolder.mockRejectedValueOnce(new Error("folder failed"));
    h.emitCatalogUpdated.mockRejectedValueOnce(new Error("catalog failed"));
    h.emitSessionCreated.mockRejectedValueOnce(new Error("ws closed"));

    const first = await h.creation.createTask({
      agentSessionId: "sess-folder-fail",
      prompt: "p",
      profileId: "codex-default",
      folderId: "folder-1",
    });
    const second = await h.creation.createTask({
      agentSessionId: "sess-catalog-fail",
      prompt: "p",
      profileId: "codex-default",
      folderId: "folder-2",
    });
    const third = await h.creation.createTask({
      agentSessionId: "sess-session-created-fail",
      prompt: "p",
      profileId: "codex-default",
      folderId: "folder-3",
    });

    expect(first.agentSessionId).toBe("sess-folder-fail");
    expect(second.agentSessionId).toBe("sess-catalog-fail");
    expect(third.agentSessionId).toBe("sess-session-created-fail");
    expect(h.tasks.has("sess-folder-fail")).toBe(true);
    expect(h.tasks.has("sess-catalog-fail")).toBe(true);
    expect(h.tasks.has("sess-session-created-fail")).toBe(true);
  });

  it("rejects duplicates before DB registration and does not remember register failures", async () => {
    const h = makeHarness();
    await h.creation.createTask({
      agentSessionId: "sess-dup",
      prompt: "p",
      profileId: "codex-default",
    });

    await expect(
      h.creation.createTask({
        agentSessionId: "sess-dup",
        prompt: "again",
        profileId: "codex-default",
      }),
    ).rejects.toThrow("Task already exists: sess-dup");
    expect(h.registerSession).toHaveBeenCalledTimes(1);

    h.registerSession.mockRejectedValueOnce(new Error("PK violation"));
    await expect(
      h.creation.createTask({
        agentSessionId: "sess-register-fail",
        prompt: "p",
        profileId: "codex-default",
      }),
    ).rejects.toThrow("PK violation");
    expect(h.tasks.has("sess-register-fail")).toBe(false);
  });
});

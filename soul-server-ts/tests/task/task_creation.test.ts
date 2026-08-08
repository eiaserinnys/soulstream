import { describe, expect, it, vi } from "vitest";

import type { TaskCreationHook } from "../../src/task/task_creation_hook.js";
import {
  makeTaskCreationHarness as makeHarness,
  silentLogger,
} from "./task_creation_harness.js";

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
    h.upsertSessionBoardItem.mockImplementation(async () => {
      order.push("folder");
      return {} as never;
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
    expect(h.upsertSessionBoardItem).toHaveBeenCalled();
    expect(h.assignSessionToFolder).not.toHaveBeenCalled();
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "folder-1");
    expect(task.creationWarnings).toEqual([{
      code: "PAGE_BINDING_PENDING",
      message: "The session was created, but page binding status could not be confirmed. Check the page before retrying.",
    }]);
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
      "register_session:sess-1",
    );
    expect(h.appendMetadata).toHaveBeenCalledWith("sess-1", {
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    }, { waitForAck: true });
    expect(h.assignSessionToFolder).not.toHaveBeenCalled();
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "folder-42",
      container: { containerKind: "folder", containerId: "folder-42" },
      sessionId: "sess-1",
      sourceTaskItemId: null,
      x: 0,
      y: 160,
    });
    expect(h.getFolderById).not.toHaveBeenCalled();
    expect(h.emitCatalogUpdated).toHaveBeenCalledWith(
      [],
      { "sess-1": { folderId: "folder-42", displayName: null } },
      {},
    );
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "folder-42");

    expect(h.appendMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
    expect(h.emitCatalogUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
  });

  it("keeps fire-and-forget caller metadata and task placement without a structural parent link", async () => {
    const h = makeHarness();

    const task = await h.creation.createTask({
      agentSessionId: "sess-fire-and-forget",
      prompt: "independent task work",
      profileId: "roselin_codex",
      callerSessionId: "sess-coordinator",
      callerInfo: {
        source: "agent",
        agent_node: "node-1",
        agent_id: "coordinator",
        display_name: "Coordinator",
      },
      notifyCompletion: false,
      container: { containerKind: "task", containerId: "rb-1" },
      sourceTaskItemId: "task-item-1",
    });

    expect(task).toMatchObject({
      callerSessionId: undefined,
      notifyCompletion: false,
      callerInfo: expect.objectContaining({
        source: "agent",
        agent_id: "coordinator",
      }),
    });
    expect(h.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-fire-and-forget",
        callerSessionId: null,
        notifyCompletion: false,
      }),
      "register_session:sess-fire-and-forget",
    );
    expect(h.appendMetadata).toHaveBeenCalledWith("sess-fire-and-forget", {
      type: "caller_info",
      value: expect.objectContaining({
        source: "agent",
        agent_id: "coordinator",
      }),
    }, { waitForAck: true });
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      container: { containerKind: "task", containerId: "rb-1" },
      sessionId: "sess-fire-and-forget",
      sourceTaskItemId: "task-item-1",
    }));
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
    expect(h.assignSessionToFolder).not.toHaveBeenCalled();
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "llm",
      container: { containerKind: "folder", containerId: "llm" },
      sessionId: "sess-default",
      sourceTaskItemId: null,
      x: 0,
      y: 160,
    });
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "llm");
  });

  it("places an explicitly assigned folder session through that folder Y.Doc before catalog broadcast", async () => {
    const h = makeHarness();
    h.getBoardItems.mockResolvedValueOnce([
      {
        id: "session:existing-target",
        folderId: "folder-42",
        containerKind: "folder",
        containerId: "folder-42",
        itemType: "session",
        itemId: "existing-target",
        x: 0,
        y: 160,
        metadata: {},
      },
      {
        id: "session:other-folder",
        folderId: "folder-other",
        containerKind: "folder",
        containerId: "folder-other",
        itemType: "session",
        itemId: "other-folder",
        x: 280,
        y: 160,
        metadata: {},
      },
    ]);

    await h.creation.createTask({
      agentSessionId: "sess-folder-immediate",
      prompt: "folder workflow",
      profileId: "codex-default",
      folderId: "folder-42",
    });

    expect(h.assignSessionToFolder).not.toHaveBeenCalled();
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "folder-42",
      container: { containerKind: "folder", containerId: "folder-42" },
      sessionId: "sess-folder-immediate",
      sourceTaskItemId: null,
      x: 280,
      y: 160,
    });
    expect(h.upsertSessionBoardItem.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitCatalogUpdated.mock.invocationCallOrder[0],
    );
    expect(h.upsertSessionBoardItem.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
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
    expect(h.upsertSessionBoardItem).not.toHaveBeenCalled();
    expect(h.emitCatalogUpdated).not.toHaveBeenCalled();
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, null);
    expect(h.tasks.get("sess-no-folder")).toBe(task);
  });

  it("places delegated task sessions through the task board Y-doc before catalog broadcast", async () => {
    const h = makeHarness();
    h.getBoardItems.mockResolvedValueOnce(
      [
        {
          id: "task:rb-1",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          itemType: "task",
          itemId: "rb-1",
          x: 0,
          y: 0,
          metadata: {},
        },
        {
          id: "markdown:doc-1",
          folderId: "root",
          containerKind: "task",
          containerId: "rb-1",
          itemType: "markdown",
          itemId: "doc-1",
          x: 0,
          y: 160,
          metadata: {},
        },
      ],
    );

    const task = await h.creation.createTask({
      agentSessionId: "sess-task",
      prompt: "task workflow",
      profileId: "roselin_codex",
      sessionType: "llm",
      container: { containerKind: "task", containerId: "rb-1" },
      sourceTaskItemId: "task-item-1",
    });

    expect(h.resolveBoardYjsContainerScope).toHaveBeenCalledWith({
      containerKind: "task",
      containerId: "rb-1",
    });
    expect(h.assignSessionToFolder).not.toHaveBeenCalledWith("sess-task", "root");
    expect(h.getBoardItems).toHaveBeenCalledTimes(1);
    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "root",
      container: { containerKind: "task", containerId: "rb-1" },
      sessionId: "sess-task",
      sourceTaskItemId: "task-item-1",
      x: 280,
      y: 160,
    });
    expect(h.upsertSessionBoardItem.mock.invocationCallOrder[0]).toBeLessThan(
      h.getAllFolders.mock.invocationCallOrder[0],
    );
    expect(h.emitCatalogUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      h.emitSessionCreated.mock.invocationCallOrder[0],
    );
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, "root");
  });

  it("preserves an existing delegated session card position during idempotent creation", async () => {
    const h = makeHarness();
    h.getBoardItems.mockResolvedValueOnce(
      [{
        id: "session:sess-task",
        folderId: "root",
        containerKind: "task",
        containerId: "rb-1",
        itemType: "session",
        itemId: "sess-task",
        x: 840,
        y: 480,
        metadata: {},
      }],
    );

    await h.creation.createTask({
      agentSessionId: "sess-task",
      prompt: "task workflow",
      profileId: "roselin_codex",
      sessionType: "llm",
      container: { containerKind: "task", containerId: "rb-1" },
      sourceTaskItemId: "task-item-1",
    });

    expect(h.upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-task",
      x: 840,
      y: 480,
    }));
  });

  it("logs target container and leaves assignment unchanged when atomic placement fails", async () => {
    const logger = {
      warn: vi.fn(),
      child: () => logger,
    } as unknown as typeof silentLogger;
    const h = makeHarness({ logger });
    h.upsertSessionBoardItem.mockRejectedValueOnce(new Error("host proxy 401"));

    const task = await h.creation.createTask({
      agentSessionId: "sess-task-fallback",
      prompt: "task workflow",
      profileId: "roselin_codex",
      sessionType: "llm",
      container: { containerKind: "task", containerId: "rb-1" },
      sourceTaskItemId: "task-item-1",
    });

    expect(h.assignSessionToFolder).not.toHaveBeenCalledWith("sess-task-fallback", "root");
    expect(h.emitSessionCreated).toHaveBeenCalledWith(task, null);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        sessionId: "sess-task-fallback",
        assignedFolderId: null,
        targetFolderId: "root",
        targetContainer: { containerKind: "task", containerId: "rb-1" },
        sourceTaskItemId: "task-item-1",
      }),
      expect.stringContaining("atomic placement was not applied"),
    );
  });

  it("isolates atomic placement, catalog, and session_created broadcast failures after DB registration", async () => {
    const h = makeHarness();
    h.upsertSessionBoardItem.mockRejectedValueOnce(new Error("folder failed"));
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

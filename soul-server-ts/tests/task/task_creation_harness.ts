import pino from "pino";
import { vi } from "vitest";

import type { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import { TaskCreation } from "../../src/task/task_creation.js";
import type { TaskCreationHook } from "../../src/task/task_creation_hook.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

export const silentLogger = pino({ level: "silent" });

export function makeTaskCreationHarness(options: {
  logger?: typeof silentLogger;
  taskCreationHook?: TaskCreationHook;
} = {}) {
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const appendMetadata = vi.fn().mockResolvedValue(1);
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  let projectedFolderId: string | null = null;
  const getFolderById = vi.fn().mockResolvedValue({
    id: "claude",
    name: "사용자가 바꾼 클로드 폴더 이름",
    sort_order: 0,
    settings: {},
    parent_folder_id: null,
  });
  const getAllFolders = vi.fn().mockResolvedValue([]);
  const getSession = vi.fn(async (sessionId: string) => ({
    session_id: sessionId,
    folder_id: projectedFolderId,
    display_name: null,
  }));
  const getPrimarySessionBoardItem = vi.fn().mockResolvedValue(null);
  const resolveBoardYjsContainerScope = vi.fn().mockResolvedValue({
    folderId: "root",
    containerKind: "task",
    containerId: "rb-1",
  });
  const getBoardItems = vi.fn().mockResolvedValue([]);
  const db = {
    registerSession,
    appendMetadata,
    assignSessionToFolder,
    getFolderById,
    getAllFolders,
    getSession,
    getPrimarySessionBoardItem,
    resolveBoardYjsContainerScope,
    getBoardItems,
  } as unknown as SessionDB;

  const upsertSessionBoardItem = vi.fn(async (
    input: Parameters<BoardYjsHostClient["upsertSessionBoardItem"]>[0],
  ) => {
    projectedFolderId = input.folderId;
    return {
      id: `session:${input.sessionId}`,
      folderId: input.folderId,
      containerKind: input.container.containerKind,
      containerId: input.container.containerId,
      membershipKind: "primary" as const,
      sourceTaskItemId: input.sourceTaskItemId ?? null,
      itemType: "session" as const,
      itemId: input.sessionId,
      x: input.x,
      y: input.y,
      metadata: {},
    };
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
    sessionMutations: { registerSession } as never,
    persistence: { enqueueMetadataEffect: appendMetadata } as unknown as EventPersistence,
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
    getAllFolders,
    getSession,
    getPrimarySessionBoardItem,
    resolveBoardYjsContainerScope,
    getBoardItems,
    upsertSessionBoardItem,
    emitCatalogUpdated,
    emitSessionCreated,
  };
}

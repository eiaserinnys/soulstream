import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { DefaultPageContextAssembler } from "../../src/context/page_context_assembler.js";
import { HostPageContextRepository } from "../../src/context/page_context_repository.js";
import { AncestorPageContextResolver } from "../../src/context/page_context_resolver.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { SessionPageBindingService } from "../../src/page/session_page_binding_service.js";
import type {
  EnqueueSessionPageBinding,
  SessionPageBindingRepository,
  SessionPageBindingRow,
} from "../../src/page/session_page_binding_repository.js";
import { TaskCreation } from "../../src/task/task_creation.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { TaskRuntimeCommands } from "../../src/upstream/task_runtime_commands.js";

const logger = pino({ level: "silent" });

describe("Phase 3 first-turn page context integration", () => {
  it("registers, binds the primary session_ref, then resolves ancestors before execution", async () => {
    const order: string[] = [];
    let row: SessionPageBindingRow | null = null;
    const repository = {
      enqueue: vi.fn(async (input: EnqueueSessionPageBinding) => {
        row = {
          session_id: input.sessionId,
          node_id: input.nodeId,
          target_page_id: input.targetPageId,
          target_block_id: input.targetBlockId,
          target_expected_version: input.targetExpectedVersion,
          daily_date: input.dailyDate,
          session_type: input.sessionType,
          legacy_folder_id: input.legacyFolderId,
          legacy_container_kind: input.legacyContainerKind,
          legacy_container_id: input.legacyContainerId,
          source_task_item_id: input.sourceTaskItemId,
          page_state: input.initialPageState,
          legacy_state: "pending",
          attempts: 0,
          last_error: null,
          next_retry_at: new Date(0),
        };
        return row;
      }),
      get: vi.fn(async () => row),
      markPageBound: vi.fn(async () => {
        order.push("bind");
        row = { ...row!, page_state: "bound" };
      }),
      markLegacyCompleted: vi.fn(async () => {
        row = { ...row!, legacy_state: "completed" };
      }),
    } as unknown as SessionPageBindingRepository;

    const blocks = [
      {
        id: "guidance-root",
        page_id: "page-1",
        parent_id: null,
        position_key: "a",
        block_type: "guidance",
        text: "Keep the first turn grounded in the page.",
        properties: { enabled: true, scope: "first-turn" },
        collapsed: false,
      },
      {
        id: "block-session",
        page_id: "page-1",
        parent_id: "guidance-root",
        position_key: "b",
        block_type: "paragraph",
        text: "/세션",
        properties: {},
        collapsed: false,
      },
    ];
    const pageHost = {
      getPage: vi.fn(async () => ({
        page: {
          id: "page-1",
          title: "Phase 3",
          daily_date: null,
          version: 7,
          archived: false,
          metadata: {},
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:00:00Z",
        },
        blocks,
      })),
      getDailyPage: vi.fn(),
      getBacklinks: vi.fn(async () => ({ items: [], next_cursor: null })),
      batchPageOperations: vi.fn(async (input: Record<string, any>) => {
        const operation = input.operations[0];
        const block = blocks.find((candidate) => candidate.id === operation.block_id)!;
        block.block_type = operation.block_type;
        block.properties = operation.properties;
      }),
    };
    const bindingService = new SessionPageBindingService({
      nodeId: "node-1",
      repository,
      pageHost,
      legacyProjection: { project: vi.fn() },
      logger,
    });
    const db = {
      registerSession: vi.fn(async () => { order.push("register"); }),
      appendMetadata: vi.fn(async () => 1),
      assignSessionToFolder: vi.fn(async () => { order.push("folder"); }),
      getFolderById: vi.fn(async () => ({ id: "folder-1" })),
      getCatalog: vi.fn(async () => ({ folders: [], sessions: {} })),
    } as unknown as SessionDB;
    const tasks = new Map<string, Task>();
    const creation = new TaskCreation({
      nodeId: "node-1",
      db,
      broadcaster: {
        emitCatalogUpdated: vi.fn(async () => undefined),
        emitSessionCreated: vi.fn(async () => { order.push("created"); }),
      } as unknown as SessionBroadcaster,
      logger,
      taskCreationHook: bindingService,
      hasTask: (sessionId) => tasks.has(sessionId),
      rememberTask: (task) => tasks.set(task.agentSessionId, task),
    });
    const resolver = new AncestorPageContextResolver(
      new HostPageContextRepository(repository, pageHost as never),
      new DefaultPageContextAssembler(),
      logger,
    );
    let contextResult: Awaited<ReturnType<typeof resolver.resolve>> | undefined;
    let contextPromise: Promise<void> | undefined;
    const runtime = new TaskRuntimeCommands({
      agentRegistry: {
        get: () => ({
          id: "codex-default",
          name: "Codex",
          backend: "codex",
          workspace_dir: "/tmp/codex",
        }),
      },
      taskManager: {
        createTask: (params) => creation.createTask(params),
        addIntervention: vi.fn(),
      },
      taskExecutor: {
        startExecution: (task, agent) => {
          order.push("start");
          contextPromise = resolver.resolve(task, agent).then((result) => {
            contextResult = result;
            order.push("context");
          });
        },
      },
      logger,
    });

    await runtime.createSession({
      agentSessionId: "sess-first-turn",
      prompt: "Start from this page",
      profileId: "codex-default",
      callerInfo: { source: "browser" },
      folderId: "folder-1",
      pageAnchor: { pageId: "page-1", blockId: "block-session", expectedVersion: 7 },
    });
    await contextPromise;

    expect(db.registerSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-first-turn",
      nodeId: "node-1",
    }));
    expect(order.indexOf("register")).toBeLessThan(order.indexOf("bind"));
    expect(order.indexOf("bind")).toBeLessThan(order.indexOf("start"));
    expect(blocks[1]).toMatchObject({
      block_type: "session_ref",
      properties: { sessionId: "sess-first-turn", primary: true },
    });
    expect(contextResult).toMatchObject({
      kind: "page-anchor",
      contextItem: {
        key: "page_context",
        content: {
          anchor: { page_id: "page-1", block_id: "block-session" },
          items: [{ text: "Keep the first turn grounded in the page." }],
        },
      },
    });
  });
});

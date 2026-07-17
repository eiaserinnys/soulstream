import { describe, expect, it, vi } from "vitest";

import {
  RunbookTaskIdentityService,
  type RunbookTaskIdentityBoardApplication,
  type RunbookTaskIdentityBoardPort,
  type RunbookTaskIdentityMutationResult,
  type RunbookTaskIdentityRepository,
} from "../src/runbooks/runbook_task_identity_service.js";
import { PageMutationCore } from "../src/page/page_mutation_core.js";

const identityId = "00000000-0000-4000-8000-0000000000ae";

describe("RunbookTaskIdentityService", () => {
  it("creates one UUID across runbook, page, board item, and primary reference", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createId: () => identityId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await expect(service.create({
      title: "원자 업무",
      description: "설명",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "create-ae",
    })).resolves.toMatchObject({
      id: identityId,
      pageId: identityId,
      runbookId: identityId,
    });

    const input = vi.mocked(repository.create).mock.calls[0]?.[0];
    expect(input).toMatchObject({
      id: identityId,
      pageId: identityId,
      runbookId: identityId,
      boardItemId: `runbook:${identityId}`,
      taskPageId: identityId,
    });
    expect(input?.pageApplication.replica.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runbook_ref", properties: {
        primary: true,
        runbookId: identityId,
      } }),
    ]));
    expect(board.liveApplied).toBe(true);
    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 1 });
  });

  it("notifies after promoting an existing page", async () => {
    const repository = createRepository();
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board: new MemoryBoardPort(),
      repository,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.promoteExistingPage({
      pageId: identityId,
      folderId: "folder-a",
      title: "승격 업무",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "promote-ae",
    });

    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 2 });
  });

  it("notifies after a runbook-originated page mutation", async () => {
    const repository = createRepository();
    vi.mocked(repository.findByRunbookId).mockResolvedValue(taskBinding());
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board: new MemoryBoardPort(),
      repository,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.mutateFromRunbook({
      runbookId: identityId,
      expectedVersion: 1,
      title: "바뀐 업무",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "mutate-runbook-ae",
    });

    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 2 });
  });

  it("does not notify for an idempotent runbook-originated retry", async () => {
    const repository = createRepository();
    const committed = await vi.mocked(repository.create).getMockImplementation()?.({
      id: identityId,
      pageId: identityId,
      runbookId: identityId,
      taskPageId: identityId,
      boardItemId: `runbook:${identityId}`,
      folderId: "folder-a",
      title: "이미 바뀐 업무",
    } as Parameters<RunbookTaskIdentityRepository["create"]>[0]);
    vi.mocked(repository.findMutationByIdempotencyKey).mockResolvedValue(committed ?? null);
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board: new MemoryBoardPort(),
      repository,
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.mutateFromRunbook({
      runbookId: identityId,
      expectedVersion: 1,
      title: "이미 바뀐 업무",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "mutate-runbook-ae-retry",
    });

    expect(repository.mutate).not.toHaveBeenCalled();
    expect(onPageUpdated).not.toHaveBeenCalled();
  });

  it("notifies only when legacy backfill creates a page", async () => {
    const repository = createRepository();
    vi.mocked(repository.findLegacyRunbook).mockResolvedValue({
      runbookId: identityId,
      folderId: "folder-a",
      boardItemId: `runbook:${identityId}`,
      title: "레거시 업무",
      archived: false,
      runbookVersion: 1,
      x: 0,
      y: 0,
    });
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board: new MemoryBoardPort(),
      repository,
      createId: () => identityId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.backfillLegacyRunbook({
      runbookId: identityId,
      actor: { actorKind: "system" },
      idempotencyKey: "backfill-ae",
    });

    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 1 });
  });

  it("does not notify when legacy backfill only binds an existing page", async () => {
    const repository = createRepository();
    vi.mocked(repository.findLegacyRunbook).mockResolvedValue(legacyBinding());
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(
      createReferencedPageSnapshot(),
    );
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board: new MemoryBoardPort(),
      repository,
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.backfillLegacyRunbook({
      runbookId: identityId,
      existingPageId: identityId,
      actor: { actorKind: "system" },
      idempotencyKey: "bind-backfill-ae",
    });

    expect(repository.bindLegacyPage).toHaveBeenCalledOnce();
    expect(onPageUpdated).not.toHaveBeenCalled();
  });

  it("returns the committed identity before allocating a second UUID on retry", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    const committed = await vi.mocked(repository.create).getMockImplementation()?.({
      id: identityId,
      pageId: identityId,
      runbookId: identityId,
      taskPageId: identityId,
      boardItemId: `runbook:${identityId}`,
      folderId: "folder-a",
      title: "재시도 업무",
    } as Parameters<RunbookTaskIdentityRepository["create"]>[0]);
    vi.mocked(repository.findMutationByIdempotencyKey).mockResolvedValueOnce(committed ?? null);
    const createId = vi.fn(() => "00000000-0000-4000-8000-0000000000ff");
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await expect(service.create({
      title: "재시도 업무",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "create-ae-retry",
    })).resolves.toMatchObject({
      id: identityId,
      pageId: identityId,
      runbookId: identityId,
      idempotent: false,
    });

    expect(createId).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(board.liveApplied).toBe(false);
    expect(onPageUpdated).not.toHaveBeenCalled();
  });

  it("does not apply the staged board Y.Doc update when the DB transaction fails", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    vi.mocked(repository.create).mockRejectedValueOnce(new Error("page projection failed"));
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createId: () => identityId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
    });

    await expect(service.create({
      title: "롤백 업무",
      description: "",
      folderId: "folder-a",
      actor: { actorKind: "agent", actorSessionId: "session-ae" },
      idempotencyKey: "rollback-ae",
    })).rejects.toThrow("page projection failed");

    expect(board.liveApplied).toBe(false);
  });

  it("removes project and daily mounts in the same archived identity mutation", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    vi.mocked(repository.findByRunbookId).mockResolvedValue(taskBinding());
    vi.mocked(repository.listTaskMounts).mockResolvedValue([
      { sourcePageId: "project-a", sourceBlockIds: ["project-mount"] },
      { sourcePageId: "daily-a", sourceBlockIds: ["daily-mount"] },
    ]);
    vi.mocked(repository.readPageSnapshot).mockImplementation(async (pageId) => (
      pageId === identityId
        ? createPageSnapshot()
        : createMountedPageSnapshot(pageId, pageId === "project-a" ? "project-mount" : "daily-mount")
    ));
    const hydratePage = vi.fn(async () => undefined);
    const onPageUpdated = vi.fn();
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createOperationId: operationSequence(),
      hydratePage,
      onPageUpdated,
    });

    await service.mutateFromRunbook({
      runbookId: identityId,
      expectedVersion: 1,
      archived: true,
      actor: { actorKind: "agent", actorSessionId: "session-ae" },
      idempotencyKey: "archive-with-mounts",
    });

    const mutation = vi.mocked(repository.mutate).mock.calls[0]?.[0];
    const mountPageApplications = mutation?.mountPageApplications ?? [];
    expect(mountPageApplications).toHaveLength(2);
    expect(mountPageApplications.map((item) => ({
      pageId: item.pageId,
      blocks: item.application.replica.blocks,
    }))).toEqual([
      { pageId: "daily-a", blocks: [] },
      { pageId: "project-a", blocks: [] },
    ]);
    expect(hydratePage).toHaveBeenCalledWith(identityId);
    expect(hydratePage).toHaveBeenCalledWith("project-a");
    expect(hydratePage).toHaveBeenCalledWith("daily-a");
    expect(onPageUpdated).toHaveBeenCalledTimes(3);
  });

  it("moves the board item and project mount through one staged server transaction", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    vi.mocked(repository.findByRunbookId).mockResolvedValue(taskBinding());
    vi.mocked(repository.findProjectPageByFolderId).mockResolvedValue({ pageId: "project-target" });
    vi.mocked(repository.listTaskMounts).mockResolvedValue([
      { sourcePageId: "project-source", sourceBlockIds: ["source-mount"] },
    ]);
    vi.mocked(repository.readPageSnapshot).mockImplementation(async (pageId) => {
      if (pageId === "project-source") return createMountedPageSnapshot(pageId, "source-mount");
      if (pageId === "project-target") return createMountedPageSnapshot(pageId);
      return createPageSnapshot();
    });
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createOperationId: operationSequence(),
      hydratePage: vi.fn(async () => undefined),
    });

    await expect(service.moveBoardItemToContainer({
      boardItem: boardItem("folder-a"),
      targetScope: {
        folderId: "folder-target",
        containerKind: "folder",
        containerId: "folder-target",
      },
      idempotencyKey: "move-task-project",
    })).resolves.toMatchObject({
      folderId: "folder-target",
      containerId: "folder-target",
    });

    const move = vi.mocked(repository.move).mock.calls[0]?.[0];
    expect(move).toMatchObject({
      sourceFolderId: "folder-a",
      targetFolderId: "folder-target",
      expectedTargetProjectPageId: "project-target",
    });
    expect(move?.mountPageApplications.map((item) => ({
      pageId: item.pageId,
      blockTexts: item.application.replica.blocks.map((block) => block.text),
    }))).toEqual([
      { pageId: "project-source", blockTexts: [] },
      { pageId: "project-target", blockTexts: ["[[이전 업무]]"] },
    ]);
    expect(board.moveLiveApplied).toBe(true);
  });

  it("does not apply staged board documents when project move persistence fails", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    vi.mocked(repository.findByRunbookId).mockResolvedValue(taskBinding());
    vi.mocked(repository.findProjectPageByFolderId).mockResolvedValue({ pageId: "project-target" });
    vi.mocked(repository.listTaskMounts).mockResolvedValue([]);
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createMountedPageSnapshot("project-target"));
    vi.mocked(repository.move).mockRejectedValue(new Error("project move transaction failed"));
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createOperationId: operationSequence(),
      hydratePage: vi.fn(async () => undefined),
    });

    await expect(service.moveBoardItemToContainer({
      boardItem: boardItem("folder-a"),
      targetScope: {
        folderId: "folder-target",
        containerKind: "folder",
        containerId: "folder-target",
      },
      idempotencyKey: "move-task-project-fail",
    })).rejects.toThrow("project move transaction failed");
    expect(board.moveLiveApplied).toBe(false);
  });
});

function createRepository(): RunbookTaskIdentityRepository {
  const result = (input: {
    id: string;
    pageId: string;
    runbookId: string;
    title: string;
    resultVersion?: number;
  }): RunbookTaskIdentityMutationResult => ({
    id: input.id,
    pageId: input.pageId,
    runbookId: input.runbookId,
    snapshot: {
      runbook: { id: input.runbookId, title: input.title, version: 1 },
      sections: [],
      items: [],
    },
    operation: { id: "runbook-operation" },
    pageOperation: { id: "page-operation" },
    pageCommit: pageCommit(input.pageId, input.resultVersion ?? 1),
    idempotent: false,
  });
  return {
    findMutationByIdempotencyKey: vi.fn(async () => null),
    findLegacyBackfillByIdempotencyKey: vi.fn(async () => null),
    create: vi.fn(async (input) => result(input)),
    promote: vi.fn(async (input) => result({ ...input, resultVersion: 2 })),
    mutate: vi.fn(async (input) => result({
      id: input.binding.runbookId,
      pageId: input.binding.pageId,
      runbookId: input.binding.runbookId,
      title: input.title,
      resultVersion: 2,
    })),
    move: vi.fn(async () => undefined),
    findLegacyRunbook: vi.fn(),
    bindLegacyPage: vi.fn(async (input) => ({
      runbookId: input.binding.runbookId,
      pageId: input.pageId,
      createdPage: false,
      operation: { id: "runbook-operation" },
      idempotent: false,
    })),
    createLegacyPageAndBind: vi.fn(async (input) => ({
      runbookId: input.binding.runbookId,
      pageId: input.pageId,
      createdPage: true,
      operation: { id: "runbook-operation" },
      pageCommit: pageCommit(input.pageId, 1),
      idempotent: false,
    })),
    findByPageId: vi.fn(),
    findByRunbookId: vi.fn(),
    findPageByTitle: vi.fn(),
    findCreateResultByRunbookId: vi.fn(),
    findProjectPageByFolderId: vi.fn(async () => null),
    listTaskMounts: vi.fn(async () => []),
    readPageSnapshot: vi.fn(),
  };
}

function taskBinding() {
  return {
    runbookId: identityId,
    pageId: identityId,
    folderId: "folder-a",
    boardItemId: `runbook:${identityId}`,
    title: "이전 업무",
    archived: false,
    x: 0,
    y: 0,
    runbookVersion: 1,
    pageVersion: 1,
  };
}

function legacyBinding() {
  return {
    runbookId: identityId,
    folderId: "folder-a",
    boardItemId: `runbook:${identityId}`,
    title: "레거시 업무",
    archived: false,
    runbookVersion: 1,
    x: 0,
    y: 0,
  };
}

function createPageSnapshot(): Uint8Array {
  return new PageMutationCore().createPage({
    page: { id: identityId, title: "이전 업무", dailyDate: null },
    actor: { actorKind: "system" },
    idempotencyKey: "test:system:snapshot-ae",
  }).snapshot;
}

function createReferencedPageSnapshot(): Uint8Array {
  return new PageMutationCore().createPage({
    page: { id: identityId, title: "레거시 업무", dailyDate: null },
    actor: { actorKind: "system" },
    idempotencyKey: "test:system:referenced-snapshot-ae",
    initialCommand: {
      type: "batch_operations",
      operations: [{
        op: "create_block",
        tempId: "00000000-0000-4000-8000-0000000000bf",
        parentId: null,
        afterBlockId: null,
        blockType: "runbook_ref",
        text: "",
        properties: { runbookId: identityId, primary: true },
        collapsed: false,
      }],
    },
  }).snapshot;
}

function createMountedPageSnapshot(pageId: string, blockId?: string): Uint8Array {
  return new PageMutationCore().createPage({
    page: { id: pageId, title: pageId, dailyDate: null },
    actor: { actorKind: "system" },
    idempotencyKey: `test:system:${pageId}`,
    ...(blockId
      ? {
        initialCommand: {
          type: "batch_operations" as const,
          operations: [{
            op: "create_block" as const,
            id: blockId,
            tempId: blockId,
            parentId: null,
            afterBlockId: null,
            blockType: "paragraph",
            text: "[[이전 업무]]",
            properties: {},
          }],
        },
      }
      : {}),
  }).snapshot;
}

function operationSequence(): () => string {
  let index = 0;
  return () => `operation-${++index}`;
}

function boardItem(folderId: string) {
  return {
    id: `runbook:${identityId}`,
    folderId,
    containerKind: "folder" as const,
    containerId: folderId,
    membershipKind: "primary" as const,
    sourceRunbookItemId: null,
    itemType: "runbook" as const,
    itemId: identityId,
    x: 0,
    y: 0,
    metadata: { title: "이전 업무" },
  };
}

function pageCommit(pageId: string, resultVersion: number) {
  return {
    operation: {
      id: "page-operation",
      page_id: pageId,
      target_block_id: null,
      operation_type: "batch_operations" as const,
      actor_kind: "user" as const,
      actor_session_id: null,
      actor_event_id: null,
      actor_user_id: "user@example.com",
      idempotency_key: "create_task_identity:user:create",
      expected_version: resultVersion - 1,
      result_version: resultVersion,
      payload_json: {},
      reason: null,
      created_at: new Date(),
    },
    pageCreatedAt: new Date(),
    pageUpdatedAt: new Date(),
    idempotent: false,
  };
}

class MemoryBoardPort implements RunbookTaskIdentityBoardPort {
  liveApplied = false;
  moveLiveApplied = false;

  async withRunbookBoardApplication<T>(
    input: Parameters<RunbookTaskIdentityBoardPort["withRunbookBoardApplication"]>[0],
    persist: (application: RunbookTaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T> {
    const result = await persist({
      documentName: `board-folder:${input.folderId}`,
      scope: {
        folderId: input.folderId,
        containerKind: "folder",
        containerId: input.folderId,
      },
      snapshot: new Uint8Array([1, 2, 3]),
      replica: {
        boardItems: [{
          id: input.boardItemId,
          folderId: input.folderId,
          containerKind: "folder",
          containerId: input.folderId,
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "runbook",
          itemId: input.runbookId,
          x: input.x,
          y: input.y,
          metadata: { title: input.title },
        }],
        markdownDocuments: [],
      },
    });
    this.liveApplied = true;
    return result;
  }

  async withRunbookBoardMoveApplication(
    input: Parameters<RunbookTaskIdentityBoardPort["withRunbookBoardMoveApplication"]>[0],
    persist: Parameters<RunbookTaskIdentityBoardPort["withRunbookBoardMoveApplication"]>[1],
  ) {
    const moved = {
      ...input.boardItem,
      folderId: input.targetScope.folderId,
      containerKind: input.targetScope.containerKind,
      containerId: input.targetScope.containerId,
      x: input.position?.x ?? input.boardItem.x,
      y: input.position?.y ?? input.boardItem.y,
    };
    await persist({
      movedBoardItem: moved,
      boardApplications: [
        boardApplication(input.boardItem.folderId, []),
        boardApplication(input.targetScope.folderId, [moved]),
      ],
    });
    this.moveLiveApplied = true;
    return moved;
  }
}

function boardApplication(
  folderId: string,
  boardItems: RunbookTaskIdentityBoardApplication["replica"]["boardItems"],
): RunbookTaskIdentityBoardApplication {
  return {
    documentName: `board-folder:${folderId}`,
    scope: { folderId, containerKind: "folder", containerId: folderId },
    snapshot: new Uint8Array([1, 2, 3]),
    replica: { boardItems: [...boardItems], markdownDocuments: [] },
  };
}

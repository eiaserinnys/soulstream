import { describe, expect, it, vi } from "vitest";

import {
  RunbookTaskIdentityService,
  type RunbookTaskIdentityBoardApplication,
  type RunbookTaskIdentityBoardPort,
  type RunbookTaskIdentityMutationResult,
  type RunbookTaskIdentityRepository,
} from "../src/runbooks/runbook_task_identity_service.js";

const identityId = "00000000-0000-4000-8000-0000000000ae";

describe("RunbookTaskIdentityService", () => {
  it("creates one UUID across runbook, page, board item, and primary reference", async () => {
    const board = new MemoryBoardPort();
    const repository = createRepository();
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createId: () => identityId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
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
    const service = new RunbookTaskIdentityService({
      board,
      repository,
      createId,
      createOperationId: () => "operation-ae",
      hydratePage: vi.fn(),
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
});

function createRepository(): RunbookTaskIdentityRepository {
  return {
    findMutationByIdempotencyKey: vi.fn(async () => null),
    findLegacyBackfillByIdempotencyKey: vi.fn(async () => null),
    create: vi.fn(async (input): Promise<RunbookTaskIdentityMutationResult> => ({
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
      pageCommit: {
        operation: {
          id: "page-operation",
          page_id: input.pageId,
          target_block_id: null,
          operation_type: "batch_operations",
          actor_kind: "user",
          actor_session_id: null,
          actor_event_id: null,
          actor_user_id: "user@example.com",
          idempotency_key: "create_task_identity:user:create",
          expected_version: 0,
          result_version: 1,
          payload_json: {},
          reason: null,
          created_at: new Date(),
        },
        pageCreatedAt: new Date(),
        pageUpdatedAt: new Date(),
        idempotent: false,
      },
      idempotent: false,
    })),
    promote: vi.fn(),
    mutate: vi.fn(),
    findLegacyRunbook: vi.fn(),
    bindLegacyPage: vi.fn(),
    createLegacyPageAndBind: vi.fn(),
    findByPageId: vi.fn(),
    findByRunbookId: vi.fn(),
    readPageSnapshot: vi.fn(),
  };
}

class MemoryBoardPort implements RunbookTaskIdentityBoardPort {
  liveApplied = false;

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
}

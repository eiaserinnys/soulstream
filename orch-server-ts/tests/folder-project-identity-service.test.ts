import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";

import {
  FolderProjectIdentityService,
  type FolderProjectIdentityMutationResult,
  type FolderProjectIdentityRepository,
} from "../src/folders/folder_project_identity_service.js";
import { PageMutationCore } from "../src/page/page_mutation_core.js";

const identityId = "00000000-0000-4000-8000-0000000000af";

describe("FolderProjectIdentityService", () => {
  it.each([
    { name: "settings", update: { settings: { folderPrompt: "안내" } } },
    { name: "rename", update: { name: "새 이름" } },
    { name: "archive", archived: true },
    { name: "unarchive", archived: false },
  ])("persists a top-level folder $name with no parent board applications", async (change) => {
    const repository = createRepository();
    const folder = mutationResult({ id: identityId, pageId: identityId, name: "이전 이름" }).folder;
    vi.mocked(repository.findByFolderId).mockResolvedValue({
      ...folder, folderId: identityId, pageId: identityId, pageVersion: 1,
      archived: change.name === "unarchive",
    });
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const board = createBoardService();
    const service = new FolderProjectIdentityService({
      repository, hydratePage: vi.fn(),
      withBoardApplication: board.withFolderBoardApplication.bind(board),
    });
    const { name, ...update } = change;
    try {
      await service.mutateFromFolder({
        folderId: identityId, expectedVersion: 1, ...update,
        actor: { actorKind: "system" }, idempotencyKey: `root-${name}`,
      });
      expect(repository.mutate).toHaveBeenCalledOnce();
      expect(repository.mutate).toHaveBeenCalledWith(expect.objectContaining({
        boardApplications: [], ...update,
        title: change.update?.name ?? "이전 이름",
      }));
    } finally { await board.close(); }
  });

  it("creates a top-level folder with no parent board applications", async () => {
    const repository = createRepository();
    const board = createBoardService();
    const service = new FolderProjectIdentityService({
      repository, hydratePage: vi.fn(), createId: () => identityId,
      withBoardApplication: board.withFolderBoardApplication.bind(board),
    });
    try {
      await service.create({ name: "최상위", parentFolderId: null,
        actor: { actorKind: "system" }, idempotencyKey: "root-create" });
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
        boardApplications: [], parentFolderId: null,
      }));
    } finally { await board.close(); }
  });

  it.each([
    { type: "rename_page" as const, title: "새 이름" },
    { type: "archive_page" as const },
  ])("persists top-level identity from page command $type", async (command) => {
    const repository = createRepository();
    const folder = mutationResult({ id: identityId, pageId: identityId, name: "이전 이름" }).folder;
    vi.mocked(repository.findByPageId).mockResolvedValue({
      ...folder, folderId: identityId, pageId: identityId, pageVersion: 1,
    });
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const board = createBoardService();
    const service = new FolderProjectIdentityService({
      repository, hydratePage: vi.fn(),
      withBoardApplication: board.withFolderBoardApplication.bind(board),
    });
    try {
      await service.mutateFromPage({ pageId: identityId, expectedVersion: 1, command,
        actor: { actorKind: "system" }, idempotencyKey: `${command.type}:system:root` });
      expect(repository.mutate).toHaveBeenCalledWith(expect.objectContaining({
        boardApplications: [], title: command.title ?? "이전 이름", archived: command.type === "archive_page",
      }));
    } finally { await board.close(); }
  });

  it("creates the folder and project page with one UUID", async () => {
    const repository = createRepository();
    const onPageUpdated = vi.fn();
    const service = new FolderProjectIdentityService({
      repository,
      withBoardApplication: async (_input, persist) => persist([]),
      createId: () => identityId,
      createOperationId: () => "operation-af",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await expect(service.create({
      name: "새 프로젝트",
      sortOrder: 2,
      parentFolderId: null,
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "create-af",
    })).resolves.toMatchObject({
      id: identityId,
      pageId: identityId,
      folder: { id: identityId, projectPageId: identityId },
    });

    const input = vi.mocked(repository.create).mock.calls[0]?.[0];
    expect(input).toMatchObject({ id: identityId, pageId: identityId });
    expect(input?.pageApplication.replica.page).toMatchObject({
      id: identityId,
      title: "새 프로젝트",
      metadata: {},
    });
    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 1 });
  });

  it("sends name and structural fields through one repository mutation", async () => {
    const repository = createRepository();
    vi.mocked(repository.findByFolderId).mockResolvedValue({
      id: identityId,
      folderId: identityId,
      pageId: identityId,
      projectPageId: identityId,
      name: "이전 이름",
      sortOrder: 0,
      settings: {},
      parentFolderId: null,
      archived: false,
      pageVersion: 1,
      checklistEnabled: false, status: "open" as const, version: 1, createdSessionId: null, createdEventId: null, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", completedKind: null, completedSessionId: null, completedEventId: null, completedUserId: null, completedAt: null,
    });
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const onPageUpdated = vi.fn();
    const service = new FolderProjectIdentityService({
      repository,
      withBoardApplication: async (_input, persist) => persist([]),
      createOperationId: () => "operation-af",
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.mutateFromFolder({
      folderId: identityId,
      expectedVersion: 1,
      update: {
        name: "바뀐 이름",
        sortOrder: 3,
        settings: { color: "red" },
        parentFolderId: "parent",
      },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "update-af",
    });

    expect(repository.mutate).toHaveBeenCalledWith(expect.objectContaining({
      title: "바뀐 이름",
      update: {
        name: "바뀐 이름",
        sortOrder: 3,
        settings: { color: "red" },
        parentFolderId: "parent",
      },
      archived: false,
    }));
    expect(onPageUpdated).toHaveBeenCalledOnce();
    expect(onPageUpdated).toHaveBeenCalledWith({ pageId: identityId, version: 2 });
  });

  it("broadcasts a folder header refresh after archive", async () => {
    const repository = createRepository();
    vi.mocked(repository.findByFolderId).mockResolvedValue({
      id: identityId,
      folderId: identityId,
      pageId: identityId,
      projectPageId: identityId,
      name: "프로젝트",
      sortOrder: 0,
      settings: {},
      parentFolderId: null,
      archived: false,
      pageVersion: 1,
      checklistEnabled: false, status: "open" as const, version: 1, createdSessionId: null, createdEventId: null, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", completedKind: null, completedSessionId: null, completedEventId: null, completedUserId: null, completedAt: null,
    });
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    vi.mocked(repository.mutate).mockResolvedValueOnce({
      ...mutationResult({
        id: identityId,
        pageId: identityId,
        name: "프로젝트",
        version: 2,
      }),
    });
    const onCommitted = vi.fn();
    const service = new FolderProjectIdentityService({
      repository,
      withBoardApplication: async (_input, persist) => persist([]),
      createOperationId: () => "operation-af",
      hydratePage: vi.fn(),
      onCommitted,
    });

    await service.mutateFromFolder({
      folderId: identityId,
      expectedVersion: 1,
      archived: true,
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "archive-af",
    });

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith();
  });


  it("does not notify for an idempotent folder-originated retry", async () => {
    const repository = createRepository();
    vi.mocked(repository.findMutationByIdempotencyKey).mockResolvedValue(mutationResult({
      id: identityId,
      pageId: identityId,
      name: "이미 바뀐 프로젝트",
    }));
    const onPageUpdated = vi.fn();
    const service = new FolderProjectIdentityService({
      repository,
      withBoardApplication: async (_input, persist) => persist([]),
      hydratePage: vi.fn(),
      onPageUpdated,
    });

    await service.mutateFromFolder({
      folderId: identityId,
      expectedVersion: 1,
      update: { name: "이미 바뀐 프로젝트" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "update-af-retry",
    });

    expect(repository.mutate).not.toHaveBeenCalled();
    expect(onPageUpdated).not.toHaveBeenCalled();
  });

  it("returns a committed page result before recalculating an idempotent page retry", async () => {
    const repository = createRepository();
    const committed = mutationResult({
      id: identityId,
      pageId: identityId,
      name: "이미 바뀐 이름",
      idempotent: true,
    });
    vi.mocked(repository.findMutationByIdempotencyKey).mockResolvedValue(committed);
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(
      createPageSnapshot("이미 바뀐 이름"),
    );
    const hydratePage = vi.fn();
    const onPageUpdated = vi.fn();
    const service = new FolderProjectIdentityService({ repository, hydratePage, onPageUpdated, withBoardApplication: async (_input, persist) => persist([]) });

    await expect(service.mutateFromPage({
      pageId: identityId,
      expectedVersion: 1,
      command: { type: "rename_page", title: "이미 바뀐 이름" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "retry-page-af",
    })).resolves.toMatchObject({
      page: { id: identityId, title: "이미 바뀐 이름" },
      idempotent: true,
    });

    expect(repository.findByPageId).not.toHaveBeenCalled();
    expect(repository.mutate).not.toHaveBeenCalled();
    expect(hydratePage).toHaveBeenCalledWith(identityId);
    expect(onPageUpdated).not.toHaveBeenCalled();
  });


});

function createRepository(): FolderProjectIdentityRepository {
  const result = (input: {
    id: string;
    pageId: string;
    name: string;
    version?: number;
  }): FolderProjectIdentityMutationResult =>
    mutationResult(input);
  return {
    findMutationByIdempotencyKey: vi.fn(async () => null),
    create: vi.fn(async (input) => result(input)),
    mutate: vi.fn(async (input) => result({
      id: input.binding.folderId,
      pageId: input.binding.pageId,
      name: input.title,
      version: 2,
    })),
    findByFolderId: vi.fn(async () => null),
    findByPageId: vi.fn(async () => null),
    readPageSnapshot: vi.fn(async () => null),

  };
}

function mutationResult(input: {
  id: string;
  pageId: string;
  name: string;
  idempotent?: boolean;
  operation?: Record<string, unknown>;
  version?: number;
}): FolderProjectIdentityMutationResult {
  return {
    id: input.id,
    pageId: input.pageId,
    folder: {
      id: input.id,
      name: input.name,
      sortOrder: 0,
      settings: {},
      parentFolderId: null,
      projectPageId: input.pageId,
      archived: false, checklistEnabled: false, status: "open" as const, version: 1, createdSessionId: null, createdEventId: null, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", completedKind: null, completedSessionId: null, completedEventId: null, completedUserId: null, completedAt: null,
    },
    operation: input.operation ?? { id: "folder-operation" },
    pageCommit: {
      operation: {
        id: "page-operation",
        page_id: input.pageId,
        target_block_id: null,
        operation_type: "create_page",
        actor_kind: "user",
        actor_session_id: null,
        actor_event_id: null,
        actor_user_id: "user@example.com",
        idempotency_key: "page-create",
        expected_version: 0,
        result_version: input.version ?? 1,
        payload_json: {},
        reason: null,
        created_at: new Date(),
      },
      pageCreatedAt: new Date(),
      pageUpdatedAt: new Date(),
      idempotent: input.idempotent ?? false,
    },
  };
}

function createPageSnapshot(title = "이전 이름"): Uint8Array {
  return new PageMutationCore().createPage({
    page: { id: identityId, title, dailyDate: null },
    actor: { actorKind: "system" },
    idempotencyKey: "test:system:snapshot-af",
  }).snapshot;
}

function createBoardService(): BoardYjsService {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: () => logger, level: "silent", silent: vi.fn() };
  return new BoardYjsService({
    repository: {} as never, persistBoardItemMove: vi.fn(),
    logger: logger as unknown as FastifyBaseLogger,
    auth: { authBearerToken: "test-token", environment: "production", dashboardAuthEnabled: false,
      resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null) },
  });
}

import { describe, expect, it, vi } from "vitest";

import {
  FolderProjectIdentityService,
  type FolderProjectIdentityMutationResult,
  type FolderProjectIdentityRepository,
} from "../src/folders/folder_project_identity_service.js";
import { PageMutationCore } from "../src/page/page_mutation_core.js";

const identityId = "00000000-0000-4000-8000-0000000000af";

describe("FolderProjectIdentityService", () => {
  it("creates the folder and project page with one UUID", async () => {
    const repository = createRepository();
    const service = new FolderProjectIdentityService({
      repository,
      createId: () => identityId,
      createOperationId: () => "operation-af",
      hydratePage: vi.fn(),
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
      metadata: { projectIdentity: true, folderId: identityId },
    });
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
    });
    vi.mocked(repository.readPageSnapshot).mockResolvedValue(createPageSnapshot());
    const service = new FolderProjectIdentityService({
      repository,
      createOperationId: () => "operation-af",
      hydratePage: vi.fn(),
    });

    await service.mutateFromFolder({
      folderId: identityId,
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
    const service = new FolderProjectIdentityService({ repository, hydratePage });

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
  });

  it("returns the stored backfill outcome before listing legacy folders on retry", async () => {
    const repository = createRepository();
    const committed = mutationResult({
      id: identityId,
      pageId: identityId,
      name: "기존 프로젝트",
      idempotent: true,
      operation: { payload_json: { created_page: true } },
    });
    vi.mocked(repository.findMutationByIdempotencyKey).mockResolvedValue(committed);
    const service = new FolderProjectIdentityService({
      repository,
      hydratePage: vi.fn(),
    });

    await expect(service.backfillLegacyFolder({
      folderId: identityId,
      actor: { actorKind: "system" },
      idempotencyKey: "retry-backfill-af",
    })).resolves.toMatchObject({
      folderId: identityId,
      pageId: identityId,
      createdPage: true,
      idempotent: true,
    });

    expect(repository.listLegacyFolders).not.toHaveBeenCalled();
    expect(repository.createLegacyPageAndBind).not.toHaveBeenCalled();
  });
});

function createRepository(): FolderProjectIdentityRepository {
  const result = (input: { id: string; pageId: string; name: string }): FolderProjectIdentityMutationResult =>
    mutationResult(input);
  return {
    findMutationByIdempotencyKey: vi.fn(async () => null),
    create: vi.fn(async (input) => result(input)),
    mutate: vi.fn(async (input) => result({
      id: input.binding.folderId,
      pageId: input.binding.pageId,
      name: input.title,
    })),
    findByFolderId: vi.fn(async () => null),
    findByPageId: vi.fn(async () => null),
    readPageSnapshot: vi.fn(async () => null),
    listLegacyFolders: vi.fn(async () => []),
    bindLegacyPage: vi.fn(),
    createLegacyPageAndBind: vi.fn(),
  };
}

function mutationResult(input: {
  id: string;
  pageId: string;
  name: string;
  idempotent?: boolean;
  operation?: Record<string, unknown>;
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
        result_version: 1,
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

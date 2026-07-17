import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import {
  PageMutationCore,
  type PageMutationActor,
  type PageMutationApplication,
  type PageMutationInput,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import { toMutationResult, type PageServiceMutationResult } from "../page/page_service.js";
import { notifyPageUpdates } from "../page/page_update_notifications.js";
import type {
  FolderProjectBinding,
  FolderProjectIdentityMutationResult,
  FolderProjectIdentityRepository,
  FolderProjectIdentityServiceConfig,
  FolderProjectUpdate,
  LegacyFolderBackfillResult,
} from "./folder_project_identity_contracts.js";

export type {
  FolderProjectBinding,
  FolderProjectIdentityMutationResult,
  FolderProjectIdentityRepository,
  FolderProjectIdentityServiceConfig,
  FolderProjectRecord,
  FolderProjectUpdate,
  LegacyFolderBackfillResult,
  LegacyProjectFolder,
} from "./folder_project_identity_contracts.js";

export class FolderProjectIdentityService {
  private readonly mutationCore = new PageMutationCore();
  private readonly createId: () => string;
  private readonly createOperationId: () => string;

  constructor(private readonly config: FolderProjectIdentityServiceConfig) {
    this.createId = config.createId ?? randomUUID;
    this.createOperationId = config.createOperationId ?? randomUUID;
  }

  async create(input: {
    name: string;
    sortOrder?: number;
    settings?: Record<string, unknown>;
    parentFolderId?: string | null;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<FolderProjectIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const id = this.createId();
    assertUuid(id);
    const name = requireName(input.name);
    const pageApplication = this.mutationCore.createPage({
      page: {
        id,
        title: name,
        dailyDate: null,
        metadata: { projectIdentity: true, folderId: id },
      },
      actor: input.actor,
      idempotencyKey: pageKey("create_folder_project", input.actor, input.idempotencyKey),
      reason: "create folder project identity",
    });
    const result = await this.config.repository.create({
      id,
      pageId: id,
      name,
      sortOrder: input.sortOrder ?? 0,
      settings: input.settings ?? {},
      parentFolderId: input.parentFolderId ?? null,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    return await this.hydrate(result);
  }

  async mutateFromFolder(input: {
    folderId: string;
    update?: FolderProjectUpdate;
    archived?: boolean;
    actor: PageMutationActor;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<FolderProjectIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const binding = await this.requireFolderBinding(input.folderId);
    const update = input.update ?? {};
    const title = typeof update.name === "string" ? requireName(update.name) : binding.name;
    const archived = input.archived ?? binding.archived;
    const operations: Array<
      | { op: "rename_page"; title: string }
      | { op: "set_page_archived"; archived: boolean }
    > = [];
    if (typeof update.name === "string") operations.push({ op: "rename_page", title });
    if (input.archived !== undefined) {
      operations.push({ op: "set_page_archived", archived });
    }
    if (operations.length === 0) {
      throw new Error("folder project identity mutation has no page change");
    }
    const pageApplication = await this.pageMutation(binding, {
      pageId: binding.pageId,
      expectedVersion: binding.pageVersion,
      command: { type: "batch_operations", operations },
      actor: input.actor,
      idempotencyKey: pageKey("mutate_folder_project", input.actor, input.idempotencyKey),
      reason: input.reason,
    });
    const result = await this.config.repository.mutate({
      binding,
      title,
      archived,
      update,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    return await this.hydrate(result);
  }

  async mutateFromPage(input: PageMutationInput): Promise<PageServiceMutationResult | null> {
    if (!isIdentityCommand(input.command)) return null;
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) return await this.pageResultFromIdentityMutation(idempotent);
    const binding = await this.config.repository.findByPageId(input.pageId);
    if (!binding) return null;
    const pageApplication = await this.pageMutation(binding, input);
    const title = pageApplication.replica.page.title;
    const archived = pageApplication.replica.page.archived;
    const result = await this.config.repository.mutate({
      binding,
      title,
      archived,
      update: title === binding.name ? {} : { name: title },
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    await this.config.hydratePage(result.pageId);
    if (!result.idempotent) await this.config.onCommitted?.();
    return toMutationResult(
      pageApplication.replica,
      pageApplication.tempIdMapping,
      result.pageCommit,
    );
  }

  async backfillLegacyFolder(input: {
    folderId: string;
    existingPageId?: string;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<LegacyFolderBackfillResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      const payload = recordValue(idempotent.operation.payload_json);
      await this.config.hydratePage(idempotent.pageId);
      return {
        folderId: idempotent.id,
        pageId: idempotent.pageId,
        createdPage: payload.created_page === true,
        operation: idempotent.operation,
        pageCommit: idempotent.pageCommit,
        idempotent: true,
      };
    }
    const folders = await this.config.repository.listLegacyFolders();
    const folder = folders.find((candidate) => candidate.folderId === input.folderId);
    if (!folder) throw new Error(`legacy folder not found: ${input.folderId}`);
    if (input.existingPageId) {
      const document = await loadDocument(
        input.existingPageId,
        this.config.repository.readPageSnapshot.bind(this.config.repository),
      );
      const replica = readPageYDocReplica(input.existingPageId, document);
      if (replica.page.dailyDate) throw new Error("daily page cannot be a project identity");
      const pageApplication = this.mutationCore.mutate(document, {
        pageId: input.existingPageId,
        expectedVersion: replica.page.mutationVersion,
        command: { type: "rename_page", title: folder.name },
        actor: input.actor,
        idempotencyKey: pageKey("bind_folder_project", input.actor, input.idempotencyKey),
        reason: "bind legacy folder project page; folder title wins",
      });
      const result = await this.config.repository.bindLegacyPage({
        folder,
        pageId: input.existingPageId,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        operationId: this.createOperationId(),
        pageOperationId: this.createOperationId(),
        pageApplication,
      });
      await this.config.hydratePage(result.pageId);
      this.notifyPageUpdate(result);
      if (!result.idempotent) await this.config.onCommitted?.();
      return result;
    }
    assertUuid(folder.folderId);
    const pageApplication = this.mutationCore.createPage({
      page: {
        id: folder.folderId,
        title: folder.name,
        dailyDate: null,
        metadata: { projectIdentity: true, folderId: folder.folderId, legacy: true },
      },
      actor: input.actor,
      idempotencyKey: pageKey("backfill_folder_project", input.actor, input.idempotencyKey),
      reason: "create missing legacy folder project page",
    });
    const result = await this.config.repository.createLegacyPageAndBind({
      folder,
      pageId: folder.folderId,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    await this.config.hydratePage(result.pageId);
    this.notifyPageUpdate(result);
    if (!result.idempotent) await this.config.onCommitted?.();
    return result;
  }

  private async requireFolderBinding(folderId: string): Promise<FolderProjectBinding> {
    const binding = await this.config.repository.findByFolderId(folderId);
    if (!binding) throw new Error(`folder project identity mapping not found: ${folderId}`);
    return binding;
  }

  private async pageMutation(
    binding: FolderProjectBinding,
    input: PageMutationInput,
  ): Promise<PageMutationApplication> {
    const document = await loadDocument(
      binding.pageId,
      this.config.repository.readPageSnapshot.bind(this.config.repository),
    );
    return this.mutationCore.mutate(document, input);
  }

  private async hydrate(
    result: FolderProjectIdentityMutationResult,
  ): Promise<FolderProjectIdentityMutationResult> {
    await this.config.hydratePage(result.pageId);
    this.notifyPageUpdate(result);
    if (!result.idempotent) await this.config.onCommitted?.();
    return result;
  }

  private notifyPageUpdate(
    result: FolderProjectIdentityMutationResult | LegacyFolderBackfillResult,
  ): void {
    notifyPageUpdates([result], this.config.onPageUpdated);
  }

  private async pageResultFromIdentityMutation(
    result: FolderProjectIdentityMutationResult,
  ): Promise<PageServiceMutationResult> {
    const document = await loadDocument(
      result.pageId,
      this.config.repository.readPageSnapshot.bind(this.config.repository),
    );
    await this.config.hydratePage(result.pageId);
    return {
      ...toMutationResult(readPageYDocReplica(result.pageId, document), {}, result.pageCommit),
      idempotent: true,
    };
  }
}

async function loadDocument(
  pageId: string,
  readSnapshot: (pageId: string) => Promise<Uint8Array | null>,
): Promise<Y.Doc> {
  const snapshot = await readSnapshot(pageId);
  if (!snapshot) throw new Error(`folder project page snapshot missing: ${pageId}`);
  const document = new Y.Doc();
  Y.applyUpdate(document, snapshot);
  readPageYDocReplica(pageId, document);
  return document;
}

function pageKey(operation: string, actor: PageMutationActor, key: string): string {
  return `${operation}:${actor.actorSessionId ?? actor.actorUserId ?? actor.actorKind}:${key}`;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("folder project name must be a non-empty string");
  return name;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("folder project identity id must be a UUID");
  }
}

function isIdentityCommand(command: PageMutationInput["command"]): boolean {
  if (["rename_page", "archive_page", "unarchive_page"].includes(command.type)) return true;
  return command.type === "batch_operations" && command.operations.some((operation) =>
    operation.op === "rename_page" || operation.op === "set_page_archived"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

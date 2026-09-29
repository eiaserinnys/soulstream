import type { InitialFolderContext } from "@soulstream/page-model";
import { initialFolderOperations } from "./folder_initial_context.js";
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
} from "./folder_project_identity_contracts.js";

export type {
  FolderProjectBinding,
  FolderProjectIdentityMutationResult,
  FolderProjectIdentityRepository,
  FolderProjectIdentityServiceConfig,
  FolderProjectRecord,
  FolderProjectUpdate,
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
    checklistEnabled?: boolean;
    description?: string;
    initialContext?: InitialFolderContext;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<FolderProjectIdentityMutationResult> {
    const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey, request,
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
        metadata: {},
      },
      actor: input.actor,
      idempotencyKey: pageKey("create_folder", input.actor, input.idempotencyKey),
      reason: "create folder identity",
      ...(input.checklistEnabled || input.description || input.initialContext ? {
        initialCommand: { type: "batch_operations" as const,
          operations: initialFolderOperations(name, input.description ?? "", id, randomUUID, input.initialContext) },
      } : {}),
    });
    const persist = (boardApplications: import("../board-yjs/board_yjs_types.js").BoardYjsDocumentApplication[]) => this.config.repository.create({
      boardApplications,
      id,
      pageId: id,
      name,
      sortOrder: input.sortOrder ?? 0,
      settings: input.settings ?? {},
      parentFolderId: input.parentFolderId ?? null,
      checklistEnabled: input.checklistEnabled ?? false,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      request,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    const result = await this.config.withBoardApplication({ folderId: id,
      parentFolderId: input.parentFolderId ?? null, previousParentFolderId: null,
      title: name, archived: false }, persist);
    return await this.hydrate(result);
  }

  async mutateFromFolder(input: {
    folderId: string;
    expectedVersion: number;
    update?: FolderProjectUpdate;
    archived?: boolean;
    actor: PageMutationActor;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<FolderProjectIdentityMutationResult> {
    const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey, request,
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
    // Folder-only metadata mutations still pass through the same identity transaction.
    if (operations.length === 0) operations.push({ op: "rename_page", title });
    const pageApplication = await this.pageMutation(binding, {
      pageId: binding.pageId,
      expectedVersion: binding.pageVersion,
      command: { type: "batch_operations", operations },
      actor: input.actor,
      idempotencyKey: pageKey("update_folder", input.actor, input.idempotencyKey),
      reason: input.reason,
    });
    const parentFolderId = Object.hasOwn(update, "parentFolderId") ? update.parentFolderId ?? null : binding.parentFolderId;
    const result = await this.config.withBoardApplication({ folderId: binding.folderId, parentFolderId,
      previousParentFolderId: binding.parentFolderId, title, archived }, async (boardApplications) => this.config.repository.mutate({
      boardApplications,
      binding,
      expectedVersion: input.expectedVersion,
      title,
      archived,
      update,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      request,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    }));
    return await this.hydrate(result);
  }

  async mutateFromPage(input: PageMutationInput): Promise<PageServiceMutationResult | null> {
    if (!isIdentityCommand(input.command)) return null;
    const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey, request,
    );
    if (idempotent) return await this.pageResultFromIdentityMutation(idempotent);
    const binding = await this.config.repository.findByPageId(input.pageId);
    if (!binding) return null;
    const pageApplication = await this.pageMutation(binding, input);
    const title = pageApplication.replica.page.title;
    const archived = pageApplication.replica.page.archived;
    const result = await this.config.withBoardApplication({ folderId: binding.folderId,
      parentFolderId: binding.parentFolderId, previousParentFolderId: binding.parentFolderId, title, archived },
      async (boardApplications) => this.config.repository.mutate({ boardApplications,
      binding,
      expectedVersion: binding.version,
      title,
      archived,
      update: title === binding.name ? {} : { name: title },
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      request,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    }));
    await this.config.hydratePage(result.pageId);
    if (!result.idempotent) await this.config.onCommitted?.();
    return toMutationResult(
      pageApplication.replica,
      pageApplication.tempIdMapping,
      result.pageCommit,
    );
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
    try { return this.mutationCore.mutate(document, input); } finally { document.destroy(); }
  }

  private async hydrate(
    result: FolderProjectIdentityMutationResult,
  ): Promise<FolderProjectIdentityMutationResult> {
    await this.config.hydratePage(result.pageId);
    for (const update of result.parentPageUpdates ?? []) await this.config.hydratePage(update.pageId);
    notifyPageUpdates((result.parentPageUpdates ?? []).map(update => ({ page: { id: update.pageId, version: update.version } })), this.config.onPageUpdated);
    this.notifyPageUpdate(result);
    if (!result.idempotent) await this.config.onCommitted?.();
    return result;
  }

  private notifyPageUpdate(
    result: FolderProjectIdentityMutationResult,
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

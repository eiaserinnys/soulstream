import { randomUUID } from "node:crypto";

import {
  PageMutationCore,
  type PageMutationActor,
  type PageMutationApplication,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import { toMutationResult, type PageServiceMutationResult } from "../page/page_service.js";
import { notifyPageUpdates } from "../page/page_update_notifications.js";
import type {
  LegacyRunbookBackfillResult,
  RunbookTaskIdentityMutationResult,
  RunbookTaskIdentityRepository,
  RunbookTaskIdentityServiceConfig,
  TaskProjectPageBinding,
  TaskIdentityBinding,
} from "./runbook_task_identity_contracts.js";
import {
  assertUuid,
  initialTaskOperations,
  isIdentityPageCommand,
  loadPageDocument,
  pageIdempotencyKey,
  pageMutationIdempotencyKey,
  requireNonEmpty,
} from "./runbook_task_identity_page.js";

export type {
  LegacyRunbookBackfillResult,
  LegacyRunbookBinding,
  RunbookTaskIdentityBoardApplication,
  RunbookTaskIdentityBoardPort,
  RunbookTaskIdentityMutationResult,
  RunbookTaskIdentityRepository,
  RunbookTaskIdentityServiceConfig,
  TaskProjectPageBinding,
  TaskIdentityBinding,
} from "./runbook_task_identity_contracts.js";

export class RunbookTaskIdentityService {
  private readonly mutationCore: PageMutationCore;
  private readonly createId: () => string;
  private readonly createOperationId: () => string;
  private readonly createBlockId: () => string;

  constructor(private readonly config: RunbookTaskIdentityServiceConfig) {
    this.createId = config.createId ?? randomUUID;
    this.createOperationId = config.createOperationId ?? randomUUID;
    this.createBlockId = config.createBlockId ?? randomUUID;
    this.mutationCore = new PageMutationCore({ createId: this.createBlockId });
  }

  async create(input: {
    title: string;
    description?: string;
    folderId: string;
    runbookId?: string;
    x?: number;
    y?: number;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<RunbookTaskIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      if (idempotent.projectPageId) {
        await this.config.hydratePage(idempotent.projectPageId);
      }
      return idempotent;
    }
    const id = input.runbookId ?? this.createId();
    assertUuid(id);
    const title = requireNonEmpty(input.title, "title");
    const boardItemId = `runbook:${id}`;
    const pageApplication = this.mutationCore.createPage({
      page: { id, title, dailyDate: null, metadata: { taskIdentity: true } },
      actor: input.actor,
      idempotencyKey: pageIdempotencyKey(input.actor, input.idempotencyKey),
      reason: "create runbook task identity",
      initialCommand: {
        type: "batch_operations",
        operations: initialTaskOperations(title, input.description ?? "", id, this.createBlockId),
      },
    });
    const projectPage = await this.config.repository.findProjectPageByFolderId(input.folderId);
    const projectPageApplication = projectPage
      ? await this.createProjectMountApplication(
        projectPage,
        title,
        input.actor,
        input.idempotencyKey,
      )
      : undefined;
    const result = await this.config.board.withRunbookBoardApplication({
      folderId: input.folderId,
      boardItemId,
      runbookId: id,
      title,
      archived: false,
      x: input.x ?? 0,
      y: input.y ?? 0,
    }, async (boardApplication) => await this.config.repository.create({
      id,
      pageId: id,
      runbookId: id,
      taskPageId: id,
      boardItemId,
      folderId: input.folderId,
      title,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
      boardApplication,
      expectedProjectPageId: projectPage?.pageId ?? null,
      ...(projectPageApplication
        ? {
          projectPageOperationId: this.createOperationId(),
          projectPageApplication,
        }
        : {}),
    }));
    await this.config.hydratePage(result.pageId);
    if (result.projectPageId) {
      await this.config.hydratePage(result.projectPageId);
    }
    this.notifyPageUpdate(result);
    return result;
  }

  private async createProjectMountApplication(
    projectPage: TaskProjectPageBinding,
    title: string,
    actor: PageMutationActor,
    idempotencyKey: string,
  ): Promise<PageMutationApplication> {
    const document = await loadPageDocument(
      projectPage.pageId,
      (pageId) => this.config.repository.readPageSnapshot(pageId),
    );
    const replica = readPageYDocReplica(projectPage.pageId, document);
    const afterBlockId = replica.blocks
      .filter((block) => block.parentId === null)
      .at(-1)?.id ?? null;
    return this.mutationCore.mutate(document, {
      pageId: projectPage.pageId,
      expectedVersion: replica.page.mutationVersion,
      command: {
        type: "create_block",
        parentId: null,
        afterBlockId,
        blockType: "paragraph",
        text: `[[${title}]]`,
        properties: {},
      },
      actor,
      idempotencyKey: pageMutationIdempotencyKey(
        "mount_task_identity_project",
        actor,
        `${idempotencyKey}:project:${projectPage.pageId}`,
      ),
      reason: "mount runbook task identity in project",
    });
  }

  async promoteExistingPage(input: {
    pageId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    x?: number;
    y?: number;
  }): Promise<RunbookTaskIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const existing = await this.config.repository.findByPageId(input.pageId);
    if (existing) {
      throw new Error(`page is already a task identity: ${input.pageId}`);
    }
    const snapshot = await loadPageDocument(
      input.pageId,
      (pageId) => this.config.repository.readPageSnapshot(pageId),
    );
    const replica = readPageYDocReplica(input.pageId, snapshot);
    const title = requireNonEmpty(input.title || replica.page.title, "title");
    const pageApplication = this.mutationCore.mutate(snapshot, {
      pageId: input.pageId,
      expectedVersion: replica.page.mutationVersion,
      command: {
        type: "batch_operations",
        operations: [{
          op: "create_block",
          tempId: this.createBlockId(),
          parentId: null,
          afterBlockId: replica.blocks.filter((block) => block.parentId === null).at(-1)?.id ?? null,
          blockType: "runbook_ref",
          text: "",
          properties: { runbookId: input.pageId, primary: true },
          collapsed: false,
        }],
      },
      actor: input.actor,
      idempotencyKey: pageMutationIdempotencyKey("promote_task_identity", input.actor, input.idempotencyKey),
      reason: "promote page to runbook task identity",
    });
    const boardItemId = `runbook:${input.pageId}`;
    const result = await this.config.board.withRunbookBoardApplication({
      folderId: input.folderId,
      boardItemId,
      runbookId: input.pageId,
      title,
      archived: replica.page.archived,
      x: input.x ?? 0,
      y: input.y ?? 0,
    }, async (boardApplication) => await this.config.repository.promote({
      id: input.pageId,
      pageId: input.pageId,
      runbookId: input.pageId,
      taskPageId: input.pageId,
      boardItemId,
      folderId: input.folderId,
      title,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
      boardApplication,
    }));
    await this.config.hydratePage(result.pageId);
    this.notifyPageUpdate(result);
    return result;
  }

  async mutateFromPage(input: {
    pageId: string;
    expectedVersion: number;
    expectedStateVector?: Uint8Array;
    command: Parameters<PageMutationCore["mutate"]>[1]["command"];
    actor: PageMutationActor;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<PageServiceMutationResult | null> {
    if (!isIdentityPageCommand(input.command)) return null;
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      const document = await loadPageDocument(
        idempotent.pageId,
        (pageId) => this.config.repository.readPageSnapshot(pageId),
      );
      const replica = readPageYDocReplica(idempotent.pageId, document);
      const payload = idempotent.pageCommit.operation.payload_json;
      const tempIdMapping = isRecord(payload.temp_id_mapping)
        ? Object.fromEntries(
            Object.entries(payload.temp_id_mapping)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {};
      return toMutationResult(replica, tempIdMapping, idempotent.pageCommit);
    }
    const binding = await this.config.repository.findByPageId(input.pageId);
    if (!binding) return null;
    const snapshot = await loadPageDocument(
      binding.pageId,
      (pageId) => this.config.repository.readPageSnapshot(pageId),
    );
    const pageApplication = this.mutationCore.mutate(snapshot, input);
    const result = await this.persistMutation(binding, pageApplication, {
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      expectedRunbookVersion: binding.runbookVersion,
    });
    return toMutationResult(
      pageApplication.replica,
      pageApplication.tempIdMapping,
      result.pageCommit,
    );
  }

  async mutateFromRunbook(input: {
    runbookId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    actor: PageMutationActor;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<RunbookTaskIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const binding = await this.config.repository.findByRunbookId(input.runbookId);
    if (!binding) throw new Error(`task identity mapping not found: ${input.runbookId}`);
    const operations: Array<
      | { op: "rename_page"; title: string }
      | { op: "set_page_archived"; archived: boolean }
    > = [];
    if (input.title !== undefined) operations.push({
      op: "rename_page" as const,
      title: input.title,
    });
    if (input.archived !== undefined) operations.push({
      op: "set_page_archived" as const,
      archived: input.archived,
    });
    if (operations.length === 0) throw new Error("task identity mutation is empty");
    const snapshot = await loadPageDocument(
      binding.pageId,
      (pageId) => this.config.repository.readPageSnapshot(pageId),
    );
    const pageApplication = this.mutationCore.mutate(snapshot, {
      pageId: binding.pageId,
      expectedVersion: binding.pageVersion,
      command: { type: "batch_operations", operations },
      actor: input.actor,
      idempotencyKey: pageMutationIdempotencyKey("mutate_task_identity", input.actor, input.idempotencyKey),
      reason: input.reason,
    });
    const result = await this.persistMutation(binding, pageApplication, {
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      expectedRunbookVersion: input.expectedVersion,
    });
    this.notifyPageUpdate(result);
    return result;
  }

  async backfillLegacyRunbook(input: {
    runbookId: string;
    existingPageId?: string;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<LegacyRunbookBackfillResult> {
    const idempotent = await this.config.repository.findLegacyBackfillByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      if (idempotent.createdPage) await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const binding = await this.config.repository.findLegacyRunbook(input.runbookId);
    if (!binding) throw new Error(`unbound legacy runbook not found: ${input.runbookId}`);
    if (input.existingPageId) {
      const document = await loadPageDocument(
        input.existingPageId,
        (pageId) => this.config.repository.readPageSnapshot(pageId),
      );
      const replica = readPageYDocReplica(input.existingPageId, document);
      const hasPrimaryReference = replica.blocks.some((block) =>
        block.type === "runbook_ref"
        && block.properties.runbookId === input.runbookId
        && block.properties.primary === true
      );
      if (!hasPrimaryReference) {
        throw new Error(
          `legacy page ${input.existingPageId} has no primary reference to ${input.runbookId}`,
        );
      }
      return await this.config.repository.bindLegacyPage({
        binding,
        pageId: input.existingPageId,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        operationId: this.createOperationId(),
      });
    }

    const pageId = this.createId();
    assertUuid(pageId);
    const pageApplication = this.mutationCore.createPage({
      page: {
        id: pageId,
        title: binding.title,
        dailyDate: null,
        metadata: { taskIdentity: true, legacyRunbookId: input.runbookId },
      },
      actor: input.actor,
      idempotencyKey: pageMutationIdempotencyKey(
        "backfill_task_identity",
        input.actor,
        `${input.idempotencyKey}:page`,
      ),
      reason: "backfill legacy runbook task page",
      initialCommand: {
        type: "batch_operations",
        operations: initialTaskOperations(
          binding.title,
          "",
          input.runbookId,
          this.createBlockId,
        ),
      },
    });
    const result = await this.config.repository.createLegacyPageAndBind({
      binding,
      pageId,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      pageOperationId: this.createOperationId(),
      pageApplication,
    });
    await this.config.hydratePage(pageId);
    this.notifyPageUpdate(result);
    return result;
  }

  private async persistMutation(
    binding: TaskIdentityBinding,
    pageApplication: PageMutationApplication,
    input: {
      actor: PageMutationActor;
      idempotencyKey: string;
      expectedRunbookVersion: number;
    },
  ): Promise<RunbookTaskIdentityMutationResult> {
    const title = pageApplication.replica.page.title;
    const archived = pageApplication.replica.page.archived;
    const operationType = archived !== binding.archived
      ? archived ? "archive_runbook" : "unarchive_runbook"
      : "update_runbook";
    const result = await this.config.board.withRunbookBoardApplication({
      folderId: binding.folderId,
      boardItemId: binding.boardItemId,
      runbookId: binding.runbookId,
      title,
      archived,
      x: binding.x,
      y: binding.y,
    }, async (boardApplication) => await this.config.repository.mutate({
      binding,
      title,
      archived,
      expectedRunbookVersion: input.expectedRunbookVersion,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      operationType,
      pageOperationId: this.createOperationId(),
      pageApplication,
      boardApplication,
    }));
    await this.config.hydratePage(result.pageId);
    return result;
  }

  private notifyPageUpdate(
    result: RunbookTaskIdentityMutationResult | LegacyRunbookBackfillResult,
  ): void {
    notifyPageUpdates([result], this.config.onPageUpdated);
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

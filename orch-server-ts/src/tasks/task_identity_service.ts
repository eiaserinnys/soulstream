import { randomUUID } from "node:crypto";
import type { InitialTaskContext } from "@soulstream/page-model";

import {
  PageMutationCore,
  type PageMutationActor,
  type PageMutationApplication,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import { toMutationResult, type PageServiceMutationResult } from "../page/page_service.js";
import { notifyPageUpdates } from "../page/page_update_notifications.js";
import type { CatalogBoardItemRow } from "../board-yjs/board_yjs_types.js";
import type {
  LegacyTaskBackfillResult,
  TaskIdentityMutationResult,
  TaskIdentityRepository,
  TaskIdentityServiceConfig,
  TaskProjectPageBinding,
  TaskIdentityBinding,
} from "./task_identity_contracts.js";
import {
  isTaskIdentityTitleRace,
  TaskIdentityTitleConflictError,
} from "./task_identity_errors.js";
import {
  assertUuid,
  initialTaskOperations,
  isIdentityPageCommand,
  loadPageDocument,
  pageIdempotencyKey,
  pageMutationIdempotencyKey,
  requireNonEmpty,
} from "./task_identity_page.js";
import { backfillLegacyTaskIdentity } from "./task_identity_legacy.js";
import { promoteTaskPage } from "./task_identity_promotion.js";
import {
  hydrateAndNotifyTaskMounts,
  moveTaskIdentity,
  planTaskIdentityMountChanges,
} from "./task_identity_lifecycle.js";

export type {
  LegacyTaskBackfillResult,
  LegacyTaskBinding,
  TaskIdentityBoardApplication,
  TaskIdentityBoardPort,
  TaskIdentityMutationResult,
  TaskIdentityRepository,
  TaskIdentityServiceConfig,
  TaskProjectPageBinding,
  TaskPageTitleBinding,
  TaskIdentityBinding,
  TaskMountBinding,
  TaskMountPageApplication,
} from "./task_identity_contracts.js";

export class TaskIdentityService {
  private readonly mutationCore: PageMutationCore;
  private readonly createId: () => string;
  private readonly createOperationId: () => string;
  private readonly createBlockId: () => string;

  constructor(private readonly config: TaskIdentityServiceConfig) {
    this.createId = config.createId ?? randomUUID;
    this.createOperationId = config.createOperationId ?? randomUUID;
    this.createBlockId = config.createBlockId ?? randomUUID;
    this.mutationCore = new PageMutationCore({ createId: this.createBlockId });
  }

  async create(input: {
    title: string;
    description?: string;
    initialContext?: InitialTaskContext;
    folderId: string;
    taskId?: string;
    x?: number;
    y?: number;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<TaskIdentityMutationResult> {
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
    if (input.taskId) assertUuid(input.taskId);
    const title = requireNonEmpty(input.title, "title");
    const existingTitle = await this.resolveTitleOrRace(input, title);
    if (existingTitle) return existingTitle;
    const id = input.taskId ?? this.createId();
    assertUuid(id);
    const boardItemId = `task:${id}`;
    const pageApplication = this.mutationCore.createPage({
      page: { id, title, dailyDate: null, metadata: { taskIdentity: true } },
      actor: input.actor,
      idempotencyKey: pageIdempotencyKey(input.actor, input.idempotencyKey),
      reason: "create task identity",
      initialCommand: {
        type: "batch_operations",
        operations: initialTaskOperations(
          title,
          input.description ?? "",
          id,
          this.createBlockId,
          input.initialContext,
        ),
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
    let result: TaskIdentityMutationResult;
    try {
      result = await this.config.board.withTaskBoardApplication({
        folderId: input.folderId,
        boardItemId,
        taskId: id,
        title,
        archived: false,
        x: input.x ?? 0,
        y: input.y ?? 0,
      }, async (boardApplication) => await this.config.repository.create({
        id,
        pageId: id,
        taskId: id,
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
    } catch (error) {
      if (!isTaskIdentityTitleRace(error)) throw error;
      const recovered = await this.resolveTitleOrRace(input, title);
      if (recovered) return recovered;
      throw new TaskIdentityTitleConflictError(
        "같은 이름의 페이지가 이미 있습니다. 기존 페이지를 사용하거나 다른 이름을 사용해주세요.",
      );
    }
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
      reason: "mount task identity in project",
    });
  }

  private async resolveTitleOrRace(
    input: Parameters<TaskIdentityService["create"]>[0],
    title: string,
  ): Promise<TaskIdentityMutationResult | null> {
    try {
      return await this.resolveExistingTitle(input, title);
    } catch (error) {
      if (!isTaskIdentityTitleRace(error)) throw error;
      return await this.resolveExistingTitle(input, title);
    }
  }

  private async resolveExistingTitle(
    input: Parameters<TaskIdentityService["create"]>[0],
    title: string,
  ): Promise<TaskIdentityMutationResult | null> {
    const page = await this.config.repository.findPageByTitle(title);
    if (!page) return null;
    if (input.taskId && input.taskId !== page.pageId) {
      throw new TaskIdentityTitleConflictError(
        "요청한 업무 ID와 같은 이름의 기존 페이지 ID가 다릅니다. 기존 페이지를 사용하거나 다른 이름을 사용해주세요.",
      );
    }
    if (page.archived) {
      throw new TaskIdentityTitleConflictError(
        "같은 이름의 보관된 페이지가 이미 있습니다. 페이지를 복구하거나 다른 이름을 사용해주세요.",
      );
    }
    if (page.dailyDate) {
      throw new TaskIdentityTitleConflictError(
        "같은 이름의 데일리 페이지가 이미 있습니다. 다른 이름을 사용해주세요.",
      );
    }
    if (page.projectFolderId) {
      throw new TaskIdentityTitleConflictError(
        "같은 이름의 프로젝트 페이지가 이미 있습니다. 다른 이름을 사용해주세요.",
      );
    }
    const binding = await this.config.repository.findByPageId(page.pageId);
    if (binding) {
      if (binding.folderId !== input.folderId) {
        throw new TaskIdentityTitleConflictError(
          "같은 이름의 업무가 다른 프로젝트에 이미 있습니다. 기존 업무를 이동하거나 다른 이름을 사용해주세요.",
        );
      }
      const existing = await this.config.repository.findCreateResultByTaskId(
        binding.taskId,
      );
      if (!existing) {
        throw new Error(`task identity create operation missing: ${binding.taskId}`);
      }
      await this.config.hydratePage(existing.pageId);
      if (existing.projectPageId) await this.config.hydratePage(existing.projectPageId);
      return { ...existing, idempotent: true };
    }
    const result = await promoteTaskPage({
      config: this.config,
      mutationCore: this.mutationCore,
      createBlockId: this.createBlockId,
      createOperationId: this.createOperationId,
      pageId: page.pageId,
      folderId: input.folderId,
      title: page.title,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      x: input.x,
      y: input.y,
      ensureProjectMount: true,
      initialContext: input.initialContext,
    });
    this.notifyPageUpdate(result);
    return result;
  }

  async promoteExistingPage(input: {
    pageId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    x?: number;
    y?: number;
  }): Promise<TaskIdentityMutationResult> {
    const result = await promoteTaskPage({
      config: this.config,
      mutationCore: this.mutationCore,
      createBlockId: this.createBlockId,
      createOperationId: this.createOperationId,
      ensureProjectMount: false,
      ...input,
    });
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
      expectedTaskVersion: binding.taskVersion,
    });
    return toMutationResult(
      pageApplication.replica,
      pageApplication.tempIdMapping,
      result.pageCommit,
    );
  }

  async mutateFromTask(input: {
    taskId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    actor: PageMutationActor;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<TaskIdentityMutationResult> {
    const idempotent = await this.config.repository.findMutationByIdempotencyKey(
      input.idempotencyKey,
    );
    if (idempotent) {
      await this.config.hydratePage(idempotent.pageId);
      return idempotent;
    }
    const binding = await this.config.repository.findByTaskId(input.taskId);
    if (!binding) throw new Error(`task identity mapping not found: ${input.taskId}`);
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
      expectedTaskVersion: input.expectedVersion,
    });
    this.notifyPageUpdate(result);
    return result;
  }

  async moveBoardItemToContainer(input: {
    boardItem: CatalogBoardItemRow;
    targetScope: {
      folderId: string;
      containerKind: "folder" | "task";
      containerId: string;
    };
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemRow> {
    return await moveTaskIdentity({
      config: this.config,
      mutationCore: this.mutationCore,
      createBlockId: this.createBlockId,
      createOperationId: this.createOperationId,
      move: input,
    });
  }

  async backfillLegacyTask(input: {
    taskId: string;
    existingPageId?: string;
    actor: PageMutationActor;
    idempotencyKey: string;
  }): Promise<LegacyTaskBackfillResult> {
    return await backfillLegacyTaskIdentity({
      config: this.config,
      mutationCore: this.mutationCore,
      createId: this.createId,
      createOperationId: this.createOperationId,
      createBlockId: this.createBlockId,
      ...input,
    });
  }

  private async persistMutation(
    binding: TaskIdentityBinding,
    pageApplication: PageMutationApplication,
    input: {
      actor: PageMutationActor;
      idempotencyKey: string;
      expectedTaskVersion: number;
    },
  ): Promise<TaskIdentityMutationResult> {
    const title = pageApplication.replica.page.title;
    const archived = pageApplication.replica.page.archived;
    const operationType = archived !== binding.archived
      ? archived ? "archive_task" : "unarchive_task"
      : "update_task";
    const mountChanges = await planTaskIdentityMountChanges({
      config: this.config,
      mutationCore: this.mutationCore,
      createBlockId: this.createBlockId,
      createOperationId: this.createOperationId,
      binding,
      title,
      archived,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    const mountPageApplications = mountChanges.applications;
    const result = await this.config.board.withTaskBoardApplication({
      folderId: binding.folderId,
      boardItemId: binding.boardItemId,
      taskId: binding.taskId,
      title,
      archived,
      x: binding.x,
      y: binding.y,
    }, async (boardApplication) => await this.config.repository.mutate({
      binding,
      title,
      archived,
      expectedTaskVersion: input.expectedTaskVersion,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: this.createOperationId(),
      operationType,
      pageOperationId: this.createOperationId(),
      pageApplication,
      boardApplication,
      ...(mountPageApplications.length > 0 ? { mountPageApplications } : {}),
      ...(mountChanges.expectation ? { mountExpectation: mountChanges.expectation } : {}),
    }));
    await this.config.hydratePage(result.pageId);
    await hydrateAndNotifyTaskMounts(this.config, mountPageApplications);
    return result;
  }

  private notifyPageUpdate(
    result: TaskIdentityMutationResult | LegacyTaskBackfillResult,
  ): void {
    notifyPageUpdates([result], this.config.onPageUpdated);
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

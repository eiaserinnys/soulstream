import { createHash } from "node:crypto";

import type {
  ChecklistBlockProperties,
  ChecklistTaskReference,
  PageDto,
} from "@soulstream/page-model";

import type {
  TaskItemRow,
  TaskItemStatus,
  TaskSnapshot,
} from "../db/session_db_types.js";
import { TaskVersionConflict } from "../work-task/task_models.js";
import type {
  TaskActorParams,
  TaskMutationResult,
} from "../work-task/task_service_models.js";
import type { TaskService } from "../work-task/task_service.js";
import type { TaskIdentityHostClient } from "../work-task/task_identity_host_client.js";
import { defaultFolderIdForSessionType } from "../system_folders.js";

const CHECKLIST_SECTION_TITLE = "체크리스트";
const MAX_CAS_ATTEMPTS = 3;

export type ChecklistTaskPort = Pick<
  TaskService,
  | "getTask"
  | "createSection"
  | "createItem"
  | "patchItem"
  | "setItemStatus"
>;

export type ChecklistTaskIdentityPort = Pick<
  TaskIdentityHostClient,
  "promoteExistingPage"
>;

export interface ChecklistAdapterPage
  extends Pick<PageDto, "id" | "title" | "metadata"> {}

export interface ChecklistAdapterBlock {
  id: string;
  text: string;
  properties: ChecklistBlockProperties;
}

export interface ChecklistReconcileInput {
  page: ChecklistAdapterPage;
  block: ChecklistAdapterBlock;
  actor: TaskActorParams;
}

export interface ChecklistProjection {
  properties: ChecklistTaskReference;
  status: TaskItemStatus;
  checked: boolean;
}

export interface ChecklistToggleInput {
  taskId: string;
  itemId: string;
  actor: TaskActorParams;
  idempotencyKey: string;
}

export interface ChecklistSetCheckedInput {
  taskId: string;
  itemId: string;
  checked: boolean;
  expectedVersion: number;
  actor: TaskActorParams;
  reason: string | null;
  idempotencyKey: string;
}

export interface ChecklistStatusMutationResult {
  projection: ChecklistProjection;
  mutation: TaskMutationResult;
}

export class ChecklistBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecklistBindingMismatchError";
  }
}

/**
 * Reconciles checklist block identity with durable Task operations.
 * The caller writes only the returned reference into Y.Doc; status never does.
 */
export class ChecklistTaskAdapter {
  private readonly itemTails = new Map<string, Promise<void>>();

  constructor(
    private readonly tasks: ChecklistTaskPort,
    private readonly taskIdentities: ChecklistTaskIdentityPort,
  ) {}

  async reconcile(input: ChecklistReconcileInput): Promise<ChecklistProjection> {
    const expected = expectedReference(input.page.id, input.block.id);
    const existingReference = checklistReference(input.block.properties);
    if (existingReference && !isCompatibleReference(
      existingReference,
      input.page.id,
      expected.itemId,
    )) {
      throw new ChecklistBindingMismatchError(
        `checklist ${input.block.id} binding does not match its deterministic page identity`,
      );
    }
    const reference = existingReference ?? expected;
    const adoptChecked = existingReference || typeof input.block.properties.checked !== "boolean"
      ? undefined
      : input.block.properties.checked;
    return await this.withItemLock(reference.itemId, async () => {
      let snapshot = await this.ensureHierarchy(input, reference, existingReference !== null);
      let item = requireItem(snapshot, reference.itemId);
      const needsPatch = item.title !== input.block.text || item.archived;
      if (needsPatch) {
        const result = await this.tasks.patchItem({
          ...input.actor,
          taskId: reference.taskId,
          itemId: reference.itemId,
          expectedVersion: item.version,
          title: input.block.text,
          ...(item.archived ? { archived: false } : {}),
          idempotencyKey: operationKey(
            reference.itemId,
            "sync",
            `${input.block.text}:${item.archived}:${item.version}`,
          ),
        });
        snapshot = result.snapshot;
        item = requireItem(snapshot, reference.itemId);
      }
      const adoptedStatus = adoptChecked === undefined
        ? undefined
        : adoptChecked ? "completed" : "pending";
      if (adoptedStatus !== undefined && item.status !== adoptedStatus) {
        const result = await this.setStatusWithRetry({
          ...input.actor,
          taskId: reference.taskId,
          itemId: reference.itemId,
          status: adoptedStatus,
          idempotencyKey: operationKey(
            reference.itemId,
            `legacy-${adoptedStatus}`,
            String(item.version),
          ),
        });
        item = requireItem(result, reference.itemId);
      }
      return projection(reference, item);
    });
  }

  async archive(input: {
    pageId: string;
    blockId: string;
    actor: TaskActorParams;
  }): Promise<void> {
    const reference = await this.resolveExistingReference(input.pageId, input.blockId);
    await this.withItemLock(reference.itemId, async () => {
      const snapshot = await this.tasks.getTask(reference.taskId);
      const item = snapshot?.items.find((candidate) => candidate.id === reference.itemId);
      if (!item || item.archived) return;
      await this.tasks.patchItem({
        ...input.actor,
        taskId: reference.taskId,
        itemId: reference.itemId,
        expectedVersion: item.version,
        archived: true,
        idempotencyKey: operationKey(reference.itemId, "archive", String(item.version)),
      });
    });
  }

  async toggle(input: ChecklistToggleInput): Promise<ChecklistProjection> {
    return await this.withItemLock(input.itemId, async () => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const snapshot = await this.requireBoundSnapshot(input.taskId, input.itemId);
        const item = requireItem(snapshot, input.itemId);
        try {
          const result = await this.tasks.setItemStatus({
            ...input.actor,
            itemId: input.itemId,
            expectedVersion: item.version,
            status: item.status === "completed" ? "pending" : "completed",
            idempotencyKey: input.idempotencyKey,
          });
          return projection(
            { taskId: input.taskId, itemId: input.itemId },
            requireItem(result.snapshot, input.itemId),
          );
        } catch (error) {
          if (!(error instanceof TaskVersionConflict) || attempt === MAX_CAS_ATTEMPTS - 1) {
            throw error;
          }
        }
      }
      throw new Error("unreachable checklist toggle retry state");
    });
  }

  /** Dashboard toggle seam. The Task item status remains the only checked-state source. */
  async setChecked(input: ChecklistSetCheckedInput): Promise<ChecklistStatusMutationResult> {
    return await this.withItemLock(input.itemId, async () => {
      await this.requireBoundSnapshot(input.taskId, input.itemId);
      const mutation = await this.tasks.setItemStatus({
        ...input.actor,
        itemId: input.itemId,
        expectedVersion: input.expectedVersion,
        status: input.checked ? "completed" : "pending",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      const item = requireItem(mutation.snapshot, input.itemId);
      if (mutation.snapshot.task.id !== input.taskId) {
        throw new ChecklistBindingMismatchError(
          `checklist item ${input.itemId} belongs to ${mutation.snapshot.task.id}`,
        );
      }
      return {
        projection: projection(
          { taskId: input.taskId, itemId: input.itemId },
          item,
        ),
        mutation,
      };
    });
  }

  private async ensureHierarchy(
    input: ChecklistReconcileInput,
    reference: ChecklistTaskReference,
    hasStoredReference: boolean,
  ): Promise<TaskSnapshot> {
    let snapshot = await this.tasks.getTask(reference.taskId);
    if (!snapshot) {
      if (hasStoredReference) {
        throw new ChecklistBindingMismatchError(
          `stored checklist task not found: ${reference.taskId}`,
        );
      }
      await this.taskIdentities.promoteExistingPage({
        actorKind: input.actor.actorKind ?? "agent",
        actorSessionId: input.actor.actorSessionId,
        actorUserId: input.actor.actorUserId,
        pageId: input.page.id,
        folderId: pageTaskFolder(input.page.metadata),
        title: input.page.title,
        idempotencyKey: `checklist-adapter:${input.page.id}:create-task`,
      });
      snapshot = await this.tasks.getTask(reference.taskId);
      if (!snapshot) {
        throw new Error(`promoted task identity is not readable: ${reference.taskId}`);
      }
    }
    const sectionId = checklistSectionId(input.page.id);
    if (!snapshot.sections.some((section) => section.id === sectionId)) {
      const result = await this.tasks.createSection({
        ...input.actor,
        taskId: reference.taskId,
        sectionId,
        title: CHECKLIST_SECTION_TITLE,
        idempotencyKey: `checklist-adapter:${input.page.id}:create-section`,
      });
      snapshot = result.snapshot;
    }
    if (!snapshot.items.some((item) => item.id === reference.itemId)) {
      const result = await this.tasks.createItem({
        ...input.actor,
        taskId: reference.taskId,
        sectionId,
        itemId: reference.itemId,
        title: input.block.text,
        idempotencyKey: `checklist-adapter:${input.block.id}:create-item`,
      });
      snapshot = result.snapshot;
    }
    return snapshot;
  }

  private async resolveExistingReference(
    pageId: string,
    blockId: string,
  ): Promise<ChecklistTaskReference> {
    const itemId = checklistItemId(blockId);
    for (const taskId of [checklistTaskId(pageId), legacyChecklistTaskId(pageId)]) {
      const snapshot = await this.tasks.getTask(taskId);
      if (snapshot?.items.some((item) => item.id === itemId)) return { taskId, itemId };
    }
    return { taskId: checklistTaskId(pageId), itemId };
  }

  private async setStatusWithRetry(input: TaskActorParams & {
    taskId: string;
    itemId: string;
    status: TaskItemStatus;
    idempotencyKey: string;
  }): Promise<TaskSnapshot> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.requireBoundSnapshot(input.taskId, input.itemId);
      const item = requireItem(snapshot, input.itemId);
      if (item.status === input.status) return snapshot;
      try {
        return (await this.tasks.setItemStatus({
          ...input,
          expectedVersion: item.version,
        })).snapshot;
      } catch (error) {
        if (!(error instanceof TaskVersionConflict) || attempt === MAX_CAS_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    throw new Error("unreachable checklist status retry state");
  }

  private async requireBoundSnapshot(taskId: string, itemId: string): Promise<TaskSnapshot> {
    const snapshot = await this.tasks.getTask(taskId);
    if (!snapshot || !snapshot.items.some((item) => item.id === itemId)) {
      throw new ChecklistBindingMismatchError(`checklist item not found: ${itemId}`);
    }
    return snapshot;
  }

  private async withItemLock<T>(itemId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.itemTails.get(itemId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.itemTails.set(itemId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.itemTails.get(itemId) === tail) this.itemTails.delete(itemId);
    }
  }
}

export function checklistTaskId(pageId: string): string {
  return pageId;
}

function legacyChecklistTaskId(pageId: string): string {
  return `page-task:${pageId}`;
}

export function checklistSectionId(pageId: string): string {
  return `page-section:${pageId}`;
}

export function checklistItemId(blockId: string): string {
  return `checklist:${blockId}`;
}

function expectedReference(pageId: string, blockId: string): ChecklistTaskReference {
  return { taskId: checklistTaskId(pageId), itemId: checklistItemId(blockId) };
}

function checklistReference(
  properties: ChecklistBlockProperties,
): ChecklistTaskReference | null {
  return typeof properties.taskId === "string" && typeof properties.itemId === "string"
    ? { taskId: properties.taskId, itemId: properties.itemId }
    : null;
}

function isCompatibleReference(
  reference: ChecklistTaskReference,
  pageId: string,
  itemId: string,
): boolean {
  return reference.itemId === itemId
    && (reference.taskId === pageId || reference.taskId === legacyChecklistTaskId(pageId));
}

function pageTaskFolder(metadata: Record<string, unknown>): string {
  const legacyFolderId = metadata.legacyFolderId;
  return typeof legacyFolderId === "string" && legacyFolderId.trim()
    ? legacyFolderId
    : defaultFolderIdForSessionType("claude");
}

function projection(
  properties: ChecklistTaskReference,
  item: TaskItemRow,
): ChecklistProjection {
  return { properties, status: item.status, checked: item.status === "completed" };
}

function requireItem(snapshot: TaskSnapshot, itemId: string): TaskItemRow {
  const item = snapshot.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new ChecklistBindingMismatchError(`checklist item not found: ${itemId}`);
  return item;
}

function operationKey(itemId: string, operation: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `checklist-adapter:${itemId}:${operation}:${digest}`;
}

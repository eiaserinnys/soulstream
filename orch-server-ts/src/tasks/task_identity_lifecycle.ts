import type { CatalogBoardItemRow } from "../board-yjs/board_yjs_types.js";
import type {
  PageMutationActor,
  PageMutationApplication,
} from "../page/page_mutation_core.js";
import { PageMutationCore } from "../page/page_mutation_core.js";
import { notifyPageUpdates } from "../page/page_update_notifications.js";
import type {
  TaskIdentityServiceConfig,
  TaskIdentityBinding,
  TaskMountBinding,
  TaskMountPageApplication,
} from "./task_identity_contracts.js";
import {
  planArchivedTaskMountRemoval,
  planTaskProjectMountReconciliation,
} from "./task_mount_reconciliation.js";

export interface MoveTaskIdentityInput {
  boardItem: CatalogBoardItemRow;
  targetScope: {
    folderId: string;
    containerKind: "folder" | "task";
    containerId: string;
  };
  position?: { x: number; y: number };
  idempotencyKey: string;
}

export async function moveTaskIdentity(input: {
  config: TaskIdentityServiceConfig;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  createOperationId: () => string;
  move: MoveTaskIdentityInput;
}): Promise<CatalogBoardItemRow> {
  const move = input.move;
  if (move.boardItem.itemType !== "task") {
    throw new Error(`task identity move requires task: ${move.boardItem.itemType}`);
  }
  if (move.targetScope.containerKind !== "folder"
    || move.targetScope.containerId !== move.targetScope.folderId) {
    throw new Error("task identity can only move between project folders");
  }
  const idempotent = await input.config.repository.findMutationByIdempotencyKey(
    move.idempotencyKey,
  );
  if (idempotent) {
    const current = await input.config.repository.findByTaskId(move.boardItem.itemId);
    if (!current) throw new Error(`task identity mapping not found: ${move.boardItem.itemId}`);
    return movedBoardItem(move.boardItem, current.folderId, move.position);
  }
  const binding = await input.config.repository.findByTaskId(move.boardItem.itemId);
  if (!binding || binding.boardItemId !== move.boardItem.id) {
    throw new Error(`task identity mapping not found: ${move.boardItem.itemId}`);
  }
  if (binding.folderId !== move.boardItem.folderId) {
    throw new Error(`task identity source folder changed: ${move.boardItem.itemId}`);
  }
  const projectPage = await input.config.repository.findProjectPageByFolderId(
    move.targetScope.folderId,
  );
  if (!projectPage) {
    throw new Error(`task identity target project not found: ${move.targetScope.folderId}`);
  }
  const actor = { actorKind: "system" as const };
  const plannedMounts = await planTaskProjectMountReconciliation({
    repository: input.config.repository,
    mutationCore: input.mutationCore,
    createBlockId: input.createBlockId,
    taskPageId: binding.pageId,
    taskTitle: binding.title,
    targetProjectPageId: projectPage.pageId,
    actor,
    idempotencyKey: move.idempotencyKey,
  });
  const mountPageApplications = withTaskMountOperationIds(
    plannedMounts.applications,
    input.createOperationId,
  );
  const moved = await input.config.board.withTaskBoardMoveApplication(
    move,
    async (boardMove) => await input.config.repository.move({
      binding,
      sourceFolderId: binding.folderId,
      targetFolderId: move.targetScope.folderId,
      expectedTargetProjectPageId: projectPage.pageId,
      actor,
      idempotencyKey: move.idempotencyKey,
      operationId: input.createOperationId(),
      boardApplications: boardMove.boardApplications,
      mountPageApplications,
      mountExpectation: {
        scope: plannedMounts.scope,
        bindings: plannedMounts.observedMounts,
      },
    }),
  );
  await hydrateAndNotifyTaskMounts(input.config, mountPageApplications);
  return moved;
}

export async function planTaskIdentityMountChanges(input: {
  config: TaskIdentityServiceConfig;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  createOperationId: () => string;
  binding: TaskIdentityBinding;
  title: string;
  archived: boolean;
  actor: PageMutationActor;
  idempotencyKey: string;
}): Promise<{
  applications: readonly TaskMountPageApplication[];
  expectation?: { scope: "all" | "project"; bindings: readonly TaskMountBinding[] };
}> {
  if (input.archived === input.binding.archived) return { applications: [] };
  const planned = input.archived
    ? await planArchivedTaskMountRemoval({
      repository: input.config.repository,
      mutationCore: input.mutationCore,
      taskPageId: input.binding.pageId,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    })
    : await planUnarchiveProjectMount(input);
  return {
    applications: withTaskMountOperationIds(planned.applications, input.createOperationId),
    expectation: { scope: planned.scope, bindings: planned.observedMounts },
  };
}

export async function hydrateAndNotifyTaskMounts(
  config: TaskIdentityServiceConfig,
  applications: readonly TaskMountPageApplication[],
): Promise<void> {
  for (const application of applications) {
    await config.hydratePage(application.pageId);
  }
  notifyPageUpdates(applications.map((item) => ({
    page: {
      id: item.pageId,
      version: item.application.replica.page.mutationVersion,
    },
  })), config.onPageUpdated);
}

async function planUnarchiveProjectMount(input: {
  config: TaskIdentityServiceConfig;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  binding: TaskIdentityBinding;
  title: string;
  actor: PageMutationActor;
  idempotencyKey: string;
}) {
  const projectPage = await input.config.repository.findProjectPageByFolderId(
    input.binding.folderId,
  );
  if (!projectPage) throw new Error(`task identity project not found: ${input.binding.folderId}`);
  return await planTaskProjectMountReconciliation({
    repository: input.config.repository,
    mutationCore: input.mutationCore,
    createBlockId: input.createBlockId,
    taskPageId: input.binding.pageId,
    taskTitle: input.title,
    targetProjectPageId: projectPage.pageId,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
  });
}

function withTaskMountOperationIds(
  applications: readonly { pageId: string; application: PageMutationApplication }[],
  createOperationId: () => string,
): TaskMountPageApplication[] {
  return applications.map((application) => ({
    ...application,
    operationId: createOperationId(),
  }));
}

function movedBoardItem(
  boardItem: CatalogBoardItemRow,
  folderId: string,
  position?: { x: number; y: number },
): CatalogBoardItemRow {
  return {
    ...boardItem,
    folderId,
    containerKind: "folder",
    containerId: folderId,
    x: position?.x ?? boardItem.x,
    y: position?.y ?? boardItem.y,
  };
}

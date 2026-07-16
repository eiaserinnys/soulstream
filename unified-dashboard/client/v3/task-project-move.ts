import type {
  BlockDto,
  PageApiClient,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import { loadAllMountBacklinks } from "./page-backlinks";
import type { PlannerTask } from "./planner-data";

export interface TaskProjectMoveTarget {
  folderId: string;
  projectPageId: string;
}

export interface TaskProjectMoveBoardPort {
  moveBoardItemToContainer(input: {
    boardItemId: string;
    container: { kind: "folder"; id: string };
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface TaskProjectMovePlan {
  task: PlannerTask;
  boardItemId: string;
  source: PageReadResponse;
  target: PageReadResponse;
  targetFolderId: string;
  sourceMount: BlockDto | null;
  targetMount: BlockDto | null;
}

export interface OptimisticTaskProjectMoveInput {
  api: PageApiClient;
  board: TaskProjectMoveBoardPort;
  task: PlannerTask;
  target: TaskProjectMoveTarget;
  project(task: PlannerTask, targetProject: TaskProjectMovePlan["target"]["page"]): void;
  idFactory?: MoveIdFactory;
}

type MoveIdFactory = (prefix: string) => string;

type AppliedMountChange =
  | { kind: "transferred"; blockId: string }
  | { kind: "created"; blockId: string }
  | { kind: "deleted"; block: BlockDto; afterBlockId: string | null }
  | { kind: "unchanged" };

export async function prepareTaskProjectMove(
  api: PageApiClient,
  task: PlannerTask,
  target: TaskProjectMoveTarget,
): Promise<TaskProjectMovePlan> {
  const sourceProjectPageId = task.projectPageId;
  if (!sourceProjectPageId) throw new Error("현재 프로젝트를 확인할 수 없습니다");
  if (sourceProjectPageId === target.projectPageId) {
    throw new Error("이미 이 프로젝트에 속한 업무입니다");
  }
  const boardItemId = task.runbook?.runbook.board_item_id;
  if (!boardItemId) throw new Error("업무 보드 카드를 확인할 수 없습니다");

  const [backlinks, source, targetPage] = await Promise.all([
    loadAllMountBacklinks(api, task.page.id),
    api.getPage(sourceProjectPageId),
    api.getPage(target.projectPageId),
  ]);
  const sourceMountId = backlinks.find((item) => (
    item.linkKind === "mount" && item.sourcePageId === sourceProjectPageId
  ))?.sourceBlockId ?? null;
  const targetMountId = backlinks.find((item) => (
    item.linkKind === "mount" && item.sourcePageId === target.projectPageId
  ))?.sourceBlockId ?? null;
  const sourceMount = sourceMountId
    ? source.blocks.find((block) => block.id === sourceMountId) ?? null
    : null;
  const targetMount = targetMountId
    ? targetPage.blocks.find((block) => block.id === targetMountId) ?? null
    : null;
  if (sourceMountId && !sourceMount) {
    throw new Error("기존 프로젝트 마운트 상태가 갱신되었습니다. 다시 시도하세요");
  }
  if (targetMountId && !targetMount) {
    throw new Error("새 프로젝트 마운트 상태가 갱신되었습니다. 다시 시도하세요");
  }

  return {
    task,
    boardItemId,
    source,
    target: targetPage,
    targetFolderId: target.folderId,
    sourceMount,
    targetMount,
  };
}

export async function executeTaskProjectMove(
  api: PageApiClient,
  board: TaskProjectMoveBoardPort,
  plan: TaskProjectMovePlan,
  idFactory: MoveIdFactory = operationId,
): Promise<void> {
  const pageChange = await applyProjectMountMove(api, plan, idFactory);
  try {
    await board.moveBoardItemToContainer({
      boardItemId: plan.boardItemId,
      container: { kind: "folder", id: plan.targetFolderId },
      idempotencyKey: idFactory("task-project-board"),
    });
  } catch (moveError) {
    try {
      await rollbackProjectMountMove(api, plan, pageChange, idFactory);
    } catch (rollbackError) {
      throw new Error(
        `프로젝트 이동 실패 후 원래 위치 복구도 실패했습니다: ${errorText(moveError)} · ${errorText(rollbackError)}`,
        { cause: moveError },
      );
    }
    throw moveError;
  }
}

export async function runOptimisticTaskProjectMove(
  input: OptimisticTaskProjectMoveInput,
): Promise<TaskProjectMovePlan> {
  const plan = await prepareTaskProjectMove(input.api, input.task, input.target);
  input.project(input.task, plan.target.page);
  try {
    await executeTaskProjectMove(
      input.api,
      input.board,
      plan,
      input.idFactory ?? operationId,
    );
    return plan;
  } catch (error) {
    input.project(
      { ...input.task, projectPageId: plan.target.page.id },
      plan.source.page,
    );
    throw error;
  }
}

async function applyProjectMountMove(
  api: PageApiClient,
  plan: TaskProjectMovePlan,
  idFactory: MoveIdFactory,
): Promise<AppliedMountChange> {
  if (plan.sourceMount && !plan.targetMount) {
    await api.transferBlocks({
      source: transferSource(plan.source, plan.sourceMount.id),
      target: transferTarget(plan.target),
      idempotencyKey: idFactory("task-project-mount"),
      reason: "v3 task project mount move",
    });
    return { kind: "transferred", blockId: plan.sourceMount.id };
  }

  if (!plan.sourceMount && !plan.targetMount) {
    const tempId = idFactory("task-project-mount");
    const result = await api.applyOperations(plan.target.page.id, {
      expectedVersion: plan.target.page.version,
      expectedStateVector: decodeStateVector(plan.target.state_vector),
      idempotencyKey: idFactory("task-project-mount-create"),
      reason: "v3 task project mount create",
      operations: [{
        op: "create_block",
        temp_id: tempId,
        parent_id: null,
        after_block_id: lastRootBlockId(plan.target.blocks),
        block_type: "paragraph",
        text: `[[${plan.task.page.title}]]`,
        properties: {},
        collapsed: false,
      }],
    });
    const blockId = result.temp_id_mapping[tempId];
    if (!blockId) throw new Error("새 프로젝트 마운트 ID를 받지 못했습니다");
    return { kind: "created", blockId };
  }

  if (plan.sourceMount && plan.targetMount) {
    const afterBlockId = previousSiblingId(plan.source.blocks, plan.sourceMount);
    await api.applyOperations(plan.source.page.id, {
      expectedVersion: plan.source.page.version,
      expectedStateVector: decodeStateVector(plan.source.state_vector),
      idempotencyKey: idFactory("task-project-duplicate-unmount"),
      reason: "v3 task old project mount remove",
      operations: [{ op: "delete_block_subtree", block_id: plan.sourceMount.id }],
    });
    return { kind: "deleted", block: plan.sourceMount, afterBlockId };
  }

  return { kind: "unchanged" };
}

async function rollbackProjectMountMove(
  api: PageApiClient,
  plan: TaskProjectMovePlan,
  change: AppliedMountChange,
  idFactory: MoveIdFactory,
): Promise<void> {
  if (change.kind === "unchanged") return;
  const [source, target] = await Promise.all([
    api.getPage(plan.source.page.id),
    api.getPage(plan.target.page.id),
  ]);

  if (change.kind === "transferred") {
    await api.transferBlocks({
      source: transferSource(target, change.blockId),
      target: transferTarget(source),
      idempotencyKey: idFactory("task-project-mount-rollback"),
      reason: "v3 task project mount rollback",
    });
    return;
  }

  if (change.kind === "created") {
    await api.applyOperations(target.page.id, {
      expectedVersion: target.page.version,
      expectedStateVector: decodeStateVector(target.state_vector),
      idempotencyKey: idFactory("task-project-created-mount-rollback"),
      reason: "v3 task project mount rollback",
      operations: [{ op: "delete_block_subtree", block_id: change.blockId }],
    });
    return;
  }

  const tempId = idFactory("task-project-deleted-mount-rollback");
  await api.applyOperations(source.page.id, {
    expectedVersion: source.page.version,
    expectedStateVector: decodeStateVector(source.state_vector),
    idempotencyKey: idFactory("task-project-deleted-mount-restore"),
    reason: "v3 task project mount rollback",
    operations: [{
      op: "create_block",
      temp_id: tempId,
      parent_id: change.block.parent_id,
      after_block_id: change.afterBlockId,
      block_type: change.block.block_type,
      text: change.block.text,
      properties: change.block.properties,
      collapsed: change.block.collapsed,
    }],
  });
}

function transferSource(page: PageReadResponse, blockId: string) {
  return {
    pageId: page.page.id,
    expectedVersion: page.page.version,
    expectedStateVector: decodeStateVector(page.state_vector),
    blockIds: [blockId],
  };
}

function transferTarget(page: PageReadResponse) {
  return {
    kind: "existing" as const,
    pageId: page.page.id,
    expectedVersion: page.page.version,
    expectedStateVector: decodeStateVector(page.state_vector),
    parentId: null,
    afterBlockId: lastRootBlockId(page.blocks),
  };
}

function lastRootBlockId(blocks: readonly BlockDto[]): string | null {
  return blocks.filter((block) => block.parent_id === null).at(-1)?.id ?? null;
}

function previousSiblingId(blocks: readonly BlockDto[], block: BlockDto): string | null {
  const siblings = blocks.filter((candidate) => candidate.parent_id === block.parent_id);
  const index = siblings.findIndex((candidate) => candidate.id === block.id);
  return siblings[index - 1]?.id ?? null;
}

function decodeStateVector(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `v3-${prefix}-${globalThis.crypto.randomUUID()}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

import type { PageApiClient, PageReadResponse } from "@seosoyoung/soul-ui/page";

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
  const [source, targetPage] = await Promise.all([
    api.getPage(sourceProjectPageId),
    api.getPage(target.projectPageId),
  ]);
  return {
    task,
    boardItemId,
    source,
    target: targetPage,
    targetFolderId: target.folderId,
  };
}

export async function executeTaskProjectMove(
  _api: PageApiClient,
  board: TaskProjectMoveBoardPort,
  plan: TaskProjectMovePlan,
  idFactory: MoveIdFactory = operationId,
): Promise<void> {
  await board.moveBoardItemToContainer({
    boardItemId: plan.boardItemId,
    container: { kind: "folder", id: plan.targetFolderId },
    idempotencyKey: idFactory("task-project-board"),
  });
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

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `v3-${prefix}-${globalThis.crypto.randomUUID()}`;
}

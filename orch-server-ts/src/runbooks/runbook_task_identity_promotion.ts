import {
  PageMutationCore,
  type PageMutationActor,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import type {
  RunbookTaskIdentityMutationResult,
  RunbookTaskIdentityServiceConfig,
  TaskMountExpectation,
  TaskMountPageApplication,
} from "./runbook_task_identity_contracts.js";
import { TaskIdentityTitleConflictError } from "./runbook_task_identity_errors.js";
import {
  planTaskProjectMountReconciliation,
} from "./runbook_task_mount_reconciliation.js";
import {
  loadPageDocument,
  pageMutationIdempotencyKey,
  requireNonEmpty,
} from "./runbook_task_identity_page.js";

export async function promoteRunbookTaskPage(input: {
  config: RunbookTaskIdentityServiceConfig;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  createOperationId: () => string;
  pageId: string;
  folderId: string;
  title: string;
  actor: PageMutationActor;
  idempotencyKey: string;
  x?: number;
  y?: number;
  ensureProjectMount: boolean;
}): Promise<RunbookTaskIdentityMutationResult> {
  const idempotent = await input.config.repository.findMutationByIdempotencyKey(
    input.idempotencyKey,
  );
  if (idempotent) {
    await hydrateResult(input.config, idempotent);
    return idempotent;
  }
  const existing = await input.config.repository.findByPageId(input.pageId);
  if (existing) {
    throw new Error(`page is already a task identity: ${input.pageId}`);
  }
  const snapshot = await loadPageDocument(
    input.pageId,
    (pageId) => input.config.repository.readPageSnapshot(pageId),
  );
  const replica = readPageYDocReplica(input.pageId, snapshot);
  const title = requireNonEmpty(input.title || replica.page.title, "title");
  const pageApplication = input.mutationCore.mutate(snapshot, {
    pageId: input.pageId,
    expectedVersion: replica.page.mutationVersion,
    command: {
      type: "batch_operations",
      operations: [{
        op: "create_block",
        tempId: input.createBlockId(),
        parentId: null,
        afterBlockId: replica.blocks.filter((block) => block.parentId === null).at(-1)?.id ?? null,
        blockType: "runbook_ref",
        text: "",
        properties: { runbookId: input.pageId, primary: true },
        collapsed: false,
      }],
    },
    actor: input.actor,
    idempotencyKey: pageMutationIdempotencyKey(
      "promote_task_identity",
      input.actor,
      input.idempotencyKey,
    ),
    reason: "promote page to runbook task identity",
  });
  const projectPlan = input.ensureProjectMount
    ? await planProjectMount(input, title)
    : null;
  const boardItemId = `runbook:${input.pageId}`;
  const result = await input.config.board.withRunbookBoardApplication({
    folderId: input.folderId,
    boardItemId,
    runbookId: input.pageId,
    title,
    archived: replica.page.archived,
    x: input.x ?? 0,
    y: input.y ?? 0,
  }, async (boardApplication) => await input.config.repository.promote({
    id: input.pageId,
    pageId: input.pageId,
    runbookId: input.pageId,
    taskPageId: input.pageId,
    boardItemId,
    folderId: input.folderId,
    title,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    operationId: input.createOperationId(),
    pageOperationId: input.createOperationId(),
    pageApplication,
    boardApplication,
    ...(projectPlan
      ? {
        expectedProjectPageId: projectPlan.projectPageId,
        mountExpectation: projectPlan.expectation,
        ...(projectPlan.applications.length > 0
          ? { mountPageApplications: projectPlan.applications }
          : {}),
      }
      : {}),
  }));
  await hydrateResult(input.config, result);
  return result;
}

async function planProjectMount(
  input: Parameters<typeof promoteRunbookTaskPage>[0],
  title: string,
): Promise<{
  projectPageId: string | null;
  applications: readonly TaskMountPageApplication[];
  expectation: TaskMountExpectation;
}> {
  const projectPage = await input.config.repository.findProjectPageByFolderId(input.folderId);
  const observed = await input.config.repository.listTaskMounts(input.pageId, "project");
  if (observed.some((mount) => mount.sourcePageId !== projectPage?.pageId)) {
    throw new TaskIdentityTitleConflictError(
      "같은 이름의 페이지가 다른 프로젝트에 연결되어 있습니다. 기존 페이지를 이동하거나 다른 이름을 사용해주세요.",
    );
  }
  if (!projectPage) {
    return {
      projectPageId: null,
      applications: [],
      expectation: { scope: "project", bindings: observed },
    };
  }
  const plan = await planTaskProjectMountReconciliation({
    repository: input.config.repository,
    mutationCore: input.mutationCore,
    createBlockId: input.createBlockId,
    taskPageId: input.pageId,
    taskTitle: title,
    targetProjectPageId: projectPage.pageId,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    projectPageId: projectPage.pageId,
    applications: plan.applications.map((application) => ({
      ...application,
      operationId: input.createOperationId(),
    })),
    expectation: { scope: plan.scope, bindings: plan.observedMounts },
  };
}

async function hydrateResult(
  config: RunbookTaskIdentityServiceConfig,
  result: RunbookTaskIdentityMutationResult,
): Promise<void> {
  await config.hydratePage(result.pageId);
  if (result.projectPageId) await config.hydratePage(result.projectPageId);
}

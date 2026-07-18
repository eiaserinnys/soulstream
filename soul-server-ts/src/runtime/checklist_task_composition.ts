import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { PageYjsHostClient } from "../page/page_host_client.js";
import { ChecklistTaskAdapter } from "../page/checklist_task_adapter.js";
import { ChecklistTaskReconciler } from "../page/checklist_task_reconciler.js";
import type { TaskService } from "../work-task/task_service.js";
import type { TaskIdentityHostClient } from "../work-task/task_identity_host_client.js";

export interface ChecklistTaskCompositionParams {
  nodeId: string;
  db: Pick<SessionDB, "checklistTaskProjections">;
  taskService: TaskService;
  taskIdentityHost: Pick<TaskIdentityHostClient, "promoteExistingPage">;
  pageHost: Pick<PageYjsHostClient, "getPage" | "batchPageOperations">;
  logger: Logger;
}

/** Production object graph for durable checklist-to-Task projection. */
export function composeChecklistTaskProjection(
  params: ChecklistTaskCompositionParams,
): {
  checklistTaskAdapter: ChecklistTaskAdapter;
  checklistTaskReconciler: ChecklistTaskReconciler;
} {
  const checklistTaskAdapter = new ChecklistTaskAdapter(
    params.taskService,
    params.taskIdentityHost,
  );
  const checklistTaskReconciler = new ChecklistTaskReconciler({
    nodeId: params.nodeId,
    repository: params.db.checklistTaskProjections(),
    adapter: checklistTaskAdapter,
    pageHost: params.pageHost,
    logger: params.logger,
  });
  return { checklistTaskAdapter, checklistTaskReconciler };
}

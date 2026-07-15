import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { PageYjsHostClient } from "../page/page_host_client.js";
import { ChecklistRunbookAdapter } from "../page/checklist_runbook_adapter.js";
import { ChecklistRunbookReconciler } from "../page/checklist_runbook_reconciler.js";
import type { RunbookService } from "../runbook/runbook_service.js";
import type { RunbookTaskIdentityHostClient } from "../runbook/runbook_task_identity_host_client.js";

export interface ChecklistRunbookCompositionParams {
  nodeId: string;
  db: Pick<SessionDB, "checklistRunbookProjections">;
  runbookService: RunbookService;
  runbookTaskIdentityHost: Pick<RunbookTaskIdentityHostClient, "promoteExistingPage">;
  pageHost: Pick<PageYjsHostClient, "getPage" | "batchPageOperations">;
  logger: Logger;
}

/** Production object graph for durable checklist-to-Runbook projection. */
export function composeChecklistRunbookProjection(
  params: ChecklistRunbookCompositionParams,
): {
  checklistRunbookAdapter: ChecklistRunbookAdapter;
  checklistRunbookReconciler: ChecklistRunbookReconciler;
} {
  const checklistRunbookAdapter = new ChecklistRunbookAdapter(
    params.runbookService,
    params.runbookTaskIdentityHost,
  );
  const checklistRunbookReconciler = new ChecklistRunbookReconciler({
    nodeId: params.nodeId,
    repository: params.db.checklistRunbookProjections(),
    adapter: checklistRunbookAdapter,
    pageHost: params.pageHost,
    logger: params.logger,
  });
  return { checklistRunbookAdapter, checklistRunbookReconciler };
}

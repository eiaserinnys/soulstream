import type { PageMutationActor } from "../page/page_mutation_core.js";
import { PageMutationCore } from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import { notifyPageUpdates } from "../page/page_update_notifications.js";
import type {
  LegacyRunbookBackfillResult,
  RunbookTaskIdentityServiceConfig,
} from "./runbook_task_identity_contracts.js";
import {
  assertUuid,
  initialTaskOperations,
  loadPageDocument,
  pageMutationIdempotencyKey,
} from "./runbook_task_identity_page.js";

export async function backfillLegacyRunbookIdentity(input: {
  config: RunbookTaskIdentityServiceConfig;
  mutationCore: PageMutationCore;
  createId: () => string;
  createOperationId: () => string;
  createBlockId: () => string;
  runbookId: string;
  existingPageId?: string;
  actor: PageMutationActor;
  idempotencyKey: string;
}): Promise<LegacyRunbookBackfillResult> {
  const idempotent = await input.config.repository.findLegacyBackfillByIdempotencyKey(
    input.idempotencyKey,
  );
  if (idempotent) {
    if (idempotent.createdPage) await input.config.hydratePage(idempotent.pageId);
    return idempotent;
  }
  const binding = await input.config.repository.findLegacyRunbook(input.runbookId);
  if (!binding) throw new Error(`unbound legacy runbook not found: ${input.runbookId}`);
  if (input.existingPageId) {
    const document = await loadPageDocument(
      input.existingPageId,
      (pageId) => input.config.repository.readPageSnapshot(pageId),
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
    return await input.config.repository.bindLegacyPage({
      binding,
      pageId: input.existingPageId,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      operationId: input.createOperationId(),
    });
  }

  const pageId = input.createId();
  assertUuid(pageId);
  const pageApplication = input.mutationCore.createPage({
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
        input.createBlockId,
      ),
    },
  });
  const result = await input.config.repository.createLegacyPageAndBind({
    binding,
    pageId,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    operationId: input.createOperationId(),
    pageOperationId: input.createOperationId(),
    pageApplication,
  });
  await input.config.hydratePage(pageId);
  notifyPageUpdates([result], input.config.onPageUpdated);
  return result;
}

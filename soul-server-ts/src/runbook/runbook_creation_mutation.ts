import type { RunbookMutationCore } from "./runbook_mutation_core.js";
import type { RunbookRepository } from "./runbook_repository.js";
import type {
  RunbookActorParams,
  RunbookMutationResult,
} from "./runbook_service_models.js";

interface RunbookCreationMutationParams {
  actorKind?: RunbookActorParams["actorKind"];
  actorSessionId: string | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  runbookId: string;
  boardItemId: string;
  folderId: string;
  title: string;
  x: number;
  y: number;
}

export async function mutateRunbookCreation(
  core: RunbookMutationCore,
  repo: RunbookRepository,
  params: RunbookCreationMutationParams,
): Promise<RunbookMutationResult> {
  const payload = {
    board_item_id: params.boardItemId,
    folder_id: params.folderId,
    title: params.title,
    x: params.x,
    y: params.y,
  };
  if (params.actorSessionId === null) {
    return await core.mutateWithoutSession({
      runbookId: params.runbookId,
      targetKind: "runbook",
      targetId: params.runbookId,
      operationType: "create_runbook",
      actor: {
        actorKind: params.actorKind === "system" ? "system" : "user",
        actorSessionId: null,
        actorUserId: params.actorUserId,
      },
      idempotencyKey: params.idempotencyKey,
      payload,
      apply: async (sql) => {
        await repo.createRunbookTx(sql, {
          id: params.runbookId,
          boardItemId: params.boardItemId,
          title: params.title,
          createdSessionId: null,
          createdEventId: null,
        });
      },
    });
  }
  return await core.mutate({
    runbookId: params.runbookId,
    targetKind: "runbook",
    targetId: params.runbookId,
    operationType: "create_runbook",
    actor: {
      actorKind: params.actorKind,
      actorSessionId: params.actorSessionId,
      actorUserId: params.actorUserId,
    },
    idempotencyKey: params.idempotencyKey,
    payload,
    apply: async (sql, eventId) => {
      await repo.createRunbookTx(sql, {
        id: params.runbookId,
        boardItemId: params.boardItemId,
        title: params.title,
        createdSessionId: params.actorSessionId,
        createdEventId: eventId,
      });
    },
  });
}

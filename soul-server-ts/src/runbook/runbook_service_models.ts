import type { AppendEventParams } from "../db/session_db.js";
import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import type {
  RunbookOperationActorKind,
  RunbookOperationRow,
  RunbookSnapshot,
} from "../db/session_db_types.js";

import type { RunbookRepository } from "./runbook_repository.js";

export interface RunbookDbPort {
  runbooks(): RunbookRepository;
  appendEventTx(sql: RepositorySql, params: AppendEventParams): Promise<number>;
  getCatalog(): Promise<unknown>;
}

export interface RunbookBroadcasterPort {
  emitRunbookUpdated(
    agentSessionId: string,
    runbookId: string,
    boardItemId: string,
  ): Promise<void>;
  emitCatalogUpdated?(catalog: unknown): Promise<void>;
}

export interface RunbookMutationResult {
  snapshot: RunbookSnapshot;
  operation: RunbookOperationRow;
  eventId: number;
  idempotent?: boolean;
}

export interface RunbookActorParams {
  actorKind?: RunbookOperationActorKind;
  actorSessionId: string;
  actorUserId?: string | null;
}

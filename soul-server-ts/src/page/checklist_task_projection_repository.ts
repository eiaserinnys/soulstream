export type ChecklistProjectionActorKind = "agent" | "user" | "system" | "llm";

export interface ChecklistProjectionOutboxRow {
  block_id: string;
  page_id: string;
  source_hash: string;
  actor_kind: ChecklistProjectionActorKind;
  actor_session_id: string | null;
  actor_user_id: string | null;
  routing_session_id: string;
  attempts: number;
}

/** Worker contract for the orchestrator-owned durable checklist projection lease. */
export interface ChecklistTaskProjectionRepository {
  claimDue(
    nodeId: string,
    limit?: number,
    leaseMs?: number,
  ): Promise<ChecklistProjectionOutboxRow[]>;
  markSuccess(row: ChecklistProjectionOutboxRow, nodeId: string): Promise<boolean>;
  markFailure(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
    error: string,
  ): Promise<void>;
}

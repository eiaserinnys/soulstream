import type { FolderOperationActorKind } from "@soulstream/mcp-contract";
import { asRecord } from "@soulstream/wire-schema/json-record";
import type {
  CardAssigneeFields,
  FolderOperationRow,
  FolderOperationTargetKind,
} from "./card_types.js";

export class CardVersionConflict extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly targetKind: FolderOperationTargetKind,
    public readonly targetId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
    cardNumber?: number | null,
  ) {
    super(
      targetKind === "card"
        ? `카드 ${cardNumber == null ? targetId : `#${cardNumber}`}의 판이 바뀌었습니다(읽은 판 ${expectedVersion}, 지금 판 ${actualVersion}). get_card로 다시 읽고 새 version으로 다시 부르세요.`
        : `folder ${targetKind} version conflict: ${targetId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "CardVersionConflict";
  }
}

export interface CardAssigneeInput {
  kind: CardAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}

export interface AppendFolderOperationTxParams {
  id: string;
  folderId: string;
  targetKind: FolderOperationTargetKind;
  targetId: string;
  operationType: string;
  actorKind: FolderOperationActorKind;
  actorSessionId?: string | null;
  actorEventId: number | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  reason?: string | null;
}

export function assigneeToFields(
  assignee?: CardAssigneeInput | null,
): CardAssigneeFields {
  if (!assignee?.kind) {
    return {
      assignee_kind: null,
      assignee_agent_id: null,
      assignee_session_id: null,
      assignee_user_id: null,
    };
  }
  return {
    assignee_kind: assignee.kind,
    assignee_agent_id: assignee.kind === "agent" ? assignee.agentId ?? null : null,
    assignee_session_id: assignee.kind === "session" ? assignee.sessionId ?? null : null,
    assignee_user_id: assignee.kind === "human" ? assignee.userId ?? null : null,
  };
}

export function cleanPatch<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}

export function normalizeOperation(row: FolderOperationRow): FolderOperationRow {
  return { ...row, payload_json: asRecord(row.payload_json) ?? {} };
}

export function requireOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${op} returned no rows`);
  return row;
}

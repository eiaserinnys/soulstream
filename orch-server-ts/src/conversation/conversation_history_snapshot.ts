import type { FastifyRequest } from "fastify";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { ConversationProjection, type Item, type ProjectionState } from "./conversation_projection.js";
import { CONVERSATION_HISTORY_PROJECTION_VERSION } from "./conversation_history_source.js";

export type CachedItem = { eventId: number; item: Item };
type StoredSnapshot = { last_event_id: number; state: unknown; items: unknown };
type Snapshot = { lastEventId: number; state: ProjectionState; items: CachedItem[] };

export class ConversationHistorySnapshotStore {
  constructor(private readonly sql: SqlClient, private readonly logger: Pick<FastifyRequest["log"], "warn">) {}

  async read(session: string, firstInputIsInitial: boolean, max: number) {
    let row: StoredSnapshot | undefined;
    try {
      [row] = await this.sql<StoredSnapshot[]>`SELECT last_event_id,state,items FROM conversation_history_snapshots
        WHERE session_id=${session} AND first_input_is_initial_instruction=${firstInputIsInitial}
          AND projection_version=${CONVERSATION_HISTORY_PROJECTION_VERSION}`;
    } catch (error) {
      this.logger.warn({ err: error, session }, "대화 기록 보존본 읽기 실패");
      return undefined;
    }
    if (!row) return undefined;
    if (!Number.isInteger(row.last_event_id) || row.last_event_id < 0 || row.last_event_id > max || !validState(row.state) || !validItems(row.items)) {
      try {
        await this.sql`DELETE FROM conversation_history_snapshots WHERE session_id=${session} AND first_input_is_initial_instruction=${firstInputIsInitial}`;
      } catch (error) {
        this.logger.warn({ err: error, session }, "대화 기록 보존본 삭제 실패");
      }
      return undefined;
    }
    return { projection: ConversationProjection.restore(firstInputIsInitial, row.state), lastEventId: row.last_event_id, items: row.items };
  }

  async write(session: string, firstInputIsInitial: boolean, snapshot: Snapshot): Promise<boolean> {
    try {
      await this.sql`INSERT INTO conversation_history_snapshots
        (session_id, first_input_is_initial_instruction, projection_version, last_event_id, state, items)
        VALUES (${session}, ${firstInputIsInitial}, ${CONVERSATION_HISTORY_PROJECTION_VERSION}, ${snapshot.lastEventId},
          ${this.sql.json(snapshot.state as never)}, ${this.sql.json(snapshot.items as never)})
        ON CONFLICT (session_id, first_input_is_initial_instruction) DO UPDATE SET
          projection_version=EXCLUDED.projection_version, last_event_id=EXCLUDED.last_event_id,
          state=EXCLUDED.state, items=EXCLUDED.items, updated_at=now()
        WHERE conversation_history_snapshots.projection_version <> EXCLUDED.projection_version
          OR conversation_history_snapshots.last_event_id < EXCLUDED.last_event_id`;
      return true;
    } catch (error) {
      this.logger.warn({ err: error, session }, "대화 기록 보존본 쓰기 실패");
      return false;
    }
  }
}

function validState(value: unknown): value is ProjectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return ["firstUserMessageSeen", "keepalive", "suppressed", "visibleInputInTurn", "busy", "errorInTurn"].every(key => typeof state[key] === "boolean")
    && ["hiddenInputs", "turnHiddenInputs"].every(key => Array.isArray(state[key]) && (state[key] as unknown[]).every(id => typeof id === "string"))
    && ["tool", "streamId"].every(key => state[key] === null || typeof state[key] === "string")
    && typeof state.streamText === "string";
}
function validItems(value: unknown): value is CachedItem[] {
  return Array.isArray(value) && value.every(entry => {
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.eventId) || !entry.item || typeof entry.item !== "object") return false;
    const item = entry.item;
    return typeof item.id === "string" && ["user", "assistant", "error", "notice"].includes(item.kind)
      && typeof item.text === "string" && typeof item.at === "string" && Array.isArray(item.attachments)
      && item.attachments.every((attachment: unknown) => attachment && typeof attachment === "object"
        && typeof (attachment as Item["attachments"][number]).id === "string"
        && typeof (attachment as Item["attachments"][number]).name === "string"
        && typeof (attachment as Item["attachments"][number]).mime === "string");
  });
}

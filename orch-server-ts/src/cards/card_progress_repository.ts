import { asRecord } from "@soulstream/wire-schema/json-record";
import { reconstructTurnFromEvents, TURN_EVENT_TYPES, type TurnSummaryEventRow } from "../turn-summary/turn_summary_repository.js";
import type { RepositorySql } from "./control_plane/card_types.js";
import { projectCardProgress, type CardProgressMilestone, type CardProgressRecord, type CardProgressTurn } from "./card_progress_projection.js";

export async function readCardProgress(sql: RepositorySql, cardId: string) {
  const [sessionRows, milestoneRows, recordRows] = await Promise.all([
    sql<{ session_id: string }[]>`SELECT assignee_session_id AS session_id FROM cards
      WHERE id=${cardId} AND assignee_session_id IS NOT NULL
      UNION
      SELECT actor_session_id AS session_id FROM folder_operations
      WHERE target_kind='card' AND target_id=${cardId} AND actor_session_id IS NOT NULL
        AND operation_type IN ('update_card_now','request_card_review','report_card_item')
      ORDER BY session_id`,
    sql<{ id: string; created_at: Date; payload_json: Record<string, unknown> }[]>`
      SELECT id,created_at,payload_json FROM folder_operations
      WHERE target_kind='card' AND target_id=${cardId} AND operation_type='update_card_now'
      ORDER BY created_at,id`,
    sql<{ session_id: string; at: Date }[]>`
      SELECT session_id,created_at AS at FROM card_comments
      WHERE card_id=${cardId} AND author_kind='agent' AND kind<>'note' AND session_id IS NOT NULL
      UNION ALL
      SELECT session_id,asked_at AS at FROM card_questions WHERE card_id=${cardId} AND session_id IS NOT NULL`,
  ]);
  const sessionIds = sessionRows.map(row => row.session_id);
  const milestones: CardProgressMilestone[] = milestoneRows.map(row => ({
    id: row.id, at: row.created_at.toISOString(), text: row.payload_json.text,
    ask: row.payload_json.ask ?? null, turn: row.payload_json.turn ?? null,
  }));
  const recorded: CardProgressRecord[] = recordRows.map(row => ({ sessionId: row.session_id, at: row.at.toISOString() }));
  const turns = sessionIds.length ? await readTurns(sql, sessionIds) : [];
  return projectCardProgress({ cardId, sessionIds, turns, milestones, recorded });
}

async function readTurns(sql: RepositorySql, sessionIds: string[]): Promise<CardProgressTurn[]> {
  const rows = await sql<{ session_id: string; id: number; event_type: string; payload: unknown; created_at: Date; selected: boolean }[]>`
    WITH selected AS MATERIALIZED (
      SELECT s.session_id,e.id,e.created_at FROM unnest(${sql.array(sessionIds)}::text[]) AS s(session_id)
      CROSS JOIN LATERAL (
        SELECT id,created_at FROM events WHERE session_id=s.session_id AND event_type='complete'
        ORDER BY id DESC LIMIT 300
      ) e
      ORDER BY e.created_at DESC,s.session_id,e.id DESC LIMIT 300
    ), bounds AS (
      SELECT session_id,MIN(id) AS first_id,MAX(id) AS last_id FROM selected GROUP BY session_id
    )
    SELECT e.session_id,e.id,e.event_type,e.payload,e.created_at,(selected.id IS NOT NULL) AS selected
    FROM bounds b
    JOIN events e ON e.session_id=b.session_id AND e.id<=b.last_id AND e.id>=COALESCE((
      SELECT MAX(previous.id) FROM events previous WHERE previous.session_id=b.session_id
        AND previous.event_type='complete' AND previous.id<b.first_id
    ),0)
    LEFT JOIN selected ON selected.session_id=e.session_id AND selected.id=e.id
    WHERE e.event_type=ANY(${sql.array(TURN_EVENT_TYPES)}::text[])
    ORDER BY e.session_id,e.id`;
  const bySession = new Map<string, Array<TurnSummaryEventRow & { selected: boolean }>>();
  for (const row of rows) {
    const events = bySession.get(row.session_id) ?? [];
    events.push({ id: row.id, eventType: row.event_type, payload: asRecord(row.payload) ?? {}, createdAt: row.created_at, selected: row.selected });
    bySession.set(row.session_id, events);
  }
  const turns: CardProgressTurn[] = [];
  for (const [sessionId, events] of bySession) {
    for (const complete of events.filter(event => event.selected)) {
      const turn = reconstructTurnFromEvents(events, complete.id);
      if (!turn) continue;
      const start = events.find(event => event.id === turn.turnStartEventId)!;
      const response = events.find(event => event.id === turn.finalResponseEventId)!;
      turns.push({ sessionId, eventId: complete.id, startedAt: start.createdAt.toISOString(), at: complete.createdAt.toISOString(),
        text: response.payload.content as string, callerInfo: asRecord(start.payload.caller_info ?? start.payload.callerInfo) ?? {} });
    }
  }
  return turns;
}

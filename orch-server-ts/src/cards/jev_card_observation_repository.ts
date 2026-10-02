import type { LiveDbSqlResolver, LivePostgresSql } from '../runtime/live_db_sql.js';
import type { RepositorySql } from './control_plane/card_types.js';
import { readAssignedCardContext } from './assigned_card_context.js';
import type { TurnSummaryCompleteJob } from '../turn-summary/turn_summary_pipeline.js';
import type { CardObservationJob, CardObservationRepository } from './jev_card_observation_pipeline.js';
import { buildObservationInput, selectObservationCards, type ObservationCard, type ObservationInput,
  type ObservationOutcome, type PreparedCardSnapshot } from './jev_card_observation.js';
import { observationPayload } from './jev_card_observation_caption.js';
const HISTORY_LIMIT = 200;
const CAP = 12;
export class JevCardObservationDbRepository implements CardObservationRepository {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}
  async load(complete: TurnSummaryCompleteJob) {
    const sql = await this.sqlResolver.resolveSql();
    const boundaries = await sql`
      SELECT e.id,e.created_at,
        (SELECT COALESCE(MAX(p.id),0) FROM events p WHERE p.session_id=e.session_id AND p.event_type='complete' AND p.id<e.id) AS previous_id,
        (SELECT MAX(a.id) FROM events a WHERE a.session_id=e.session_id AND a.event_type='assistant_message' AND a.id<e.id) AS final_id
      FROM events e WHERE e.session_id=${complete.sessionId} AND e.id=${complete.completeEventId} AND e.event_type='complete'
    `;
    const boundary = boundaries[0];
    if (!boundary || !boundary.final_id || Number(boundary.final_id) <= Number(boundary.previous_id)) return null;
    const previousId = Number(boundary.previous_id);
    const inputEvents = await sql`
      SELECT id,event_type,payload,COUNT(*) OVER ()::int AS total FROM events WHERE session_id=${complete.sessionId}
        AND id>${previousId} AND id<=${complete.completeEventId}
        AND event_type IN ('user_message','intervention_sent','session_notification','debug','folder_operation')
      ORDER BY id ASC LIMIT 100
    `;
    const inputIds = new Set(inputEvents.filter(e => e.event_type !== 'debug' && e.event_type !== 'folder_operation')
      .flatMap(e => { const p = object(e.payload); return [p.input_uuid,p.delivery_id].filter((v): v is string => typeof v === 'string'); }));
    const snapshots: PreparedCardSnapshot[] = [];
    const operationIds: string[] = [];
    for (const row of inputEvents) {
      const p = object(row.payload);
      if (row.event_type === 'folder_operation' && p.target_kind === 'card' && typeof p.target_id === 'string') operationIds.push(p.target_id);
      if (row.event_type !== 'debug' || p.kind !== 'assigned_card_context_snapshot') continue;
      const capture = object(p.capture);
      const snapshot = object(capture.snapshot);
      // Prepared input is not consumed input. Match only known input identity; never infer a turn from timestamps.
      if (typeof capture.inputId !== 'string' || !inputIds.has(capture.inputId) || capture.sessionId !== complete.sessionId) continue;
      if (!Array.isArray(snapshot.cards)) continue;
      snapshots.push({ eventId: Number(row.id), source: 'prepared_model_input', capturedAt: String(snapshot.capturedAt ?? ''),
        registrationId: nullableString(capture.registrationId), executionCommandId: nullableString(capture.executionCommandId),
        inputId: capture.inputId, total: Number(snapshot.total ?? 0), cards: snapshot.cards.slice(0,CAP) as PreparedCardSnapshot['cards'] });
    }
    const end = await readAssignedCardContext(sql as unknown as RepositorySql, complete.sessionId);
    const selected = selectObservationCards({ startIds: snapshots.flatMap(s => s.cards.map(c => c.id)), endIds: end.cards.map(c => c.id), operationIds, limit: CAP });
    if (!selected.ids.length) return null;
    // Bound BEFORE fetching details; allow former ownership only when preserved in this session's observations/operations.
    const details = await sql`
      SELECT c.id,LEFT(c.title,160) AS title,c.status,c.version,LEFT(c.request,801) AS request,LEFT(c.brief,801) AS brief,
        c.updated_at,c.assignee_session_id,c.updated_session_id,c.updated_event_id,
        COALESCE((SELECT LEFT(cc.body,801) FROM card_comments cc WHERE cc.card_id=c.id
          AND cc.created_at<=${boundary.created_at} ORDER BY cc.created_at DESC,cc.id DESC LIMIT 1),'') AS instruction,
        COALESCE((SELECT LEFT(cr.body,801) FROM card_reports cr WHERE cr.card_id=c.id
          AND cr.created_at<=${boundary.created_at} ORDER BY cr.created_at DESC,cr.id DESC LIMIT 1),'') AS report
      FROM cards c WHERE c.id=ANY(${selected.ids}::text[]) AND c.archived=FALSE
        AND (c.assignee_session_id=${complete.sessionId} OR c.id=ANY(${snapshots.flatMap(s=>s.cards.map(c=>c.id))}::text[])
          )
      ORDER BY c.id COLLATE "C" LIMIT ${CAP}
    `;
    const cards: ObservationCard[] = details.map(r => ({ id: String(r.id), title: String(r.title), status: String(r.status), version: Number(r.version),
      request: String(r.request ?? ''), brief: String(r.brief ?? ''), instruction: String(r.instruction ?? ''), report: String(r.report ?? '') }));
    const rows = await sql`
      SELECT id,event_type,CASE WHEN event_type='assistant_message' THEN payload->>'content' ELSE payload->>'text' END AS text,
        COUNT(*) OVER ()::int AS total
      FROM events WHERE session_id=${complete.sessionId} AND id<=${complete.completeEventId}
        AND event_type IN ('user_message','intervention_sent','session_notification','assistant_message')
      ORDER BY id DESC LIMIT ${HISTORY_LIMIT}
    `;
    const summaryRows = await sql`
      SELECT id,payload->>'content' AS text,(payload->>'final_response_event_id')::int AS through_id
      FROM events WHERE session_id=${complete.sessionId} AND event_type='turn_summary'
        AND id<=${complete.completeEventId} AND (payload->>'final_response_event_id')::int<=${complete.completeEventId}
      ORDER BY id DESC LIMIT 6
    `;
    const total = Math.max(selected.total, end.total, ...snapshots.map(s=>s.total));
    const input = buildObservationInput({ completeEventId: complete.completeEventId, cards,
      history: [...rows].reverse().map(r=>({ id:Number(r.id), type:String(r.event_type), text:String(r.text ?? '') })),
      summaries: [...summaryRows].reverse().map(r=>({ id:Number(r.id), throughEventId:Number(r.through_id), text:String(r.text ?? '') })),
      startObservations: snapshots, totalCards: total });
    input.scope.omittedHistoryEvents += Math.max(0, Number(rows[0]?.total ?? 0)-rows.length);
    input.scope.truncated ||= input.scope.omittedHistoryEvents > 0;
    input.scope.completeCreatedAt = new Date(String(boundary.created_at)).toISOString();
    input.scope.turnLinkage = 'canonical_complete_event_interval';
    input.scope.omittedTurnEvidenceEvents = Math.max(0,Number(inputEvents[0]?.total ?? 0)-inputEvents.length);
    input.scope.endCapturedAt = end.capturedAt;
    input.scope.detailOrdering = 'timestamp_filter_only_unverified';
    input.scope.cardCounts = {representedUnion:selected.total,endTotal:end.total,preparedTotals:snapshots.map(s=>s.total),
      totalIsLowerBound:end.omitted>0 || snapshots.some(s=>s.total>s.cards.length)};
    input.scope.cardProvenance = details.map(r=>({id:String(r.id),version:Number(r.version),updatedAt:String(r.updated_at),
      updatedSessionId:nullableString(r.updated_session_id),updatedEventId:r.updated_event_id ? Number(r.updated_event_id) : null}));
    const job: CardObservationJob = { ...complete, previousCompleteEventId: previousId, finalResponseEventId: Number(boundary.final_id), capturedAt: new Date().toISOString() };
    return { job, input };
  }
  async claim(job: CardObservationJob, input: ObservationInput) {
    const sql = await this.sqlResolver.resolveSql();
    if (!sql.begin) throw new Error('observation storage requires transaction support');
    return sql.begin(async tx => {
      const key = `jev_card_observation:${job.completeEventId}:reserved`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${job.sessionId + key},0))`;
      const existing = await tx`SELECT id FROM events WHERE session_id=${job.sessionId} AND dedupe_key=${key} LIMIT 1`;
      if (existing.length) return false;
      const payload = observationPayload(job,input,{ status:'not_evaluated', calls:0, latencyMs:0, inputBytes:0, cards:[] },'reserved');
      payload.content = 'Jev · 미평가 — 평가 요청 기록만 있고 결과는 아직 없음';
      await append(tx,job.sessionId,key,payload);
      return true;
    });
  }
  async append(job: CardObservationJob, input: ObservationInput, outcome: ObservationOutcome) {
    const sql = await this.sqlResolver.resolveSql();
    const payload = observationPayload(job,input,outcome);
    return { eventId: await append(sql,job.sessionId,`jev_card_observation:${job.completeEventId}:result`,payload), payload: { ...payload } };
  }
}
async function append(sql: LivePostgresSql, sessionId: string, key: string, payload: unknown) {
  const rows = await sql`SELECT event_append(${sessionId},'debug',${JSON.stringify(payload)},'',${new Date()},${key}) AS event_id`;
  if (!rows[0]?.event_id) throw new Error('debug observation append returned no event');
  return Number(rows[0].event_id);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function nullableString(value: unknown) { return typeof value === 'string' ? value : null; }

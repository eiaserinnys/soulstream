import { ACTIVE_SESSION_STATUSES, cardCapacitySessions } from "./card_capacity.js";
import { endedCardWork } from "./card_work_lifecycle.js";
import type { CardOwnerSession } from "./card_session_target.js";
import type { CardRow, SqlClient } from "./control_plane/card_types.js";
import { readCardDispatchSettings } from "./card_dispatch_settings.js";
import { readCardReminderFacts } from "./card_status_reminder_repository.js";
import { readCardBoardSessions } from "../session/persistent_report_service.js";
import { dependentCards, readCardDependencies } from "./card_dependencies.js";
export type DispatchCard = CardRow & {
    folder_name: string;
};
export type CardSession = {
    session_id: string;
    card_id: string;
    node_id: string;
    status: string;
    model_preset: string | null;
    termination_reason: string | null;
    termination_detail?: string | null;
    termination_event_id: number | null;
    /** 일반 세션 모델 대체 pending 판정에 쓴다. */
    metadata?: unknown;
};
export class CardDispatchRepository {
    constructor(private readonly resolveSql: () => Promise<SqlClient>) { }
    async reminderFacts(now: number, endedRootId?: string) { return readCardReminderFacts(await this.resolveSql(), now, endedRootId); }
    async boardSessions(cardId: string) { return readCardBoardSessions(await this.resolveSql(), cardId); }
    async settings() { return readCardDispatchSettings(await this.resolveSql()); }
    async queued(): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        const cards = await sql<DispatchCard[]> `SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='queued' AND NOT c.archived AND NOT f.archived ORDER BY c.queue_position_key COLLATE "C",c.id`;
        const dependencies = await readCardDependencies(sql,cards.map(card => card.id));
        return cards.filter(card => (dependencies.get(card.id) ?? []).every(dependency => dependency.met));
    }
    async dependencies(cardId: string) { return (await readCardDependencies(await this.resolveSql(),[cardId])).get(cardId) ?? []; }
    async dependents(cardId: string) { return dependentCards(await this.resolveSql(),cardId); }
    async limited(): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        return sql<DispatchCard[]> `SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='blocked' AND c.blocked_kind='limit' AND NOT c.archived AND NOT f.archived
      ORDER BY c.queue_position_key COLLATE "C" NULLS LAST,c.id`;
    }
    /** 검증 대기 시각이 지난 카드. 보관 폴더 제외는 계약에 없으므로 상태와 카드 보관만 본다. */
    async awaitingVerification(now: Date): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        return sql<DispatchCard[]> `SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='awaiting_verification' AND NOT c.archived AND c.wake_at<=${now}
      ORDER BY c.wake_at,c.id`;
    }
    async running(): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        return sql<DispatchCard[]> `SELECT DISTINCT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      LEFT JOIN sessions s ON s.card_id=c.id WHERE (c.status='running' OR s.status NOT IN ('completed','error','interrupted')) AND NOT c.archived AND NOT f.archived`;
    }
    async occupancy(): Promise<Record<string, number>> {
        const sql = await this.resolveSql();
        // Disabled-policy legacy fixtures do not need the orchestration ledger.
        const enabled=(await sql`SELECT (value->>'enabled')::boolean AS enabled FROM system_settings WHERE setting_key='card_orchestration'`)[0]?.enabled===true;
        if (enabled) {
          const rows=await cardCapacitySessions(sql), result:Record<string,number>={};
          for (const row of rows) result[row.node_id]=(result[row.node_id]??0)+1;
          return result;
        }
        // Dispatch provenance uses the existing immutable operation ledger. Manually created sessions have no marker.
        // 활성 카드·세션에서 시작해 idx_folder_ops_target으로 원장을 찾고, 세션은 LATERAL로 한 줄씩 본다.
        // OFFSET 0은 플래너가 sessions 전체를 해시에 올리는 Hash Left Join으로 돌아가는 것을 막는다(그러면 순차 스캔이 남는다).
        const rows = await sql<{
            node_id: string;
            count: number;
        }[]> `WITH act AS (
          SELECT id AS card_id FROM cards WHERE status='running'
          UNION SELECT card_id FROM sessions WHERE card_id IS NOT NULL
            AND status = ANY(${sql.array(ACTIVE_SESSION_STATUSES)}::text[])
        )
        SELECT op.payload_json->>'node_id' AS node_id,count(*)::int AS count
      FROM act JOIN folder_operations op ON op.target_kind='card' AND op.target_id=act.card_id
        AND op.operation_type='dispatch_card'
      JOIN cards c ON c.id=op.target_id
      LEFT JOIN LATERAL (SELECT s0.session_id,s0.status,s0.updated_at FROM sessions s0
        WHERE s0.session_id=op.payload_json->>'session_id' AND s0.card_id=c.id OFFSET 0) s ON true
      WHERE (
        s.status NOT IN ('completed','error','interrupted') OR s.session_id IS NULL AND c.status='running'
          AND op.id=(SELECT latest.id FROM folder_operations latest WHERE latest.target_id=c.id
            AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
        OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id
          AND r.operation_type='resume_card' AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
      GROUP BY op.payload_json->>'node_id'`;
        return Object.fromEntries(rows.map(row => [row.node_id, row.count]));
    }
    async ownerSession(id:string):Promise<(CardOwnerSession & Pick<CardSession,"termination_reason" | "termination_event_id">) | null> {
        return (await (await this.resolveSql())<(CardOwnerSession & Pick<CardSession,"termination_reason" | "termination_event_id">)[]>`SELECT session_id,node_id,agent_id,model_preset,status,metadata,termination_reason,termination_event_id FROM sessions WHERE session_id=${id}`)[0]??null;
    }
    async hasPendingExecution(cardId: string) {
        return (await (await this.resolveSql())`SELECT id FROM card_execution_requests WHERE card_id=${cardId} AND state='pending' LIMIT 1`).length > 0;
    }
    async capacitySessionIds() { return new Set((await cardCapacitySessions(await this.resolveSql())).map(r=>r.session_id)); }
    async hasExplicitWork(cardId:string) {
      return (await (await this.resolveSql())`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='start_card_work' LIMIT 1`).length>0;
    }
    async endedWork(id:string) {
      const sql=await this.resolveSql();
      if (!(await sql`SELECT id FROM folder_operations WHERE operation_type='start_card_work' AND actor_session_id=${id} LIMIT 1`).length) return [];
      return endedCardWork(sql,id);
    }
    async session(sessionId: string): Promise<CardSession | null> {
        const sql = await this.resolveSql();
        return (await sql<CardSession[]> `SELECT session_id,card_id,node_id,status,model_preset,termination_reason,termination_event_id,metadata
      FROM sessions WHERE session_id=${sessionId} AND card_id IS NOT NULL`)[0] ?? null;
    }
    /** A manually assigned owner need not have sessions.card_id pointing at the card. */
    async assigneeErrorSession(sessionId: string): Promise<CardSession | null> {
        const sql = await this.resolveSql();
        return (await sql<CardSession[]>`SELECT s.session_id,c.id AS card_id,s.node_id,s.status,s.model_preset,
          s.termination_reason,s.termination_detail,s.termination_event_id,s.metadata
          FROM sessions s JOIN cards c ON c.assignee_session_id=s.session_id AND NOT c.archived
          WHERE s.session_id=${sessionId}`)[0] ?? null;
    }
    async latestSession(cardId: string): Promise<CardSession | null> {
        const sql = await this.resolveSql();
        return (await sql<CardSession[]> `SELECT session_id,card_id,node_id,status,model_preset,termination_reason,termination_event_id
      FROM sessions WHERE card_id=${cardId} ORDER BY created_at DESC,session_id DESC LIMIT 1`)[0] ?? null;
    }
    async latestDispatchedSessionId(cardId:string): Promise<string | null> {
        const sql = await this.resolveSql();
        const rows=await sql<{ session_id:string | null }[]>`SELECT payload_json->>'session_id' AS session_id FROM folder_operations
      WHERE target_kind='card' AND target_id=${cardId} AND operation_type='dispatch_card'
        AND NULLIF(payload_json->>'session_id','') IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`;
        return rows[0]?.session_id ?? null;
    }
    async cardCreatorActor(cardId:string): Promise<{actor_session_id:string|null;actor_user_id:string|null}|null> {
        const sql=await this.resolveSql();
        return (await sql<{actor_session_id:string|null;actor_user_id:string|null}[]>`SELECT actor_session_id,actor_user_id FROM folder_operations
      WHERE operation_type='create_card' AND target_kind='card' AND target_id=${cardId}
      ORDER BY created_at ASC,id ASC LIMIT 1`)[0]??null;
    }
    async cardExecutionActorUser(sessionId:string): Promise<string|null> {
        const sql=await this.resolveSql();
        const rows=await sql<{actor_user_id:string|null}[]>`SELECT actor_user_id FROM card_execution_requests
      WHERE session_id=${sessionId} AND actor_user_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`;
        return rows[0]?.actor_user_id??null;
    }
    async rejectionReason(cardId: string): Promise<string | null> {
        const sql = await this.resolveSql();
        const rows = await sql<{
            reason: string;
        }[]> `SELECT reason FROM folder_operations WHERE target_id=${cardId}
      AND operation_type='set_card_status' AND actor_kind='user' AND payload_json->>'status'='running' AND reason IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`;
        return rows[0]?.reason ?? null;
    }
}

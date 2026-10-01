import { cardCapacitySessions } from "./card_capacity.js";
import { endedCardWork } from "./card_work_lifecycle.js";
import type { CardOwnerSession } from "./card_session_target.js";
import type { CardRow, SqlClient } from "./control_plane/card_types.js";
import { readCardDispatchSettings } from "./card_dispatch_settings.js";
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
    termination_event_id: number | null;
};
export class CardDispatchRepository {
    constructor(private readonly resolveSql: () => Promise<SqlClient>) { }
    async settings() { return readCardDispatchSettings(await this.resolveSql()); }
    async queued(): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        return sql<DispatchCard[]> `SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='queued' AND NOT c.archived AND NOT f.archived ORDER BY c.queue_position_key COLLATE "C",c.id`;
    }
    async limited(): Promise<DispatchCard[]> {
        const sql = await this.resolveSql();
        return sql<DispatchCard[]> `SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='blocked' AND c.blocked_kind='limit' AND NOT c.archived AND NOT f.archived
      ORDER BY c.queue_position_key COLLATE "C" NULLS LAST,c.id`;
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
        const rows = await sql<{
            node_id: string;
            count: number;
        }[]> `SELECT op.payload_json->>'node_id' AS node_id,count(*)::int AS count
      FROM folder_operations op JOIN cards c ON c.id=op.target_id
      LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id' AND s.card_id=c.id
      WHERE op.operation_type='dispatch_card' AND (
        s.status NOT IN ('completed','error','interrupted') OR s.session_id IS NULL AND c.status='running'
          AND op.id=(SELECT latest.id FROM folder_operations latest WHERE latest.target_id=c.id
            AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
        OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id
          AND r.operation_type='resume_card' AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
      GROUP BY op.payload_json->>'node_id'`;
        return Object.fromEntries(rows.map(row => [row.node_id, row.count]));
    }
    async ownerSession(id:string):Promise<CardOwnerSession | null> {
        return (await (await this.resolveSql())<CardOwnerSession[]>`SELECT session_id,node_id,agent_id,model_preset,status,metadata FROM sessions WHERE session_id=${id}`)[0]??null;
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
        return (await sql<CardSession[]> `SELECT session_id,card_id,node_id,status,model_preset,termination_reason,termination_event_id
      FROM sessions WHERE session_id=${sessionId} AND card_id IS NOT NULL`)[0] ?? null;
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

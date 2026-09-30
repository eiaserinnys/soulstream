import type { CardRow, SqlClient } from "./control_plane/card_types.js";
import { readCardDispatchSettings } from "./card_dispatch_settings.js";

export type DispatchCard = CardRow & {folder_name:string};
export type CardSession = {session_id:string;card_id:string;node_id:string;status:string;model_preset:string|null;
  termination_reason:string|null;termination_event_id:number|null};

export class CardDispatchRepository {
  constructor(private readonly sql: SqlClient) {}
  settings() { return readCardDispatchSettings(this.sql); }
  async queued(): Promise<DispatchCard[]> {
    return this.sql<DispatchCard[]>`SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='queued' AND NOT c.archived AND NOT f.archived ORDER BY c.queue_position_key COLLATE "C",c.id`;
  }
  async limited(): Promise<DispatchCard[]> {
    return this.sql<DispatchCard[]>`SELECT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      WHERE c.status='blocked' AND c.blocked_kind='limit' AND NOT c.archived AND NOT f.archived
      ORDER BY c.queue_position_key COLLATE "C" NULLS LAST,c.id`;
  }
  async running(): Promise<DispatchCard[]> {
    return this.sql<DispatchCard[]>`SELECT DISTINCT c.*,f.name AS folder_name FROM cards c JOIN folders f ON f.id=c.folder_id
      JOIN sessions s ON s.card_id=c.id WHERE s.status NOT IN ('completed','error','interrupted') AND NOT c.archived AND NOT f.archived`;
  }
  async occupancy(): Promise<Record<string,number>> {
    // Dispatch provenance uses the existing immutable operation ledger. Manually created sessions have no marker.
    const rows=await this.sql<{node_id:string;count:number}[]>`SELECT op.payload_json->>'node_id' AS node_id,count(*)::int AS count
      FROM folder_operations op JOIN cards c ON c.id=op.target_id
      LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id' AND s.card_id=c.id
      WHERE op.operation_type='dispatch_card' AND (
        s.status NOT IN ('completed','error','interrupted') OR s.session_id IS NULL AND c.status='running'
        OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id
          AND r.operation_type='resume_card' AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
      GROUP BY op.payload_json->>'node_id'`;
    return Object.fromEntries(rows.map(row=>[row.node_id,row.count]));
  }
  async session(sessionId: string): Promise<CardSession|null> {
    return (await this.sql<CardSession[]>`SELECT session_id,card_id,node_id,status,model_preset,termination_reason,termination_event_id
      FROM sessions WHERE session_id=${sessionId} AND card_id IS NOT NULL`)[0] ?? null;
  }
  async latestSession(cardId: string): Promise<CardSession|null> {
    return (await this.sql<CardSession[]>`SELECT session_id,card_id,node_id,status,model_preset,termination_reason,termination_event_id
      FROM sessions WHERE card_id=${cardId} ORDER BY created_at DESC,session_id DESC LIMIT 1`)[0] ?? null;
  }
  async rejectionReason(cardId: string): Promise<string|null> {
    const rows=await this.sql<{reason:string}[]>`SELECT reason FROM folder_operations WHERE target_id=${cardId}
      AND operation_type='set_card_status' AND actor_kind='user' AND payload_json->>'status'='running' AND reason IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`;
    return rows[0]?.reason ?? null;
  }
}

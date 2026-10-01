import type { RepositorySql } from "./control_plane/card_types.js";
/** Admission reservations and dispatched executions share one session identity budget. */
export async function cardCapacitySessions(sql: RepositorySql) {
  return sql<{session_id:string;node_id:string}[]>`SELECT DISTINCT session_id,node_id FROM (
    SELECT op.payload_json->>'session_id' AS session_id,op.payload_json->>'node_id' AS node_id
    FROM folder_operations op JOIN cards c ON c.id=op.target_id
    LEFT JOIN sessions s ON s.session_id=op.payload_json->>'session_id'
    WHERE op.operation_type='dispatch_card' AND (s.status NOT IN ('completed','error','interrupted')
      OR s.session_id IS NULL AND c.status='running' AND op.id=(SELECT latest.id FROM folder_operations latest
        WHERE latest.target_id=c.id AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id AND r.operation_type='resume_card'
        AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
    UNION SELECT d.session_id,d.node_id FROM card_orchestration_dispatches d LEFT JOIN sessions s ON s.session_id=d.session_id
      WHERE d.state IN ('admitted','launching') OR d.state='running' AND s.status NOT IN ('completed','error','interrupted')
  ) occupied WHERE session_id IS NOT NULL AND node_id IS NOT NULL`;
}

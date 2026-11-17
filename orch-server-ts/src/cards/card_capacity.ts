import { SESSION_STATUSES } from "@soulstream/wire-schema";
import { isTerminalSessionStatus } from "../session/session_status.js";
import { SESSION_STATUS_LEAVES, type StoredSessionStatus } from "../session/state/session_state_value.js";
import type { RepositorySql } from "./control_plane/card_types.js";

/**
 * 점유 판정이 "아직 끝나지 않은 세션"으로 보는 상태(initializing, running, unknown).
 * 저장 상태 어휘(SESSION_STATUS_LEAVES)와 wire 상태 목록(SESSION_STATUSES)에서 "none"과
 * 종료 상태를 뺀 합집합이다. 손으로 나열하지 않고, 질의는 이 목록을 = ANY로 넘겨
 * idx_sessions_status를 탄다.
 */
export const ACTIVE_SESSION_STATUSES: readonly string[] = [
  ...new Set<string>([
    ...SESSION_STATUS_LEAVES.filter((status): status is StoredSessionStatus =>
      status !== "none" && !isTerminalSessionStatus(status)),
    ...SESSION_STATUSES.filter((status) => !isTerminalSessionStatus(status)),
  ]),
];
/** Admission reservations and dispatched executions share one session identity budget. */
export async function cardCapacitySessions(sql: RepositorySql) {
  // 활성 카드·세션에서 시작해 idx_folder_ops_target으로 원장을 찾고, 세션은 LATERAL로 한 줄씩 본다.
  // dispatch_card의 payload 세션은 recordDispatch가 이 카드로 새로 만들어 등록한 세션이라 card_id가 대상 카드와
  // 같다. 등록 전이거나 지워졌으면 세션 없음 분기가 받는다. 그래서 세션의 card_id로 원장을 찾아도 결과가 같다.
  // OFFSET 0은 플래너가 sessions 전체를 해시에 올리는 Hash Left Join으로 돌아가는 것을 막는다.
  return sql<{session_id:string;node_id:string}[]>`WITH act AS (
    SELECT id AS card_id FROM cards WHERE status='running'
    UNION SELECT card_id FROM sessions WHERE card_id IS NOT NULL
      AND status = ANY(${sql.array(ACTIVE_SESSION_STATUSES)}::text[])
  )
  SELECT DISTINCT session_id,node_id FROM (
    SELECT op.payload_json->>'session_id' AS session_id,op.payload_json->>'node_id' AS node_id
    FROM act JOIN folder_operations op ON op.target_kind='card' AND op.target_id=act.card_id
      AND op.operation_type='dispatch_card'
    JOIN cards c ON c.id=op.target_id
    LEFT JOIN LATERAL (SELECT s0.session_id,s0.status,s0.updated_at FROM sessions s0
      WHERE s0.session_id=op.payload_json->>'session_id' OFFSET 0) s ON true
    WHERE (s.status NOT IN ('completed','error','interrupted')
      OR s.session_id IS NULL AND c.status='running' AND op.id=(SELECT latest.id FROM folder_operations latest
        WHERE latest.target_id=c.id AND latest.operation_type='dispatch_card' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      OR c.status='running' AND EXISTS(SELECT 1 FROM folder_operations r WHERE r.target_id=c.id AND r.operation_type='resume_card'
        AND r.payload_json->>'session_id'=s.session_id AND r.created_at>s.updated_at))
    UNION SELECT d.session_id,d.node_id FROM card_orchestration_dispatches d LEFT JOIN sessions s ON s.session_id=d.session_id
      WHERE d.state IN ('admitted','launching') OR d.state='running' AND s.status NOT IN ('completed','error','interrupted')
  ) occupied WHERE session_id IS NOT NULL AND node_id IS NOT NULL`;
}

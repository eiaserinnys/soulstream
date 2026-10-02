import type { CardRow, RepositorySql } from "./control_plane/card_types.js";
export type CardWorkExecution = { registrationId: string; executionCommandId: string };
export function invalidWork(message: string) { return Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_WORK" }); }

/** Worker-supplied identity comes from Task.executionRegistration, never tool input. */
export async function validateWorkExecution(sql: RepositorySql, sessionId: string, execution: CardWorkExecution) {
  const rows = await sql`SELECT session_id FROM sessions WHERE session_id=${sessionId}
    AND execution_registration_id=${execution.registrationId} AND execution_command_id=${execution.executionCommandId}
    AND status NOT IN ('completed','error','interrupted')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(metadata,'[]'::jsonb)) m WHERE m->>'type'='card_orchestration_decision') FOR SHARE`;
  if (!rows.length) throw invalidWork("Current execution is missing, stale or orchestration purpose");
}

/** Only a correlated automatic execution consumes admission; manual work leaves dispatch alone. */
export async function acceptQueuedWork(sql: RepositorySql, card: CardRow, sessionId: string, execution: CardWorkExecution) {
  const active = await sql`SELECT * FROM card_orchestration_dispatches
    WHERE card_id=${card.id} AND session_id=${sessionId} AND state IN ('admitted','launching') FOR UPDATE`;
  const d = active[0];
  if (!d) return null;
  const input = d.input as Record<string, unknown>;
  if (input.deliveryId) {
    const receipts = await sql`SELECT delivery.target_receipt_id FROM session_deliveries delivery
      JOIN LATERAL (SELECT effect_application->'canonical_execution_registration' AS identity FROM event_ingress_receipts
        WHERE session_id=${sessionId} AND event_id<=CASE WHEN delivery.target_receipt_id ~ '^event:[0-9]+$' THEN substring(delivery.target_receipt_id FROM 7)::int ELSE -1 END
          AND effect_application->>'applied'='true' AND effect_application->'canonical_execution_registration' IS NOT NULL
          AND effect_application->'canonical_execution_registration'<>'null'::jsonb ORDER BY event_id DESC LIMIT 1) receipt ON TRUE
      WHERE delivery.delivery_id=${String(input.deliveryId)} AND delivery.target_session_id=${sessionId}
        AND delivery.state='consumed' AND receipt.identity->>'registration_id'=${execution.registrationId}
        AND receipt.identity->>'execution_command_id'=${execution.executionCommandId}`;
    if (!receipts.length) return null;
    input.consumedTurnId = receipts[0]!.target_receipt_id;
  } else {
    // A new UUID cannot refer to an earlier run. Its first committed registration must follow admission.
    const registrations = await sql`SELECT event_id FROM event_ingress_receipts WHERE session_id=${sessionId}
      AND effect_application->>'applied'='true' AND effect_application->'canonical_execution_registration'->>'registration_id'=${execution.registrationId}
      AND effect_application->'canonical_execution_registration'->>'execution_command_id'=${execution.executionCommandId}
      AND created_at>=${d.created_at as Date} LIMIT 1`;
    if (!registrations.length) return null;
  }
  // Receipt identity proves this is the automatic execution; only now apply its fences.
  const admitted = await sql`SELECT d.run_id
    FROM card_orchestration_dispatches d JOIN card_orchestration_runs r ON r.id=d.run_id
    JOIN system_settings p ON p.setting_key='card_orchestration'
    JOIN sessions worker ON worker.session_id=d.session_id AND worker.node_id=d.node_id
      AND worker.agent_id=d.input->>'agentId' AND worker.model_preset IS NOT DISTINCT FROM d.input->>'modelPreset'
    WHERE d.run_id=${String(d.run_id)} AND d.card_id=${card.id} AND d.session_id=${sessionId} AND d.state='launching' AND d.launch_accepted
      AND (p.value->>'enabled')::boolean AND p.version=r.policy_version
      AND (d.input->>'admittedCardVersion')::int=${card.version}`;
  if (!admitted.length || (card.assignee_kind === "session" ? card.assignee_session_id !== sessionId : card.assignee_kind !== "agent" || card.assignee_agent_id !== input.agentId))
    throw invalidWork("Automatic work requires a valid fenced admission for its assignee");
  await sql`UPDATE card_orchestration_dispatches SET state='running',input=${sql.json({...input,execution})},updated_at=NOW()
    WHERE run_id=${String(d.run_id)} AND card_id=${card.id}`;
  return String(d.run_id);
}

/** Receipt ranges retain execution identity after sessions clears its live registration at terminal. */
export async function endedCardWork(sql: RepositorySql, sessionId: string) {
  return sql<{card_id:string;registration_id:string;terminal_event_id:number;terminal_session:Record<string,unknown>}[]>`
    SELECT work.target_id AS card_id,work.payload_json->'execution'->>'registrationId' AS registration_id,
      terminal.event_id AS terminal_event_id,terminal.projection AS terminal_session
    FROM folder_operations work JOIN cards card ON card.id=work.target_id
    JOIN LATERAL (SELECT event_id FROM event_ingress_receipts WHERE session_id=${sessionId} AND effect_application->>'applied'='true'
      AND effect_application->'canonical_execution_registration'->>'registration_id'=work.payload_json->'execution'->>'registrationId'
      AND effect_application->'canonical_execution_registration'->>'execution_command_id'=work.payload_json->'execution'->>'executionCommandId'
      ORDER BY event_id LIMIT 1) registration ON TRUE
    JOIN LATERAL (SELECT event_id,effect_application->'canonical_session' AS projection FROM event_ingress_receipts WHERE session_id=${sessionId} AND event_id>registration.event_id
      AND effect_application->>'applied'='true' AND effect_application->'canonical_session'->>'status' IN ('completed','error','interrupted')
      AND NOT EXISTS(SELECT 1 FROM event_ingress_receipts newer WHERE newer.session_id=${sessionId}
        AND newer.event_id>registration.event_id AND newer.event_id<event_ingress_receipts.event_id
        AND newer.effect_application->>'applied'='true' AND newer.effect_application->'canonical_execution_registration'->>'registration_id' IS NOT NULL
        AND newer.effect_application->'canonical_execution_registration'->>'registration_id'<>work.payload_json->'execution'->>'registrationId')
      ORDER BY event_id LIMIT 1) terminal ON TRUE
    WHERE work.operation_type='start_card_work' AND work.actor_session_id=${sessionId} AND card.status='running'
      AND card.assignee_session_id=${sessionId} AND NOT card.archived
      AND work.id=(SELECT latest.id FROM folder_operations latest WHERE latest.target_id=card.id AND latest.operation_type='start_card_work' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)`;
}

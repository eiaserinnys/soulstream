import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FolderDbPort } from "../src/cards/control_plane/card_types.js";
import type { CardWorkExecution } from "../src/cards/card_work_lifecycle.js";
import type { EventSessionEffectApplicationWire } from "../src/node/event_ingress_contract.js";
import type { PagePostgresHarness } from "./page/page_postgres_harness.js";

// Same event_append implementation/port as card-dispatch.postgres.test.ts.
// Both cards and folder_operations retain their real session/event foreign keys.
export const appendCardEventTx: FolderDbPort["appendEventTx"] = async (tx,p) => {
  const rows=await tx<{id:number}[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
  return rows[0]!.id;
};

export async function prepareCardWorkSchema(h:PagePostgresHarness) {
  // These fields match schema.sql sessions: nullable, with no defaults.
  await h.sql`ALTER TABLE sessions ADD COLUMN execution_registration_id TEXT, ADD COLUMN execution_command_id TEXT,
    ADD COLUMN metadata JSONB, ADD COLUMN model_preset TEXT, ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
  const schema=await readFile(new URL("../../packages/db-schema/sql/schema.sql",import.meta.url),"utf8");
  for (const table of ["session_deliveries","event_ingress_receipts"]) {
    const ddl=schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!ddl) throw new Error(`Actual schema is missing ${table}`);
    await h.sql.unsafe(ddl);
  }
  const projection=schema.match(/ALTER TABLE session_deliveries\n    ADD COLUMN IF NOT EXISTS aggregate_state[\s\S]*?;/)?.[0];
  if (!projection) throw new Error("Actual delivery receipt projection is missing");
  await h.sql.unsafe(projection);
  const aggregateCheck=schema.match(/ALTER TABLE session_deliveries\n    ADD CONSTRAINT session_deliveries_aggregate_state_check[\s\S]*?;/)?.[0];
  if (!aggregateCheck) throw new Error("Actual delivery aggregate constraint is missing");
  await h.sql.unsafe(aggregateCheck);
}

/** Real event IDs, canonical wire identity and receipt FK, including interleaved card events. */
export async function recordWorkReceipt(h:PagePostgresHarness,sessionId:string,status:string,
  execution:CardWorkExecution | null | undefined,reason:string | null=null) {
  const payload=JSON.stringify({status,execution,termination_reason:reason});
  const rows=await h.sql<{id:number}[]>`SELECT event_append(${sessionId},'session_updated',${payload},'fixture receipt',NOW(),NULL) AS id`;
  const id=rows[0]!.id;
  if (execution !== undefined) await h.sql`UPDATE sessions SET execution_registration_id=${execution?.registrationId ?? null},
    execution_command_id=${execution?.executionCommandId ?? null} WHERE session_id=${sessionId}`;
  const terminal=["completed","error","interrupted"].includes(status);
  await h.sql`UPDATE sessions SET status=${status},termination_reason=${reason},termination_event_id=${terminal ? id! : null},updated_at=NOW() WHERE session_id=${sessionId}`;
  const application:EventSessionEffectApplicationWire={applied:true,canonical_session:{status,termination_reason:reason,
    termination_detail:null,termination_event_id:terminal ? id! : null,review_state:"not_required",last_assistant_text:null,
    updated_at:new Date().toISOString(),last_event_id:id!},
    ...(execution === undefined ? {} : {canonical_execution_registration:execution === null ? null : {
      registration_id:execution.registrationId,execution_command_id:execution.executionCommandId}})};
  const owner=(await h.sql`SELECT node_id FROM sessions WHERE session_id=${sessionId}`)[0]!;
  await h.sql`INSERT INTO event_ingress_receipts(node_id,stream_id,source_seq,session_id,payload_hash,event_id,effect_application)
    VALUES(${owner.node_id},${randomUUID()},1,${sessionId},${"a".repeat(64)},${id!},${h.sql.json(application)})`;
  return id!;
}

export async function consumeCardDelivery(h:PagePostgresHarness,deliveryId:string,sessionId:string) {
  const eventId=await recordWorkReceipt(h,sessionId,"running",undefined);
  await h.sql`INSERT INTO session_deliveries(delivery_id,target_session_id,relation_key,intent,source,payload_hash,state,aggregate_state,target_receipt_id)
    VALUES(${deliveryId},${sessionId},${deliveryId},'durable_next_turn','card_orchestration',${"a".repeat(64)},'consumed','consumed',${`event:${eventId}`})`;
  return eventId;
}

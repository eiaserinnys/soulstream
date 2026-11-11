import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";

// Same disposable DB and real mutation fixture as card-limit-assignee.postgres.test.ts.
let h:PagePostgresHarness, cards:CardControlPlaneService;
const human={actorKind:"user" as const,actorSessionId:null};
beforeAll(async()=>{
  h=await createPagePostgresHarness();
  expect(Number((await h.sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
  await prepareCardWorkSchema(h);
  await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
  await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES('card_orchestration','{"enabled":false}','test')`;
  // Exercise the actual migration, rather than only the harness DDL copy.
  await h.sql`ALTER TABLE cards DROP CONSTRAINT cards_limit_resume_check, DROP COLUMN limit_resume_session_id, DROP COLUMN limit_resume_at`;
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/152_card_limit_resume.sql",import.meta.url),"utf8"));
  await h.sql`INSERT INTO folders(id,name) VALUES('reservation','한도 예약')`;
  cards=new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql),{appendEventTx:appendCardEventTx});
},60000);
beforeEach(async()=>{
  await h.sql`DELETE FROM folder_operations`;await h.sql`DELETE FROM cards`;await h.sql`DELETE FROM sessions`;
});
afterAll(async()=>h?.cleanup());
async function blocked(short=true) {
  await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status) VALUES('owner','node','worker','running')`;
  const cardId=(await cards.createCard({...human,folderId:"reservation",title:"예약",request:"확인",assignee:{kind:"session",sessionId:"owner"}})).operation.target_id;
  await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id='owner'`;
  await cards.setCardStatus({...human,cardId,status:"running"});
  const resumeAt=new Date(Date.now()+3600000);
  let eventId=await recordWorkReceipt(h,"owner","error",null,"limit_hit");
  if(short) {
    await h.sql`SELECT event_append('owner','credential_alert',${JSON.stringify({status:"rejected",resets_at:resumeAt.toISOString()})},'',NOW(),NULL)`;
    eventId=(await h.sql`SELECT event_append('owner','session_ended',${JSON.stringify({termination_reason:"limit_hit",resets_at:resumeAt.toISOString()})},'',NOW(),NULL) AS id`)[0]!.id;
    await h.sql`UPDATE sessions SET termination_event_id=${eventId} WHERE session_id='owner'`;
  }
  const before=(await cards.getCard(cardId))!.card;
  await cards.blockCardForLimit({cardId,sessionId:"owner",terminationEventId:eventId,expectedVersion:before.version});
  return {cardId,resumeAt};
}
it("stores an owner with no clock for a long limit and clears it when that limit resumes",async()=>{
  const {cardId}=await blocked(false);
  expect((await cards.getCard(cardId))!.card).toMatchObject({status:"blocked",limit_resume_session_id:"owner",limit_resume_at:null});
  const version=(await cards.getCard(cardId))!.card.version;
  await cards.resumeDispatchedCard({cardId,sessionId:"owner",expectedVersion:version});
  expect((await cards.getCard(cardId))!.card).toMatchObject({status:"running",limit_resume_session_id:null,limit_resume_at:null});
});
it("preserves the reservation through title and now edits and clears it on a blocked-kind change",async()=>{
  const {cardId,resumeAt}=await blocked();
  await cards.patchCard({...human,cardId,title:"제목 수정"});
  await cards.updateCardNow({actorKind:"agent",actorSessionId:"owner",cardId,now:"기다립니다",turn:"outside"});
  expect((await cards.getCard(cardId))!.card).toMatchObject({limit_resume_session_id:"owner",limit_resume_at:resumeAt});
  await cards.setCardStatus({...human,cardId,status:"blocked",blockedKind:"no_report"});
  expect((await cards.getCard(cardId))!.card).toMatchObject({limit_resume_session_id:null,limit_resume_at:null});
});
it.each(["todo","queued","running","review","on_hold","done","cancelled","awaiting_verification"] as const)("clears both columns when leaving for %s",async status=>{
  const {cardId}=await blocked();
  await cards.setCardStatus({...human,cardId,status,...(status==="awaiting_verification"?{wakeAt:new Date(Date.now()+3600000).toISOString(),waitingFor:"완료 확인"}:{})});
  expect((await cards.getCard(cardId))!.card).toMatchObject({status,limit_resume_session_id:null,limit_resume_at:null});
});
it("archiving clears both columns and unarchiving does not resurrect them",async()=>{
  const {cardId}=await blocked();
  await cards.patchCard({...human,cardId,archived:true});
  expect((await cards.getCard(cardId))!.card).toMatchObject({archived:true,limit_resume_session_id:null,limit_resume_at:null});
  await cards.patchCard({...human,cardId,archived:false});
  expect((await cards.getCard(cardId))!.card).toMatchObject({limit_resume_session_id:null,limit_resume_at:null});
});
it("the DB accepts owner-only reservations and rejects orphan time, owner mismatch and invalid card configurations",async()=>{
  const {cardId}=await blocked(false);
  const invalid=[{limit_resume_session_id:null,limit_resume_at:new Date()},
    {limit_resume_session_id:"someone-else"},{blocked_kind:null},{assignee_kind:null},{assignee_session_id:null},{status:"running"},{archived:true}];
  for(const fields of invalid) await expect(h.sql`UPDATE cards SET ${h.sql(fields)} WHERE id=${cardId}`).rejects.toMatchObject({code:"23514",constraint_name:"cards_limit_resume_check"});
  await h.sql`UPDATE cards SET limit_resume_session_id=NULL,limit_resume_at=NULL WHERE id=${cardId}`;
  expect((await cards.getCard(cardId))!.card).toMatchObject({limit_resume_session_id:null,limit_resume_at:null});
});

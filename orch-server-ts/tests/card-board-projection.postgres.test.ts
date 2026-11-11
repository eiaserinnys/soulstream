import { afterAll,beforeAll,beforeEach,expect,it,vi } from "vitest";
import { createPagePostgresHarness,type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx,prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { readFile } from "node:fs/promises";
let h:PagePostgresHarness,cards:CardControlPlaneService,reports:PersistentReportService;
const publish=vi.fn();
const agent={actorKind:"agent" as const,actorSessionId:"pas"};
beforeAll(async()=>{
  h=await createPagePostgresHarness();await prepareCardWorkSchema(h);
  const schema=await readFile(new URL("../../packages/db-schema/sql/schema.sql",import.meta.url),"utf8");
  const start=schema.indexOf("CREATE OR REPLACE FUNCTION session_apply_metadata_entry(");
  await h.sql.unsafe(schema.slice(start,schema.indexOf("$$;",start)+3));
  await h.sql`INSERT INTO folders(id,name) VALUES('projection','판 계산')`;
  const sql=createFolderContentSqlAdapter(h.liveSql);
  cards=new CardControlPlaneService(sql,{appendEventTx:appendCardEventTx},undefined,undefined,publish);
  reports=new PersistentReportService(sql,publish);
},60000);
beforeEach(async()=>{
  await h.sql`DELETE FROM folder_operations`;await h.sql`DELETE FROM cards`;await h.sql`DELETE FROM sessions`;
  await h.sql`INSERT INTO sessions(session_id,agent_id,metadata) VALUES('pas','worker','[{"type":"persistent_session","value":{"enabled":true}}]')`;
});
afterAll(async()=>h?.cleanup());
async function make(){return (await cards.createCard({...agent,folderId:"projection",title:"카드",request:"검증",assignee:{kind:"session",sessionId:"pas"}})).operation.target_id;}
async function ask(id:string){await cards.askQuestion({...agent,cardId:id,text:"진행?",options:["진행"]});return String((await cards.getCard(id))!.questions[0]!.id);}
it("keeps calculated entries outside the twelve direct-entry limit",async()=>{
  for(let i=0;i<12;i++)expect((await reports.put("pas",{key:`manual${i}`,kind:"see",title:"직접",context:"",action:"",card_numbers:[]})).ok).toBe(true);
  const id=await make();await cards.setCardStatus({...agent,cardId:id,status:"blocked",blockedKind:"no_report"});
  expect(await reports.get("pas")).toHaveLength(13);
  await ask(id);expect((await reports.get("pas")).filter(e=>e.key.startsWith("cq_"))).toHaveLength(1);
  expect(await reports.put("pas",{key:"thirteenth",kind:"see",title:"초과",context:"",action:"",card_numbers:[]})).toMatchObject({ok:false});
});
it.each(["done","cancelled","on_hold"] as const)("restores questions after reopening %s",async status=>{
  const id=await make();const q=await ask(id);
  await cards.setCardStatus({actorKind:"user",actorSessionId:null,cardId:id,status});
  expect(await reports.get("pas")).toEqual([]);
  await cards.setCardStatus({actorKind:"user",actorSessionId:null,cardId:id,status:"awaiting_verification",wakeAt:new Date(Date.now()+60000).toISOString(),waitingFor:"검증"});
  expect((await reports.get("pas")).map(e=>e.key)).toEqual([`cq_${q}`]);
});
it("rejects deletion of a question entry with the report error shape",async()=>{
  const id=await make();const q=await ask(id);
  // Production normally places the question via its question callback.
  await reports.placeQuestion(id,q);
  expect(await reports.remove("pas",`cq_${q}`)).toMatchObject({ok:false,code:"INVALID_REPORT",errors:[{path:"key",reason:"질문 장은 답하거나 철회하면 내려갑니다"}]});
});
it("keeps acknowledged cards down until their status tuple changes",async()=>{
  const id=await make();await cards.setCardStatus({...agent,cardId:id,status:"blocked",blockedKind:"no_report"});
  expect((await reports.remove("pas",`card_${id}`)).ok).toBe(true);
  await cards.patchCard({...agent,cardId:id,title:"바꾼 제목"});
  expect(await reports.get("pas")).toEqual([]);
  await cards.setCardStatus({...agent,cardId:id,status:"blocked",blockedKind:"limit"});
  expect((await reports.get("pas")).map(e=>e.key)).toEqual([`card_${id}`]);
});
it("rebuilds from current facts on PAS activation and at boot, preserving direct entries",async()=>{
  await h.sql`UPDATE sessions SET metadata='[]' WHERE session_id='pas'`;
  const id=await make();const q=await ask(id);
  expect(await reports.get("pas")).toEqual([]);
  await h.sql`UPDATE sessions SET metadata='[{"type":"persistent_session","value":{"enabled":true}}]' WHERE session_id='pas'`;
  await reports.acceptNodeEvents([{type:"node_session_event",nodeId:"node",data:{agentSessionId:"pas",event:{type:"metadata",metadata_type:"persistent_session",value:{enabled:true}}}}]);
  expect((await reports.get("pas")).map(e=>e.key)).toEqual([`cq_${q}`]);
  await reports.put("pas",{key:"manual",kind:"see",title:"직접",context:"유지",action:"",card_numbers:[]});
  const before=await reports.get("pas");
  const metadata=[{type:"persistent_session",value:{enabled:true}},{type:"persistent_report",value:{entries:before.filter(e=>e.key==="manual").concat({...before[0]!,key:"cq_stale"})}}];
  await h.sql`UPDATE sessions SET metadata=${h.sql.json(metadata as never)} WHERE session_id='pas'`;
  const warn=vi.fn();await reports.syncActiveBoards(warn);
  expect(await reports.get("pas")).toEqual(before);
  expect(warn).not.toHaveBeenCalled();
  expect(await reports.syncBoard("pas")).toMatchObject({ok:true,changed:false});
});
it("keeps acknowledgement per board and projects multiple questions from the DB",async()=>{
  await h.sql`INSERT INTO sessions(session_id,agent_id,metadata) VALUES('second','worker','[{"type":"persistent_session","value":{"enabled":true}}]')`;
  const id=await make();
  await cards.addComment({actorKind:"user",actorSessionId:"second",cardId:id,body:"감독 참여"});
  await cards.setCardStatus({...agent,cardId:id,status:"blocked",blockedKind:"no_report"});
  expect((await reports.get("second")).map(e=>e.key)).toEqual([`card_${id}`]);
  await reports.remove("pas",`card_${id}`);
  await cards.updateCardNow({...agent,cardId:id,now:"상황 갱신",turn:"agent"});
  expect(await reports.get("pas")).toEqual([]);
  expect(await reports.get("second")).toHaveLength(1);
  await ask(id);await cards.askQuestion({...agent,cardId:id,text:"두 번째",options:["확인"]});
  expect((await reports.get("pas")).filter(e=>e.key.startsWith("cq_"))).toHaveLength(2);
  expect((await reports.get("second")).filter(e=>e.key.startsWith("cq_"))).toHaveLength(2);
  await cards.patchCard({...agent,cardId:id,archived:true});
  expect(await reports.get("pas")).toEqual([]);expect(await reports.get("second")).toEqual([]);
});

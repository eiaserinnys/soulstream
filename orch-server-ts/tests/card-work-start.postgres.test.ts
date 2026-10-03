import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { readFile } from "node:fs/promises";
import { CardOrchestrationRepository } from "../src/cards/card_orchestration_repository.js";
import { endedCardWork } from "../src/cards/card_work_lifecycle.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt, consumeCardDelivery } from "./card-work-postgres-fixture.js";

describe("explicit manual card work", () => {
  let h: PagePostgresHarness, cards: CardControlPlaneService, repo:CardOrchestrationRepository;
  let execution={registrationId:"registration",executionCommandId:"command"};
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES('work','작업')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,status,execution_registration_id,execution_command_id) VALUES('owner','node','running','registration','command'),('other','node','running','other-reg','other-command')`;
    await h.sql`UPDATE sessions SET agent_id='profile',model_preset='model'`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings VALUES('card_dispatch','{"nodeConcurrency":{"default":1}}',1,NOW(),'migration')`;
    await h.sql.unsafe(await readFile(new URL('../../packages/db-schema/sql/migrations/113_card_orchestration.sql',import.meta.url),'utf8'));
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    await recordWorkReceipt(h,"owner","running",execution);
    repo=new CardOrchestrationRepository(async()=>createBoardYjsSqlAdapter(h.liveSql));
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx });
  }, 60000);
  beforeEach(async () => { await h.sql`UPDATE cards SET archived=TRUE`; });
  afterAll(async () => h?.cleanup());
  async function make(status = "todo", kind = "session", owner = "owner") {
    const r = await cards.createCard({ actorKind: "user", actorSessionId: null, folderId: "work", title: "요청", request: "요청", assignee: {kind: kind as "session", sessionId: owner} });
    const id = r.operation.target_id;
    await h.sql`UPDATE cards SET status=${status} WHERE id=${id}`;
    return id;
  }
  const declaration = (cardId: string, key: string, reason?: string) => ({ cardId, actorKind: "agent" as const, actorSessionId: "owner", expectedVersion: 1, idempotencyKey: key, reason, execution: {...execution} });
  it("starts only the declared todo and replays the same declaration", async () => {
    const id = await make(), other = await make("todo", "session", "other");
    await cards.startCardWork(declaration(id, "todo-start"));
    expect((await cards.getCard(id))?.card.status).toBe("running");
    expect((await cards.getCard(other))?.card.status).toBe("todo");
    const replay = await cards.startCardWork(declaration(id, "todo-start"));
    expect(replay.idempotent).toBe(true);
  });
  it.each(["review","queued","blocked","done","cancelled","running"])("starts manual %s without report, reason or admission",async status=>{
    const id=await make(status);
    await cards.startCardWork(declaration(id,`manual-${status}`));
    expect((await cards.getCard(id))!.card).toMatchObject({status:"running",completed_kind:null,completed_at:null});
  });
  it("allows a manual owner execution while its automatic delivery is still pending",async()=>{
    const id=await make("queued","session","other"),identity={registrationId:"other-reg",executionCommandId:"other-command"};
    await recordWorkReceipt(h,"other","running",identity);
    const r=(await repo.claim({inputHash:id,policyVersion:1,snapshot:[{cardId:id,cardVersion:1}],target:{agentId:"judge",nodeId:"node",modelPreset:"model",minimumRemainingPercent:15}}))!;
    await repo.prepareLaunch(r);
    await repo.decide(r,{decisions:[{cardId:id,cardVersion:1,action:"run",reason:"자동"}]},1,"revision");
    await cards.recordDispatch({cardId:id,expectedVersion:1,sessionId:"other",nodeId:"node",admission:{runId:r.id,leaseToken:r.lease_token,workerInput:{agentId:"profile",modelPreset:"model",existingSession:true,deliveryId:"pending-other"}}});
    await repo.claimWorker("other");
    const d=(await repo.pendingWorkers()).find(d=>d.card_id===id)!;
    await repo.authorizeWorker({runId:r.id,sessionId:"other",executionToken:d.launch_token,nodeId:"node",cardId:id});
    await cards.startCardWork({actorKind:"agent",actorSessionId:"other",cardId:id,expectedVersion:2,idempotencyKey:"manual-pending",execution:identity});
    expect((await cards.getCard(id))!.card.status).toBe("running");
    expect((await h.sql`SELECT state,input FROM card_orchestration_dispatches WHERE card_id=${id}`)[0]).toMatchObject({state:"launching"});
    expect(await repo.workerObserved("other",r.id,id)).toBe(false);
    await repo.workerState("other","rejected","superseded by manual work");
    await repo.finish(r,"completed","manual write");
    await h.sql`DELETE FROM cards WHERE id=${id}`;
  });
  it("consumption alone keeps queued; only admission-correlated owner declaration starts it", async () => {
    const id=await make("queued");
    const r=(await repo.claim({inputHash:id,policyVersion:1,snapshot:[{cardId:id,cardVersion:1}],target:{agentId:"judge",nodeId:"node",modelPreset:"model",minimumRemainingPercent:15}}))!;
    await repo.prepareLaunch(r);
    await repo.decide(r,{decisions:[{cardId:id,cardVersion:1,action:"run",reason:"승인"}]},1,"revision");
    await cards.recordDispatch({cardId:id,expectedVersion:1,sessionId:"owner",nodeId:"node",admission:{runId:r.id,leaseToken:r.lease_token,workerInput:{agentId:"profile",modelPreset:"model",existingSession:true,deliveryId:"delivery"}}});
    expect((await cards.getCard(id))?.card.status).toBe("queued");
    await repo.claimWorker("owner");
    const d=(await repo.pendingWorkers()).find(d=>d.card_id===id)!;
    expect(await repo.authorizeWorker({runId:r.id,sessionId:"owner",executionToken:d.launch_token,nodeId:"node",cardId:id})).toBe(true);
    expect(await repo.workerObserved("owner",r.id,id)).toBe(false);
    const request={...declaration(id,"auto-start"),expectedVersion:2};
    await consumeCardDelivery(h,"delivery","owner");
    expect((await cards.getCard(id))?.card.status).toBe("queued");
    await cards.startCardWork(request);
    expect((await cards.getCard(id))?.card.status).toBe("running");
    expect(await repo.workerObserved("owner",r.id,id)).toBe(true);
    await repo.finish(r,"completed","applied");

  });
  it.each([true,false])("keeps declared work running while waiting for delegated reports, policy=%s", async enabled => {
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}',${h.sql.json(enabled)}) WHERE setting_key='card_orchestration'`;
    const id=await make(), untouched=await make("todo","agent"),reported=await make("todo","session","other");
    await cards.startCardWork(declaration(id,`end-work-${enabled}`));
    await cards.startCardWork({...declaration(reported,`reported-work-${enabled}`),actorSessionId:"other",execution:{registrationId:"other-reg",executionCommandId:"other-command"}});
    await cards.addReport({actorKind:"agent",actorSessionId:"owner",cardId:reported,title:"보고",body:"증거",format:"markdown"});
    await recordWorkReceipt(h,"owner","completed",null);
    const ended=await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner");
    expect(ended.map(r=>r.card_id)).toContain(id);
    expect(ended.map(r=>r.card_id)).not.toContain(untouched);
    const warnings:string[]=[];
    const dispatcher=new CardDispatcher({ deliveryExists: async () => false,repository:new CardDispatchRepository(async()=>createBoardYjsSqlAdapter(h.liveSql)),
      cards:async()=>cards,resolveTarget:()=>({nodeId:"node",agentId:"profile",modelPreset:"model",available:true,reason:null}),
      launch:async()=>{},sendMessage:async()=>{},notify:async()=>{},warn:m=>warnings.push(m),
      orchestration:{enabled:async()=>enabled,ownsSession:async()=>false,kick:async()=>{}}});
    await dispatcher.sessionEnded("owner");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"running",blocked_kind:null});
    expect((await cards.getCard(untouched))?.card.status).toBe("todo");
    expect((await cards.getCard(reported))?.card.status).toBe("running");
    expect(warnings).toEqual([]);
    execution={registrationId:`new-reg-${enabled}`,executionCommandId:`new-command-${enabled}`};
    await recordWorkReceipt(h,"owner","running",execution);
    await cards.patchCard({actorKind:"user",actorSessionId:null,cardId:id,archived:true});
    const fresh=await make();
    await cards.startCardWork({...declaration(fresh,`later-work-${enabled}`),execution:{...execution}});
    expect((await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner")).map(r=>r.card_id)).not.toContain(fresh);
  });
  it("classifies quota termination from the declared execution's canonical receipt",async()=>{
    await h.sql`UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE setting_key='card_orchestration'`;
    const id=await make();
    await cards.startCardWork(declaration(id,"limited-work"));
    await recordWorkReceipt(h,"owner","error",null,"limit_hit");
    const ended=await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner");
    expect(ended.find(w=>w.card_id===id)?.terminal_session).toMatchObject({status:"error",termination_reason:"limit_hit"});
    const dispatcher=new CardDispatcher({ deliveryExists: async () => false,repository:new CardDispatchRepository(async()=>createBoardYjsSqlAdapter(h.liveSql)),
      cards:async()=>cards,resolveTarget:()=>({nodeId:"node",agentId:"profile",modelPreset:"model",available:true,reason:null}),
      launch:async()=>{},sendMessage:async()=>{},notify:async()=>{},warn:m=>{throw new Error(m);},
      orchestration:{enabled:async()=>true,ownsSession:async()=>false,kick:async()=>{}}});
    await dispatcher.sessionEnded("owner");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"blocked",blocked_kind:"limit"});
    execution={registrationId:"final-reg",executionCommandId:"final-command"};
    await recordWorkReceipt(h,"owner","running",execution);
  });
  it.each(["todo","question"])("starts declared %s work with an unanswered question",async status=>{
    const id=await make(status === "question" ? "blocked" : "todo");
    if(status === "question") await h.sql`UPDATE cards SET blocked_kind='question',blocked_detail='판단' WHERE id=${id}`;
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text) VALUES(${`open-${status}`},${id},'owner','판단')`;
    await cards.startCardWork(declaration(id,`open-${status}`));
    const detail=(await cards.getCard(id))!;
    expect(detail.card).toMatchObject({status:"running",blocked_kind:null,blocked_detail:null});
    expect(detail.questions[0]!.answer).toBeNull();
  });
  it.each(["limit","no_report"])("starts explicit work blocked by %s",async kind=>{
    const id=await make("blocked");
    await h.sql`UPDATE cards SET blocked_kind=${kind} WHERE id=${id}`;
    await cards.startCardWork(declaration(id,`blocked-${kind}`));
    expect((await cards.getCard(id))!.card).toMatchObject({status:"running",blocked_kind:null});
  });
  it("rejects another assignee and stale execution while allowing archive", async () => {
    const other = await make("todo", "session", "other");
    await expect(cards.startCardWork(declaration(other, "other"))).rejects.toThrow("assignee");
    const archived = await make();
    await h.sql`UPDATE cards SET archived=TRUE WHERE id=${archived}`;
    await cards.startCardWork(declaration(archived, "archived"));
    expect((await cards.getCard(archived))!.card).toMatchObject({status:"running",archived:true});
    const id = await make();
    await expect(cards.startCardWork({...declaration(id,"stale"),execution:{registrationId:"old",executionCommandId:"old"}})).rejects.toThrow("execution");
  });
});

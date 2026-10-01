import { readFile } from "node:fs/promises";
import { CardOrchestrationRepository } from "../src/cards/card_orchestration_repository.js";
import { endedCardWork } from "../src/cards/card_work_lifecycle.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
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
  afterAll(async () => h?.cleanup());
  async function make(status = "todo", kind = "session", owner = "owner") {
    const r = await cards.createCard({ actorKind: "user", actorSessionId: null, folderId: "work", title: "요청", request: "요청", assignee: {kind: kind as "session", sessionId: owner} });
    const id = r.operation.target_id;
    await h.sql`UPDATE cards SET status=${status} WHERE id=${id}`;
    return id;
  }
  const declaration = (cardId: string, key: string, reason?: string) => ({ cardId, actorKind: "agent" as const, actorSessionId: "owner", expectedVersion: 1, idempotencyKey: key, reason, execution: {...execution} });
  it("starts only the declared todo and replays the same declaration", async () => {
    const id = await make(), other = await make();
    await cards.startCardWork(declaration(id, "todo-start"));
    expect((await cards.getCard(id))?.card.status).toBe("running");
    expect((await cards.getCard(other))?.card.status).toBe("todo");
    const replay = await cards.startCardWork(declaration(id, "todo-start"));
    expect(replay.idempotent).toBe(true);
  });
  it("requires a reason for review work", async () => {
    const id = await make("review");
    await expect(cards.startCardWork(declaration(id, "review-empty"))).rejects.toThrow("reason");
    await cards.startCardWork(declaration(id, "review-reason", "검수 커멘트 반영"));
    expect((await cards.getCard(id))?.card.status).toBe("running");
  });
  it.each(["queued", "blocked", "done", "cancelled"])("rejects unfenced %s", async status => {
    const id = await make(status);
    await expect(cards.startCardWork(declaration(id, `denied-${status}`))).rejects.toThrow();
    expect((await cards.getCard(id))?.card.status).toBe(status);
  });
  it("rejects running work without an identical declaration replay", async () => {
    const id=await make("running");
    await expect(cards.startCardWork(declaration(id,"undeclared-running"))).rejects.toThrow("replay");
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
    await expect(cards.startCardWork(request)).rejects.toThrow("consumed");
    await consumeCardDelivery(h,"delivery","owner");
    expect((await cards.getCard(id))?.card.status).toBe("queued");
    await cards.startCardWork(request);
    expect((await cards.getCard(id))?.card.status).toBe("running");
    expect(await repo.workerObserved("owner",r.id,id)).toBe(true);
    await repo.finish(r,"completed","applied");
    const second=await make("queued");
    const next=(await repo.claim({inputHash:second,policyVersion:1,snapshot:[{cardId:second,cardVersion:1}],target:{agentId:"judge",nodeId:"node",modelPreset:"model",minimumRemainingPercent:15}}))!;
    await repo.prepareLaunch(next);
    await repo.decide(next,{decisions:[{cardId:second,cardVersion:1,action:"run",reason:"같은 담당"}]},2,"revision");
    // Same active owner consumes one capacity slot for both card instructions.
    await cards.recordDispatch({cardId:second,expectedVersion:1,sessionId:"owner",nodeId:"node",admission:{runId:next.id,leaseToken:next.lease_token,workerInput:{agentId:"profile",modelPreset:"model",existingSession:true,deliveryId:"delivery2"}}});
    expect(await repo.workerObserved("owner",next.id,second)).toBe(false);
    expect((await repo.pendingWorkers()).filter(d=>d.card_id===second)).toHaveLength(1);
    await repo.finish(next,"completed","admitted");
  });
  it("binds termination to declared execution and leaves other cards alone", async () => {
    const id=await make(), untouched=await make(),reported=await make();
    await cards.startCardWork(declaration(id,"end-work"));
    await cards.startCardWork(declaration(reported,"reported-work"));
    await cards.addReport({actorKind:"agent",actorSessionId:"owner",cardId:reported,title:"보고",body:"증거",format:"markdown"});
    await recordWorkReceipt(h,"owner","completed",null);
    const ended=await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner");
    expect(ended.map(r=>r.card_id)).toContain(id);
    expect(ended.map(r=>r.card_id)).not.toContain(untouched);
    const warnings:string[]=[];
    const dispatcher=new CardDispatcher({repository:new CardDispatchRepository(async()=>createBoardYjsSqlAdapter(h.liveSql)),
      cards:async()=>cards,resolveTarget:()=>({nodeId:"node",agentId:"profile",modelPreset:"model",available:true,reason:null}),
      launch:async()=>{},sendMessage:async()=>{},notify:async()=>{},warn:m=>warnings.push(m),
      orchestration:{enabled:async()=>true,ownsSession:async()=>false,kick:async()=>{}}});
    await dispatcher.sessionEnded("owner");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"blocked",blocked_kind:"no_report"});
    expect((await cards.getCard(untouched))?.card.status).toBe("todo");
    expect((await cards.getCard(reported))?.card.status).toBe("running");
    expect(warnings).toEqual([]);
    execution={registrationId:"new-reg",executionCommandId:"new-command"};
    await recordWorkReceipt(h,"owner","running",execution);
    const fresh=await make();
    await cards.startCardWork({...declaration(fresh,"later-work"),execution:{registrationId:"new-reg",executionCommandId:"new-command"}});
    expect((await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner")).map(r=>r.card_id)).not.toContain(fresh);
  });
  it("classifies quota termination from the declared execution's canonical receipt",async()=>{
    const id=await make();
    await cards.startCardWork(declaration(id,"limited-work"));
    await recordWorkReceipt(h,"owner","error",null,"limit_hit");
    const ended=await endedCardWork(createBoardYjsSqlAdapter(h.liveSql),"owner");
    expect(ended.find(w=>w.card_id===id)?.terminal_session).toMatchObject({status:"error",termination_reason:"limit_hit"});
    const dispatcher=new CardDispatcher({repository:new CardDispatchRepository(async()=>createBoardYjsSqlAdapter(h.liveSql)),
      cards:async()=>cards,resolveTarget:()=>({nodeId:"node",agentId:"profile",modelPreset:"model",available:true,reason:null}),
      launch:async()=>{},sendMessage:async()=>{},notify:async()=>{},warn:m=>{throw new Error(m);},
      orchestration:{enabled:async()=>true,ownsSession:async()=>false,kick:async()=>{}}});
    await dispatcher.sessionEnded("owner");
    expect((await cards.getCard(id))?.card).toMatchObject({status:"blocked",blocked_kind:"limit"});
    execution={registrationId:"final-reg",executionCommandId:"final-command"};
    await recordWorkReceipt(h,"owner","running",execution);
  });
  it("rejects another assignee, archived work, stale execution and open questions", async () => {
    const other = await make("todo", "session", "other");
    await expect(cards.startCardWork(declaration(other, "other"))).rejects.toThrow("assignee");
    const archived = await make();
    await h.sql`UPDATE cards SET archived=TRUE WHERE id=${archived}`;
    await expect(cards.startCardWork(declaration(archived, "archived"))).rejects.toThrow("archived");
    const id = await make();
    await expect(cards.startCardWork({...declaration(id,"stale"),execution:{registrationId:"old",executionCommandId:"old"}})).rejects.toThrow("execution");
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text) VALUES('open',${id},'owner','판단')`;
    await expect(cards.startCardWork(declaration(id,"open"))).rejects.toThrow("questions");
  });
});

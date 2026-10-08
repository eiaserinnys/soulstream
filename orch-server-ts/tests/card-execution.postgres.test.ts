import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardExecutionService } from "../src/cards/card_execution_service.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";

describe("user card execution transport",()=>{
  let h:PagePostgresHarness,cards:CardControlPlaneService;
  beforeAll(async()=>{
    h=await createPagePostgresHarness(); await prepareCardWorkSchema(h);
    await h.sql.unsafe(await readFile(new URL('../../packages/db-schema/sql/migrations/116_card_execution_requests.sql',import.meta.url),'utf8'));
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL('../../packages/db-schema/sql/migrations/113_card_orchestration.sql',import.meta.url),'utf8'));
    await h.sql`INSERT INTO folders(id,name) VALUES('work','작업'),('target','대상')`;
    cards=new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql),{appendEventTx:appendCardEventTx});
  },60000);
  afterAll(async()=>h?.cleanup());
  async function fixture(mode:"ok"|"pending"|"reject"="ok",owner=false){
    const made=await cards.createCard({actorKind:"user",actorSessionId:null,folderId:"work",title:"요청",request:"원문 그대로",assignee:{kind:"agent",agentId:"profile"},nodeId:"node",modelPreset:"model"});
    const cardId=made.operation.target_id;
    const proof={registrationId:`reg-${cardId}`,executionCommandId:`cmd-${cardId}`};
    const launch=vi.fn(async(input:any)=>{
      if(mode==="reject") throw Object.assign(new Error("노드 거부"),{code:"NODE_REJECTED"});
      await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${input.sessionId},'node','profile','initializing',${cardId},'model')`;
      if(mode==="ok") await recordWorkReceipt(h,input.sessionId,"running",proof);
    });
    const ensure=vi.fn(async(input:any)=>{await recordWorkReceipt(h,input.sessionId,"running",proof);return {state:"started" as const,execution:proof};});
    if(owner){const id=`owner-${cardId}`;await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${id},'node','profile','completed',${cardId},'owner-model')`;await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${id} WHERE id=${cardId}`;}
    const service=new CardExecutionService({sql:createBoardYjsSqlAdapter(h.liveSql),cards,validate:async(card)=>({nodeId:card.node_id!,agentId:card.assignee_agent_id!,modelPreset:card.model_preset!}),launch,ensure});
    return {service,cardId,launch,ensure,proof};
  }
  const actor={actorKind:"user" as const,actorSessionId:null,actorUserId:"user"};
  const input=(id:string,key:string)=>({...actor,cardId:id,expectedVersion:1,idempotencyKey:key});
  const agentActor={actorKind:"agent" as const,actorSessionId:"agent-caller",actorUserId:null};
  const agentInput=(id:string,key:string,expectedVersion=1,sessionId="agent-caller")=>({...agentActor,actorSessionId:sessionId,cardId:id,expectedVersion,idempotencyKey:key});
  const llmActor={actorKind:"llm" as const,actorSessionId:null,actorUserId:null};
  const llmInput=(id:string,key:string)=>({...llmActor,cardId:id,expectedVersion:1,idempotencyKey:key});
  it("creates once, links the actual session and replays without another turn",async()=>{
    const f=await fixture();const result=await f.service.execute(input(f.cardId,"success"));
    expect(result.execution.state).toBe("started");expect(result.card.status).toBe("running");
    expect(result.card.assignee_session_id).toBe(result.execution.sessionId);
    expect(f.launch.mock.calls[0]![0].callerSource).toBe("browser");
    await f.service.execute(input(f.cardId,"success"));expect(f.launch).toHaveBeenCalledTimes(1);expect(f.ensure).not.toHaveBeenCalled();
  });
  it("executes a draft for an agent and records the caller as the actor",async()=>{
    const f=await fixture();
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,model_preset) VALUES('agent-caller','node','profile','running','model')`;
    const result=await f.service.execute(agentInput(f.cardId,"agent-run"));
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]![0].callerSource).toBe("system");
    expect(result.card.status).toBe("running");
    const operations=await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations WHERE target_id=${f.cardId} AND operation_type='execute_card'`;
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(row=>row.actor_kind==='agent'&&row.actor_session_id==='agent-caller')).toBe(true);
  });
  it("executes a draft for an external LLM and records a sessionless actor",async()=>{
    const f=await fixture();const result=await f.service.execute(llmInput(f.cardId,"llm-run"));
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]![0].callerSource).toBe("system");
    expect(result.card.status).toBe("running");
    expect(result.card.assignee_session_id).toBe(result.execution.sessionId);
    const operations=await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations WHERE target_id=${f.cardId} AND operation_type='execute_card'`;
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(row=>row.actor_kind==='llm'&&row.actor_session_id===null)).toBe(true);
  });
  it.each(["running","done"] as const)("refuses agent execution while a card is %s",async status=>{
    const f=await fixture();
    await cards.setCardStatus({...actor,cardId:f.cardId,status,idempotencyKey:`state-${status}`});
    const current=(await cards.getCard(f.cardId))!.card;
    await expect(f.service.execute(agentInput(f.cardId,`agent-${status}`,current.version)))
      .rejects.toMatchObject({statusCode:422,message:`드래프트(todo)나 대기(queued) 카드만 실행할 수 있습니다. 현재 상태: ${status}`});
    expect(f.launch).not.toHaveBeenCalled();expect(f.ensure).not.toHaveBeenCalled();
    expect((await h.sql`SELECT id FROM card_execution_requests WHERE card_id=${f.cardId}`)).toHaveLength(0);
  });
  it("different concurrent keys share one pending reservation and fixed session",async()=>{
    const f=await fixture("pending");const results=await Promise.all([f.service.execute(input(f.cardId,"concurrent-a")),f.service.execute(input(f.cardId,"concurrent-b"))]);
    expect(new Set(results.map(r=>r.execution.sessionId)).size).toBe(1);expect(f.launch).toHaveBeenCalledTimes(1);
    expect(results.every(r=>r.execution.state==="pending" && r.card.status==="todo")).toBe(true);
    await f.service.execute(input(f.cardId,"concurrent-a"));expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("GET reconciles a quickly completed execution from its registration receipt without resuming",async()=>{
    const f=await fixture("pending");const result=await f.service.execute(input(f.cardId,"lost"));
    await recordWorkReceipt(h,result.execution.sessionId,"running",f.proof);
    await recordWorkReceipt(h,result.execution.sessionId,"completed",null);
    const checked=await f.service.observe(f.cardId,result.execution.requestId,actor);
    expect(checked.execution.state).toBe("started");expect(f.ensure).not.toHaveBeenCalled();expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("confirmed failure preserves request/settings/status",async()=>{
    const f=await fixture("reject");await expect(f.service.execute(input(f.cardId,"rejected"))).rejects.toThrow("노드 거부");
    expect((await cards.getCard(f.cardId))!.card).toMatchObject({status:"todo",request:"원문 그대로",node_id:"node",model_preset:"model"});
    const failed=(await h.sql`SELECT id,state,error FROM card_execution_requests WHERE card_id=${f.cardId}`)[0]!;
    await expect(f.service.startReserved(failed.id,actor)).rejects.toMatchObject({statusCode:422});
    expect(await h.sql`SELECT state,error FROM card_execution_requests WHERE id=${failed.id}`).toEqual([{state:"failed",error:failed.error}]);
  });
  it("reserves in an external transaction before starting the fixed request",async()=>{
    const made=await cards.createCard({actorKind:"user",actorSessionId:null,folderId:"work",title:"예약",request:"외부 트랜잭션",assignee:{kind:"agent",agentId:"profile"},nodeId:"node",modelPreset:"model"});
    const cardId=made.operation.target_id;
    let signalLaunch!:()=>void;
    let releaseLaunch!:()=>void;
    const launchStarted=new Promise<void>(resolve=>{signalLaunch=resolve;});
    const launchGate=new Promise<void>(resolve=>{releaseLaunch=resolve;});
    const launch=vi.fn(async()=>{signalLaunch();await launchGate;});
    const service=new CardExecutionService({sql:createBoardYjsSqlAdapter(h.liveSql),cards,
      validate:async card=>({nodeId:card.node_id!,agentId:card.assignee_agent_id!,modelPreset:card.model_preset!}),
      launch,ensure:async()=>({state:"started" as const,execution:{registrationId:"unused",executionCommandId:"unused"}})});
    const params=input(cardId,"external-reservation");
    const reserved=await h.sql.begin(sql=>service.reserveTx(sql as unknown as RepositorySql,params));

    expect(launch).not.toHaveBeenCalled();
    const started=service.startReserved(reserved.id,actor);
    await launchStarted;
    expect(await h.sql`SELECT state,sent FROM card_execution_requests WHERE id=${reserved.id}`)
      .toEqual([{state:"pending",sent:true}]);
    releaseLaunch();
    const response=await started;
    expect(response.execution).toMatchObject({requestId:reserved.id,sessionId:reserved.session_id,state:"pending"});
    expect(launch).toHaveBeenCalledTimes(1);
  },60_000);
  it('a created session with failed startup retries that same owner',async()=>{
    const f=await fixture('pending');const first=await f.service.execute(input(f.cardId,'startup-failure'));
    await h.sql`UPDATE sessions SET status='error' WHERE session_id=${first.execution.sessionId}`;
    await expect(f.service.observe(f.cardId,first.execution.requestId,actor)).rejects.toThrow('실행 시작');
    expect((await cards.getCard(f.cardId))!.card).toMatchObject({status:'todo',assignee_session_id:first.execution.sessionId,node_id:'node',model_preset:'model'});
    const retried=await f.service.execute(input(f.cardId,'startup-failure'));
    expect(retried.execution).toMatchObject({...first.execution,state:'started'});
    expect(f.launch).toHaveBeenCalledTimes(1);expect(f.ensure).toHaveBeenCalledTimes(1);
  });
  it("resumes the owner with its identity and never creates a replacement",async()=>{
    const f=await fixture("ok",true);const result=await f.service.execute(input(f.cardId,"resume"));expect(result.execution.state).toBe("started");expect(f.launch).not.toHaveBeenCalled();expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.ensure.mock.calls[0]![0].target.modelPreset).toBe("owner-model");
    expect(f.ensure.mock.calls[0]![0].callerSource).toBe("browser");
  });
  it("resumes an existing owner for an agent with system caller source",async()=>{
    const f=await fixture("ok",true);
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,model_preset) VALUES('agent-caller-resume','node','profile','running','model')`;
    const current=(await cards.getCard(f.cardId))!.card;
    const result=await f.service.execute(agentInput(f.cardId,"agent-resume",current.version,"agent-caller-resume"));
    expect(result.execution.state).toBe("started");expect(f.launch).not.toHaveBeenCalled();expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.ensure.mock.calls[0]![0].callerSource).toBe("system");
  });
  it("an undelivered create retries the same identity and replay survives unavailable catalog",async()=>{
    const f=await fixture();
    const delivered=f.launch.getMockImplementation()!;
    f.launch.mockImplementationOnce(async()=>undefined);
    const first=await f.service.execute(input(f.cardId,'undelivered'));
    expect(first.execution.state).toBe('pending');
    await f.service.observe(f.cardId,first.execution.requestId,actor);
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.launch.mockImplementation(delivered);
    const second=await f.service.execute(input(f.cardId,'undelivered'));
    expect(second.execution).toMatchObject({...first.execution,state:'started'});
    expect(f.launch.mock.calls[0]![0]).toEqual(f.launch.mock.calls[1]![0]);
    const replay=new CardExecutionService({sql:createBoardYjsSqlAdapter(h.liveSql),cards,
      validate:async()=>{throw new Error('catalog unavailable');},launch:f.launch,ensure:f.ensure});
    // HTTP success was lost: same POST after first execution completed is only replay.
    await recordWorkReceipt(h,first.execution.sessionId,'completed',null);
    expect((await replay.execute(input(f.cardId,'undelivered'))).execution.state).toBe('started');
    expect(f.launch).toHaveBeenCalledTimes(2);expect(f.ensure).not.toHaveBeenCalled();
  });
  it.each(['review','done'] as const)('late startup confirmation preserves formal %s and a new intent still starts',async status=>{
    const f=await fixture('pending');const first=await f.service.execute(input(f.cardId,`late-${status}`));
    await recordWorkReceipt(h,first.execution.sessionId,'running',f.proof);
    await cards.startCardWork({actorKind:'agent',actorSessionId:first.execution.sessionId,cardId:f.cardId,
      expectedVersion:(await cards.getCard(f.cardId))!.card.version,idempotencyKey:`accepted-${status}`,execution:f.proof});
    await cards.setCardStatus({...actor,cardId:f.cardId,status,expectedVersion:(await cards.getCard(f.cardId))!.card.version,idempotencyKey:`finished-${status}`});
    await recordWorkReceipt(h,first.execution.sessionId,'completed',null);
    const checked=await f.service.observe(f.cardId,first.execution.requestId,actor);
    expect(checked.execution.state).toBe('started');expect(checked.card.status).toBe(status);
    const next=await f.service.execute({...input(f.cardId,`new-intent-${status}`),expectedVersion:checked.card.version});
    expect(next.card.status).toBe('running');expect(f.ensure).toHaveBeenCalledTimes(1);expect(f.launch).toHaveBeenCalledTimes(1);
  });
  async function automaticFixture(){
    const f=await fixture();
    const runId=`run-${f.cardId}`,sessionId=`automatic-${f.cardId}`;
    await h.sql`UPDATE cards SET status='queued' WHERE id=${f.cardId}`;
    await h.sql`INSERT INTO card_orchestration_runs(id,policy_version,input_hash,snapshot,target,session_id,execution_token,lease_token,lease_expires_at,state)
      VALUES(${runId},1,'hash','{}','{}',${sessionId},'execution-token','lease-token',NOW()+INTERVAL '1 hour','completed')`;
    await h.sql`INSERT INTO card_orchestration_dispatches(run_id,card_id,session_id,node_id,input,launch_token,state)
      VALUES(${runId},${f.cardId},${sessionId},'node','{}','worker-token','launching')`;
    return {...f,sessionId};
  }
  it('automatic acceptance followed by review closes observation without changing card or token',async()=>{
    const f=await automaticFixture();const first=await f.service.execute(input(f.cardId,'auto-accepted'));
    expect(first.execution.state).toBe('pending');expect(f.launch).not.toHaveBeenCalled();
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${f.sessionId},'node','profile','running',${f.cardId},'model')`;
    await recordWorkReceipt(h,f.sessionId,'running',f.proof);
    await h.sql`UPDATE card_orchestration_dispatches SET state='running',input=${h.sql.json({execution:f.proof})} WHERE session_id=${f.sessionId}`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_session_id=${f.sessionId},assignee_agent_id=NULL,status='review' WHERE id=${f.cardId}`;
    const result=await f.service.observe(f.cardId,first.execution.requestId,actor);
    expect(result.execution.state).toBe('started');expect(result.card.status).toBe('review');
    expect((await h.sql`SELECT launch_token FROM card_orchestration_dispatches WHERE session_id=${f.sessionId}`)[0]!.launch_token).toBe('worker-token');
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it('automatic rejection before acceptance closes the request without sending',async()=>{
    const f=await automaticFixture();const first=await f.service.execute(input(f.cardId,'auto-rejected'));
    await h.sql`UPDATE card_orchestration_dispatches SET state='rejected',reason='명백한 노드 거부' WHERE session_id=${f.sessionId}`;
    await expect(f.service.observe(f.cardId,first.execution.requestId,actor)).rejects.toThrow('명백한 노드 거부');
    expect((await h.sql`SELECT state FROM card_execution_requests WHERE id=${first.execution.requestId}`)[0]!.state).toBe('failed');
    expect((await cards.getCard(f.cardId))!.card.status).toBe('queued');expect(f.launch).not.toHaveBeenCalled();expect(f.ensure).not.toHaveBeenCalled();
  });
  it("settings save is atomic and refuses an assigned card",async()=>{
    const f=await fixture();const params={...input(f.cardId,"settings"),folderId:"target",nodeId:"next",agentId:"profile",modelPreset:"new"};
    await cards.saveExecutionSettings(params);
    expect((await cards.getCard(f.cardId))!.card).toMatchObject({folder_id:"target",node_id:"next",model_preset:"new"});
    const fresh=await fixture();await expect(cards.saveExecutionSettings({...params,...input(fresh.cardId,'rollback'),folderId:'missing-folder'})).rejects.toThrow();
    expect((await cards.getCard(fresh.cardId))!.card).toMatchObject({folder_id:'work',node_id:'node',model_preset:'model'});
    const owner=await fixture("ok",true);await expect(cards.saveExecutionSettings({...params,...input(owner.cardId,"assigned")})).rejects.toThrow("담당");
  });
  it("pending execution blocks settings changes",async()=>{
    const f=await fixture("pending");await f.service.execute(input(f.cardId,"pending-settings"));
    await h.sql`UPDATE cards SET status='queued' WHERE id=${f.cardId}`;
    await expect(cards.recordDispatch({cardId:f.cardId,sessionId:'automatic-competing',nodeId:'node',expectedVersion:(await cards.getCard(f.cardId))!.card.version})).rejects.toThrow('확인');
    await expect(cards.saveExecutionSettings({...input(f.cardId,"pending-write"),expectedVersion:(await cards.getCard(f.cardId))!.card.version,folderId:"target",nodeId:"next",agentId:"profile",modelPreset:"new"})).rejects.toThrow("확인");
  });
});

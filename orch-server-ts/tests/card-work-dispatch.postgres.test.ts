import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardExecutionService, readCardExecutionRegistration, type CardExecutionRequest } from "../src/cards/card_execution_service.js";
import type { DispatchWorkInput } from "../src/cards/card_work_dispatch_service.js";
import { CardWorkDispatchService } from "../src/cards/card_work_dispatch_service.js";
import {
  canonicalWorkErrorDeliveryId,
  recordConfirmedErrorTx,
  relayCanonicalErrorTx,
} from "../src/cards/card_work_error_delivery.js";
import type { RepositorySql } from "../src/cards/control_plane/card_types.js";
import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import {
  appendCardEventTx,
  prepareCardWorkSchema,
  recordWorkReceipt,
} from "./card-work-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { SessionMutationRepository } from "../src/control_plane/repositories/session_mutation_repository.js";
import { cardHandlers } from "../src/mcp/card_handlers.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";

const actor = { actorKind: "agent" as const, actorSessionId: "caller-session" };
const createInput = (idempotencyKey: string, overrides: Partial<Extract<DispatchWorkInput, { kind: "create" }>> = {}): Extract<DispatchWorkInput, { kind: "create" }> => ({
  kind: "create" as const,
  request: "원문 요청",
  brief: "완료 기준",
  title: "접수 카드",
  idempotencyKey,
  ...overrides,
});

function createStack(options: { allowFolder?: (folderId: string) => boolean; launch?: (input: unknown) => Promise<unknown> } = {}) {
  const sql = createBoardYjsSqlAdapter(h.liveSql);
  const cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
  const launch = vi.fn(options.launch ?? (async () => undefined));
  const execution = new CardExecutionService({
    sql,
    cards,
    validate: async (card) => ({
      nodeId: card.node_id ?? "node-a",
      agentId: card.assignee_agent_id ?? "agent-a",
      modelPreset: card.model_preset,
    }),
    launch,
    ensure: async () => ({
      state: "already_running" as const,
      execution: { registrationId: "registered", executionCommandId: "command" },
    }),
  });
  const optionsForService = {
    sql,
    cards,
    execution,
    authorizeFolder: async (folderId: string) => {
      if (!(options.allowFolder ?? ((id) => id === "work"))(folderId)) {
        throw Object.assign(new Error("Folder access denied"), { statusCode: 403 });
      }
    },
    sendDelivery: vi.fn(async (_row: SessionDeliveryRow) => undefined),
    emitCardUpdated: vi.fn(),
    warn: vi.fn(),
  };
  return {
    sql,
    cards,
    execution,
    launch,
    optionsForService,
    service: new CardWorkDispatchService(optionsForService),
  };
}

let h: PagePostgresHarness;
beforeAll(async () => {
  h = await createPagePostgresHarness();
  await prepareCardWorkSchema(h);
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/116_card_execution_requests.sql", import.meta.url), "utf8"));
  await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
  await h.sql`INSERT INTO folders(id,name) VALUES ('work','작업'),('restricted','제한'),('claude','Claude'),('llm','LLM')`;
  await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id,model_preset)
    VALUES ('caller-session','node-a','agent-a','running','work','model-a')`;
  await h.sql.unsafe(`
    CREATE TABLE session_mutation_receipts(idempotency_key TEXT PRIMARY KEY,operation TEXT NOT NULL,session_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json JSONB NOT NULL);
    CREATE FUNCTION session_register_with_model_preset(
      a TEXT,b TEXT,c TEXT,d TEXT,e TEXT,f TEXT,g TEXT,h TEXT,i TIMESTAMPTZ,j TIMESTAMPTZ,k TEXT,l BOOLEAN,m BOOLEAN,n TEXT,o TEXT,p TEXT,q TEXT,r TEXT
    ) RETURNS void LANGUAGE SQL AS $$
      INSERT INTO sessions(session_id,node_id,agent_id,session_type,status,created_at,updated_at,caller_session_id,predecessor_session_id,model_preset,reasoning_effort)
      VALUES(a,b,c,e,h,i,j,k,o,p,r);
    $$;
  `);
}, 60000);
afterAll(async () => h?.cleanup());

describe("card work dispatch transaction contracts", () => {
  it("validates replacement-only arguments at the MCP handler", async () => {
    const options={cards:{}} as any;
    const context={principal:"internal" as const,callerSessionId:"caller-session",nodeId:"node-a"};
    const missing=await cardHandlers.dispatch_work(options,{title:"새 카드",request:"요청",idempotency_key:"missing",replace_assignee:true},context);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("replace_assignee=true에는 card_id가 필요합니다.");
    const folder=await cardHandlers.dispatch_work(options,{card_id:"card",folder_id:"work",request:"요청",idempotency_key:"folder",replace_assignee:true},context);
    expect(folder.isError).toBe(true);
    expect(folder.content[0]?.text).toContain("담당 교체에는 folder_id를 지정할 수 없습니다.");
  });
  it("accepts from the actual MCP handler and commits registration, ownership and child callers together", async () => {
    const stack=createStack();
    await h.sql`UPDATE sessions SET session_type='agent',metadata=${h.sql.json([{type:"persistent_session",value:{enabled:true}}])} WHERE session_id='caller-session'`;
    const made=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
      title:"교체할 카드",request:"보존할 요청",assignee:{kind:"agent",agentId:"old-agent"},nodeId:"node-a",modelPreset:"old-model"});
    const otherCard=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
      title:"다른 카드",request:"다른 요청",assignee:{kind:"agent",agentId:"worker"},nodeId:"node-a",modelPreset:"model-a"});
    const cardId=made.operation.target_id, oldId=`mcp-old-${cardId}`, childId=`child-${cardId}`, otherId=`other-${cardId}`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset,caller_session_id)
      VALUES (${oldId},'node-a','old-agent','error',${cardId},'work','old-model',NULL),
        (${childId},'node-a','worker','running',${cardId},'work','model-a',${oldId}),
        (${otherId},'node-a','worker','running',${otherCard.operation.target_id},'work','model-a',${oldId})`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
    await h.sql`UPDATE cards SET items=${h.sql.json([{id:1,title:"보존할 항목",state:"todo",result:null,evidence:[],caveat:null,rev:0,confirmed:null,fixOpen:0,reopened:null,from:null}])} WHERE id=${cardId}`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body) VALUES
      (${`note-${cardId}`},${cardId},'agent','note','보존할 노트'),
      (${`comment-${cardId}`},${cardId},'user','spoken','보존할 커멘트')`;
    const contentBefore=(await h.sql`SELECT number,items FROM cards WHERE id=${cardId}`)[0];
    const service = new CardWorkDispatchService({...stack.optionsForService,isNodeConnected:()=>true,
      validateTarget:async (target:any)=>target} as any);
    const kick=service.kick.bind(service);
    let initialKick:Promise<void> | undefined;
    service.kick=receipt=>{initialKick=kick(receipt);return initialKick;};
    const options={cards:{workDispatchServiceProvider:async()=>service}} as any;
    const response=await cardHandlers.dispatch_work(options,{card_id:cardId,replace_assignee:true,request:"이어 주세요",
      brief:"완료 기준",node_id:"node-b",model_preset:"model-b",idempotency_key:`mcp-${cardId}`},
      {principal:"internal",callerSessionId:"caller-session",nodeId:"node-a"});
    expect(response.isError).not.toBe(true);
    const receipt=response.structuredContent as {request_id:string};
    await initialKick;
    const request=(await h.sql`SELECT * FROM card_execution_requests WHERE id=${receipt.request_id}`)[0]!;
    const reports=new PersistentReportService(stack.sql,()=>undefined);
    const supervisors=await (reports as any).connectedSessions(stack.sql,cardId) as Set<string>;
    expect(supervisors.has("caller-session")).toBe(true);
    const now=new Date();
    await new SessionMutationRepository(h.sql).registerSession({idempotencyKey:`register-${cardId}`,sessionId:request.session_id,
      nodeId:"node-b",agentId:"old-agent",claudeSessionId:null,sessionType:"agent",prompt:"교체",clientId:null,status:"initializing",
      createdAt:now,updatedAt:now,callerSessionId:null,predecessorSessionId:null,modelPreset:"model-b",cardId});
    expect((await h.sql`SELECT assignee_session_id,node_id,model_preset,request FROM cards WHERE id=${cardId}`)[0])
      .toEqual({assignee_session_id:request.session_id,node_id:"node-b",model_preset:"model-b",request:"보존할 요청"});
    expect((await h.sql`SELECT caller_session_id FROM sessions WHERE session_id=${childId}`)[0]!.caller_session_id).toBe(request.session_id);
    expect((await h.sql`SELECT caller_session_id FROM sessions WHERE session_id=${otherId}`)[0]!.caller_session_id).toBe(oldId);
    const op=(await h.sql`SELECT actor_session_id,payload_json FROM folder_operations WHERE target_id=${cardId} AND operation_type='update_card'`)[0]!;
    expect(op.actor_session_id).toBe("caller-session");
    expect(op.payload_json).toEqual({assignee:{kind:"session",sessionId:request.session_id},
      replacement:{from_session_id:oldId,to_session_id:request.session_id,dispatch_operation_id:request.idempotency_key.slice("dispatch-work-replace:".length)}});
    expect((await h.sql`SELECT number,items FROM cards WHERE id=${cardId}`)[0]).toEqual(contentBefore);
    expect(await h.sql`SELECT kind,body FROM card_comments WHERE card_id=${cardId} ORDER BY kind`).toEqual([
      {kind:"note",body:"보존할 노트"},{kind:"spoken",body:"보존할 커멘트"}]);
    const proof={registrationId:"replacement-reg",executionCommandId:"replacement-cmd"};
    await recordWorkReceipt(h,request.session_id,"running",proof);
    await stack.execution.observe(cardId,request.id,actor);
    expect((await h.sql`SELECT status FROM cards WHERE id=${cardId}`)[0]!.status).toBe("running");
  },60000);

  it("recovers pending replacement kicks and sends a confirmed failure to the dispatch actor", async () => {
    const stack=createStack(),start=vi.fn(async()=>undefined);
    const made=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
      title:"복구",request:"요청",assignee:{kind:"agent",agentId:"agent"},nodeId:"node-a",modelPreset:"model-a"});
    const cardId=made.operation.target_id,oldId=`recovery-owner-${cardId}`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${oldId},'node-a','agent','error',${cardId},'model-a')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
    const service=new CardWorkDispatchService({...stack.optionsForService,isNodeConnected:()=>true,validateTarget:async(target:any)=>target,
      execution:{reserveTx:stack.execution.reserveTx.bind(stack.execution),startReserved:start}} as any);
    const receipt=await service.accept({kind:"replace",cardId,request:"계속",idempotencyKey:`recovery-${cardId}`} as any,actor);
    if(receipt.work.kind!=="execution") throw new Error("execution expected");
    await service.kickPendingForNode("node-a");
    expect(start).toHaveBeenCalledWith(receipt.work.requestId,expect.objectContaining({actorSessionId:"caller-session"}));
    const delivery=await stack.sql.begin(tx=>recordConfirmedErrorTx(tx,{operationId:receipt.operationId,cardId,
      workId:receipt.work.kind==="execution"?receipt.work.requestId:"",stage:"launch",message:"시작 거부",failureId:"error-ack"}));
    expect(delivery?.target_session_id).toBe("caller-session");
    expect((await h.sql`SELECT assignee_session_id FROM cards WHERE id=${cardId}`)[0]!.assignee_session_id).toBe(oldId);
  },60000);
  it("accepts a replacement, retains its receipt after the new owner starts, and rejects changed input", async () => {
    const stack = createStack();
    const made = await stack.cards.createCard({ actorKind:"user", actorSessionId:null, actorUserId:"user", folderId:"work",
      title:"이어갈 카드", request:"원래 요청", assignee:{kind:"agent",agentId:"old-agent"}, nodeId:"node-a", modelPreset:"old-model" });
    const cardId=made.operation.target_id;
    const oldId=`old-${cardId}`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES (${oldId},'node-a','old-agent','error',${cardId},'work','old-model')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
    const service = new CardWorkDispatchService({ ...stack.optionsForService,
      isNodeConnected: () => true, validateTarget: async (target: any) => target } as any);
    const input = {kind:"replace",cardId,request:"이어 주세요",brief:"완료 기준",agentId:"new-agent",idempotencyKey:`replace-${cardId}`} as any;
    const first=await service.accept(input,actor);
    expect(first.work.kind).toBe("execution");
    if(first.work.kind!=="execution") throw new Error("execution expected");
    const reservation=(await h.sql`SELECT * FROM card_execution_requests WHERE id=${first.work.requestId}`)[0]!;
    expect(reservation.target).toMatchObject({nodeId:"node-a",agentId:"new-agent",modelPreset:"old-model",folderId:"work"});
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset)
      VALUES (${first.work.sessionId},'node-a','new-agent','running',${cardId},'old-model')`;
    await h.sql`UPDATE cards SET assignee_session_id=${first.work.sessionId} WHERE id=${cardId}`;
    expect(await service.accept(input,actor)).toEqual({...first,idempotent:true});
    await expect(service.accept({...input,request:"다른 요청"},actor)).rejects.toMatchObject({statusCode:409,message:"같은 요청 키가 다른 작업에 사용되었습니다."});
    for(const change of [{brief:"다른 요약"},{agentId:"다른 에이전트"},{nodeId:"node-b"},{modelPreset:"다른 모델"}])
      await expect(service.accept({...input,...change},actor)).rejects.toMatchObject({statusCode:409,message:"같은 요청 키가 다른 작업에 사용되었습니다."});
  },60000);

  it("accepts review, done and blocked cards, distinguishes connected running owners, and handles pending reservations", async () => {
    const stack=createStack();
    let connected=true;
    const service=new CardWorkDispatchService({...stack.optionsForService,isNodeConnected:()=>connected,
      validateTarget:async(target:any)=>target} as any);
    for(const status of ["review","done","blocked"]){
      const made=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
        title:status,request:"요청",assignee:{kind:"agent",agentId:"old-agent"},nodeId:"node-a",modelPreset:"old-model"});
      const cardId=made.operation.target_id,oldId=`status-owner-${cardId}`;
      await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${oldId},'node-a','old-agent','error',${cardId},'old-model')`;
      await h.sql`UPDATE cards SET status=${status},assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
      const input={kind:"replace",cardId,request:"계속",idempotencyKey:`status-${cardId}`} as any;
      const accepted=await service.accept(input,actor);
      expect(accepted.work.kind).toBe("execution");
      if(accepted.work.kind!=="execution") throw new Error("execution expected");
      expect((await h.sql`SELECT target FROM card_execution_requests WHERE id=${accepted.work.requestId}`)[0]!.target)
        .toEqual({nodeId:"node-a",agentId:"old-agent",modelPreset:"old-model",folderId:"work"});
      await expect(service.accept({...input,idempotencyKey:`duplicate-${cardId}`},actor))
        .rejects.toMatchObject({statusCode:409,message:"이미 담당 교체가 진행 중입니다."});
    }
    const made=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
      title:"pending",request:"요청",assignee:{kind:"agent",agentId:"old-agent"},nodeId:"node-a",modelPreset:"old-model"});
    const cardId=made.operation.target_id,oldId=`pending-owner-${cardId}`;
    const input={kind:"replace",cardId,request:"계속",idempotencyKey:`pending-${cardId}`} as any;
    await expect(service.accept(input,actor)).rejects.toMatchObject({statusCode:409,message:"담당 세션이 없는 카드는 run_card로 실행하세요."});
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${oldId},'node-a','old-agent','running',${cardId},'old-model')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
    await expect(service.accept(input,actor)).rejects.toMatchObject({statusCode:409,message:expect.stringContaining("지금 턴")});
    connected=false;
    await h.sql`INSERT INTO card_execution_requests(id,idempotency_key,keys,card_id,session_id,mode,target,previous_status)
      VALUES(${`old-request-${cardId}`},${`old-key-${cardId}`},'{}',${cardId},${oldId},'observe','{}','todo')`;
    await expect(service.accept(input,actor)).rejects.toMatchObject({statusCode:409,message:"자동 배정 실행이 진행 중입니다. 끝난 뒤 교체하세요."});
    await h.sql`UPDATE card_execution_requests SET mode='resume' WHERE card_id=${cardId}`;
    await service.accept(input,actor);
    expect((await h.sql`SELECT state,error FROM card_execution_requests WHERE id=${`old-request-${cardId}`}`)[0])
      .toEqual({state:"failed",error:"담당 교체 요청으로 이전 실행 예약을 종료했습니다."});
  },60000);

  it("rolls back session registration when its reserved card owner has changed", async () => {
    const stack=createStack();
    const made=await stack.cards.createCard({actorKind:"user",actorSessionId:null,actorUserId:"user",folderId:"work",
      title:"롤백",request:"요청",assignee:{kind:"agent",agentId:"agent"},nodeId:"node-a",modelPreset:"model-a"});
    const cardId=made.operation.target_id,oldId=`rollback-owner-${cardId}`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,model_preset) VALUES(${oldId},'node-a','agent','error',${cardId},'model-a')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id=${oldId} WHERE id=${cardId}`;
    const service=new CardWorkDispatchService({...stack.optionsForService,isNodeConnected:()=>true,validateTarget:async(target:any)=>target} as any);
    const receipt=await service.accept({kind:"replace",cardId,request:"계속",idempotencyKey:`rollback-${cardId}`} as any,actor);
    if(receipt.work.kind!=="execution") throw new Error("execution expected");
    await h.sql`UPDATE cards SET assignee_kind=NULL,assignee_session_id=NULL WHERE id=${cardId}`;
    const now=new Date(),sessionId=receipt.work.sessionId;
    await expect(new SessionMutationRepository(h.sql).registerSession({idempotencyKey:`rollback-reg-${cardId}`,sessionId,
      nodeId:"node-a",agentId:"agent",claudeSessionId:null,sessionType:"agent",prompt:"교체",clientId:null,status:"initializing",
      createdAt:now,updatedAt:now,callerSessionId:null,predecessorSessionId:null,modelPreset:"model-a",cardId}))
      .rejects.toThrow("예약 이후 카드 담당이 바뀌었습니다.");
    expect(await h.sql`SELECT session_id FROM sessions WHERE session_id=${sessionId}`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='update_card'`).toHaveLength(0);
  },60000);
  it("commits create and reservation before kick, replays the same receipt, and rejects changed input", async () => {
    let releaseLaunch!: () => void;
    let signalLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const launchStarted = new Promise<void>((resolve) => { signalLaunch = resolve; });
    const stack = createStack({ launch: async () => { signalLaunch(); await launchGate; } });
    const input = createInput("create-replay");

    const receipt = await stack.service.accept(input, actor);
    expect(receipt).toMatchObject({ accepted: true, idempotent: false, work: { kind: "execution" } });
    expect(receipt.card.number === null || typeof receipt.card.number === "number").toBe(true);
    if (receipt.work.kind !== "execution") throw new Error("Expected execution receipt");
    const stored = await h.sql`SELECT c.request,c.brief,c.folder_id,c.assignee_agent_id,c.node_id,c.model_preset,r.id,r.session_id,r.state,r.target
      FROM cards c JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${receipt.card.id}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ request: "원문 요청", brief: "완료 기준", folder_id: "work", assignee_agent_id: "agent-a", node_id: "node-a", model_preset: "model-a", id: receipt.work.requestId, session_id: receipt.work.sessionId, state: "pending" });

    await h.sql`UPDATE sessions SET folder_id='restricted',node_id='node-changed',agent_id='agent-changed',model_preset='model-changed' WHERE session_id='caller-session'`;
    const [replayA, replayB] = await Promise.all([
      stack.service.accept(input, actor),
      stack.service.accept(input, actor),
    ]);
    expect(replayA).toMatchObject({ ...receipt, idempotent: true });
    expect(replayB).toMatchObject({ ...receipt, idempotent: true });
    expect(replayA.work).toEqual(receipt.work);
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:create-replay'`).toHaveLength(1);
    await expect(stack.service.accept(createInput("create-replay", { request: "다른 원문" }), actor)).rejects.toMatchObject({ statusCode: 409 });

    const kicking = stack.service.kick(receipt);
    await launchStarted;
    expect(receipt.accepted).toBe(true);
    expect(stack.launch).toHaveBeenCalledTimes(1);
    releaseLaunch();
    await kicking;
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE source='card_change' AND producer_id=${receipt.operationId}` ).toHaveLength(0);
    await h.sql`UPDATE sessions SET folder_id='work',node_id='node-a',agent_id='agent-a',model_preset='model-a' WHERE session_id='caller-session'`;
  }, 60000);

  it("rolls back card and reservation together and rejects unauthorized or system-folder defaults", async () => {
    const base = createStack();
    const rollbackInput = createInput("rollback-card", { title: "롤백 전용 카드" });
    const brokenExecution = {
      reserveTx: async (tx: RepositorySql, params: Parameters<CardExecutionService["reserveTx"]>[1]) => {
        await base.execution.reserveTx(tx, params);
        throw new Error("injected reservation failure");
      },
      startReserved: (requestId: string, dispatchActor: Parameters<CardExecutionService["startReserved"]>[1]) =>
        base.execution.startReserved(requestId, dispatchActor),
    };
    const broken = new CardWorkDispatchService({ ...base.optionsForService, execution: brokenExecution });
    await expect(broken.accept(rollbackInput, actor)).rejects.toThrow("injected reservation failure");
    expect(await h.sql`SELECT id FROM cards WHERE title='롤백 전용 카드' AND request='원문 요청'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:rollback-card'`).toHaveLength(0);
    expect(await h.sql`SELECT id FROM card_execution_requests WHERE idempotency_key=(
      SELECT 'dispatch-work-execution:'||id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:rollback-card')`).toHaveLength(0);

    const denied = createStack({ allowFolder: (folderId) => folderId === "work" });
    await expect(denied.service.accept(createInput("acl-denied", { folderId: "restricted" }), actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:acl-denied'`).toHaveLength(0);

    await h.sql`UPDATE sessions SET folder_id='claude' WHERE session_id='caller-session'`;
    await expect(denied.service.accept(createInput("system-default"), actor)).rejects.toThrow();
    expect(await h.sql`SELECT id FROM folder_operations WHERE idempotency_key='dispatch-work:caller-session:system-default'`).toHaveLength(0);
    await h.sql`UPDATE sessions SET folder_id='work' WHERE session_id='caller-session'`;
  }, 60000);

  it("warns and resolves when post-accept launch throws without creating an error delivery", async () => {
    const stack = createStack();
    const execution = {
      reserveTx: stack.execution.reserveTx.bind(stack.execution),
      startReserved: vi.fn(async () => { throw new Error("ordinary launch failure"); }),
    };
    const service = new CardWorkDispatchService({ ...stack.optionsForService, execution });
    const receipt = await service.accept(createInput("kick-ordinary-failure"), actor);

    await expect(service.kick(receipt)).resolves.toBeUndefined();
    expect(stack.optionsForService.warn).toHaveBeenCalledWith(expect.stringContaining("ordinary launch failure"));
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_id=${receipt.operationId} AND producer_kind='card_work_error'`).toHaveLength(0);
  }, 60000);

  it("stores a spoken followup and its saved delivery atomically, then replays and marks only an accepted delivery", async () => {
    const stack = createStack();
    const made = await stack.cards.createCard({
      actorKind: "user", actorSessionId: null, actorUserId: "user",
      folderId: "work", title: "담당 카드", request: "기존 요청",
      assignee: { kind: "agent", agentId: "owner-agent" }, nodeId: "node-a", modelPreset: "model-a",
    });
    const cardId = made.operation.target_id;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES ('owner-session','node-a','owner-agent','completed',${cardId},'work','owner-model')`;
    await h.sql`UPDATE cards SET assignee_kind='session',assignee_agent_id=NULL,assignee_session_id='owner-session' WHERE id=${cardId}`;

    const input = { kind: "followup" as const, cardId, request: "다음 지시", brief: "확인할 결과", idempotencyKey: "followup-replay" };
    const receipt = await stack.service.accept(input, actor);
    expect(receipt).toMatchObject({ accepted: true, idempotent: false, work: { kind: "delivery", sessionId: "owner-session" } });
    if (receipt.work.kind !== "delivery") throw new Error("Expected delivery receipt");
    const expectedComment = "요청 원문:\n다음 지시\n\n필요한 맥락과 완료기준:\n확인할 결과";
    const savedComment = await h.sql`SELECT author_kind,session_id,kind,body,delivered_at FROM card_comments WHERE card_id=${cardId}`;
    expect(savedComment).toEqual([{ author_kind: "user", session_id: "caller-session", kind: "spoken", body: expectedComment, delivered_at: null }]);
    const deliveryRows = await h.sql`SELECT * FROM session_deliveries WHERE delivery_id=${receipt.work.deliveryId}`;
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]).toMatchObject({ target_session_id: "owner-session", source_session_id: "caller-session", producer_id: receipt.operationId, source: "card_change", intent: "durable_next_turn", state: "pending" });
    expect(deliveryRows[0]!.payload.text).toContain(expectedComment);
    expect(deliveryRows[0]!.payload.caller_info).toEqual({ source: "agent", session_id: "caller-session" });
    expect(stack.optionsForService.emitCardUpdated).toHaveBeenCalledTimes(1);

    const replay = await stack.service.accept(input, actor);
    expect(replay).toMatchObject({ ...receipt, idempotent: true });
    expect(replay.work).toEqual(receipt.work);
    expect(await h.sql`SELECT id FROM card_comments WHERE card_id=${cardId}`).toHaveLength(1);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_id=${receipt.operationId} AND producer_kind IS NULL`).toHaveLength(1);
    expect(stack.optionsForService.emitCardUpdated).toHaveBeenCalledTimes(1);

    const deliveryError = await stack.sql.begin((tx) => recordConfirmedErrorTx(tx, {
      operationId: receipt.operationId,
      cardId,
      workId: receipt.work.kind === "delivery" ? receipt.work.deliveryId : "",
      stage: "delivery",
      message: "전달이 명시적으로 거부됐습니다",
      failureId: "delivery-ack-rejected",
    }));
    expect(deliveryError).not.toBeNull();
    const replayAfterError = await stack.service.accept(input, actor);
    expect(replayAfterError.idempotent).toBe(true);
    expect(replayAfterError.work).toEqual(receipt.work);
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE producer_id=${receipt.operationId}`).toHaveLength(2);

    const deliveryWorkId = receipt.work.deliveryId;
    const savedPayload = deliveryRows[0]!.payload as Record<string, unknown>;
    stack.optionsForService.sendDelivery.mockImplementation(async (row) => {
      expect(row.delivery_id).toBe(deliveryWorkId);
      expect(row.payload).toEqual(savedPayload);
      await h.sql`UPDATE session_deliveries SET state='queued',queued_at=NOW(),updated_at=NOW() WHERE delivery_id=${row.delivery_id}`;
    });
    await stack.service.kick(receipt);
    const marked = await h.sql`SELECT delivered_at FROM card_comments WHERE card_id=${cardId}`;
    expect(marked[0]!.delivered_at).not.toBeNull();
  }, 60000);

  it("records only confirmed errors for the operation actor and relays an exact canonical execution failure", async () => {
    const stack = createStack();
    const receipt = await stack.service.accept(createInput("error-relay"), actor);
    if (receipt.work.kind !== "execution") throw new Error("Expected execution receipt");
    const failure = {
      operationId: receipt.operationId,
      cardId: receipt.card.id,
      workId: receipt.work.requestId,
      stage: "launch" as const,
      message: "노드가 명시적으로 거부했습니다",
      failureId: "ack:node-rejected",
    };
    const first = await stack.sql.begin((tx) => recordConfirmedErrorTx(tx, failure));
    expect(first).not.toBeNull();
    if (!first) throw new Error("Expected confirmed error delivery");
    const replay = await stack.sql.begin((tx) => recordConfirmedErrorTx(tx, { ...failure, message: "후속 문구" }));
    expect(replay?.delivery_id).toBe(first.delivery_id);
    expect(replay?.payload).toEqual(first.payload);
    expect(first.target_session_id).toBe("caller-session");
    expect(first.payload.text).toContain("launch");
    expect(first.payload.text).toContain("노드가 명시적으로 거부했습니다");
    expect(await h.sql`SELECT delivery_id FROM session_deliveries WHERE relation_key=${first.relation_key}`).toHaveLength(1);

    const proof = { registrationId: "registration-exact", executionCommandId: "command-exact" };
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset)
      VALUES (${receipt.work.sessionId},'node-a','agent-a','initializing',${receipt.card.id},'work','model-a')`;
    const eventId = await recordWorkReceipt(h, receipt.work.sessionId, "error", proof, "error_aborted");
    const savedRequest = await h.sql`SELECT execution FROM card_execution_requests WHERE id=${receipt.work.requestId}`;
    expect(savedRequest[0]!.execution).toBeNull();
    const executionRequest = (await stack.sql<CardExecutionRequest[]>`
      SELECT * FROM card_execution_requests WHERE id=${receipt.work.requestId}
    `)[0]!;
    expect(await readCardExecutionRegistration(stack.sql, executionRequest)).toEqual(proof);
    const canonical = {
      sessionId: receipt.work.sessionId,
      eventId,
      executionCommandId: proof.executionCommandId,
      registrationId: proof.registrationId,
      applied: true,
      status: "error",
      terminationReason: "error_aborted",
      message: "실행이 종료됐습니다",
    };
    const runtime = await stack.sql.begin((tx) => relayCanonicalErrorTx(tx, canonical));
    expect(runtime).not.toBeNull();
    expect(runtime?.delivery_id).toBe(canonicalWorkErrorDeliveryId(receipt.work.sessionId, eventId));
    expect(runtime?.relation_key).toBe(`dispatch-work-error:runtime:${receipt.work.sessionId}:${eventId}`);
    expect(runtime?.target_session_id).toBe("caller-session");
    expect(runtime?.payload.text).toContain("runtime");
    expect(runtime?.payload.text).toContain("실행이 종료됐습니다");

    const mismatchedProof = await stack.sql.begin((tx) => relayCanonicalErrorTx(tx, {
      ...canonical,
      executionCommandId: "another-command",
    }));
    expect(mismatchedProof).toBeNull();

    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,folder_id,model_preset)
      VALUES ('unrelated-fatal','node-a','agent-a','initializing','work','model-a')`;
    const unrelatedProof = { registrationId: "registration-other", executionCommandId: "command-other" };
    const unrelatedEvent = await recordWorkReceipt(h, "unrelated-fatal", "error", unrelatedProof, "error_aborted");
    const unrelated = await stack.sql.begin((tx) => relayCanonicalErrorTx(tx, {
      ...canonical,
      sessionId: "unrelated-fatal",
      eventId: unrelatedEvent,
      executionCommandId: unrelatedProof.executionCommandId,
      registrationId: unrelatedProof.registrationId,
    }));
    expect(unrelated).toBeNull();
  }, 60000);
});

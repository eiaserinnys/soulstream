import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { CardOrchestrationCoordinator } from "../src/cards/card_orchestration_coordinator.js";
import { createCardDispatchRuntime } from "../src/cards/card_dispatch_runtime.js";
import { createSessionOwnerResolver } from "../src/session/session_owner.js";
import { listCardRouteBody, mutateCardRouteBody, readCardRouteBody } from "../src/cards/card_route_body.js";
import { readFolderSnapshot } from "../src/folders/folder_operations.js";
import { readCardDependencies, replaceCardDependencies } from "../src/cards/card_dependencies.js";
import { readCardDispatchSettings, updateCardDispatchSettings } from "../src/cards/card_dispatch_settings.js";
import { appendCardEventTx, prepareCardWorkSchema, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("card dependencies", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let queue: CardDispatchRepository;
  const actor = { actorKind: "agent" as const, actorSessionId: "pas" };
  const authorize = async () => {};
  let sequence = 0;
  const key = () => `dependency-${++sequence}`;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB, ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
    await prepareCardReminderSchema(h);
    await h.sql`INSERT INTO folders(id,name) VALUES('dependencies','선행 시험')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES('pas','idle')`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":0}}','test')`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx });
    queue = new CardDispatchRepository(async () => sql);
  }, 60_000);
  afterAll(async () => h?.cleanup());

  it("keeps a queued card in place until its predecessor is done, then exposes the changed projection", async () => {
    const make = async (title: string, dependsOn?: string[]) => cards.createCard({ ...actor, folderId: "dependencies", title,
      request: "", queue: true, assignee: { kind: "agent", agentId: "dev" }, idempotencyKey: key(), dependsOn });
    const first = (await make("앞")).operation.target_id;
    const second = (await make("뒤", [first])).operation.target_id;
    const third = (await make("다음")).operation.target_id;
    expect((await queue.queued()).map(card => card.id)).toEqual([first, third]);
    const before = await cards.mcpRead.getCard(second, {}, null);
    expect(before.card).toMatchObject({ dependsOn: [{ id: first, title: "앞", status: "queued", met: false }] });
    for (const input of [{ status: "queued" as const }, { query: "뒤" }]) {
      const result = await cards.mcpRead.listCards(input, null);
      expect(result.cards).toEqual(expect.arrayContaining([expect.objectContaining({ id: second,
        dependsOn: [expect.objectContaining({ id: first, met: false })] })]));
    }
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, cardId: first, status: "done" });
    expect((await queue.queued()).map(card => card.id)).toEqual([second, third]);
    const after = await cards.mcpRead.getCard(second, { since: before.changeToken as string }, null);
    expect(after).toMatchObject({ unchanged: false, card: { dependsOn: [{ id: first, status: "done", met: true }] } });
    const edited = await cards.updateUnstartedCard({ ...actor, cardId: second, dependsOn: [], idempotencyKey: key() }, authorize);
    expect(edited.changed_fields).toContain("depends_on");
    expect((await cards.getCard(second))!.card).not.toHaveProperty("dependsOn");
  });

  it("counts review only when the setting is enabled", async () => {
    const make = async (title: string, dependsOn?: string[]) => (await cards.createCard({ ...actor,
      folderId: "dependencies", title, request: "", queue: true, assignee: { kind: "agent", agentId: "dev" },
      idempotencyKey: key(), dependsOn })).operation.target_id;
    const first = await make("검수 선행");
    const second = await make("검수 뒤", [first]);
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, cardId: first, status: "review" });
    expect((await queue.queued()).map(card => card.id)).not.toContain(second);
    await h.sql`UPDATE system_settings SET value=value || '{"reviewMeetsDependency":true}'::jsonb WHERE setting_key='card_dispatch'`;
    expect((await queue.queued()).map(card => card.id)).toContain(second);
    expect((await cards.getCard(second))!.card).toMatchObject({ dependsOn: [{ id: first, status: "review", met: true }] });
    await h.sql`UPDATE system_settings SET value=value - 'reviewMeetsDependency' WHERE setting_key='card_dispatch'`;
  });

  it("hides inaccessible predecessors on every MCP read and rejects inaccessible writes", async () => {
    await h.sql`INSERT INTO folders(id,name) VALUES('dependency-private','비공개')`;
    const hidden = (await cards.createCard({ ...actor, folderId:"dependency-private", title:"비공개 선행", request:"",
      assignee:{kind:"agent",agentId:"dev"}, idempotencyKey:key() })).operation.target_id;
    const visible = (await cards.createCard({ ...actor, folderId:"dependencies", title:"제한 조회", request:"",
      assignee:{kind:"agent",agentId:"dev"}, dependsOn:[hidden], idempotencyKey:key() })).operation.target_id;
    const allowed = ["dependencies"];
    const sql = createFolderContentSqlAdapter(h.liveSql);
    expect((await readCardDependencies(sql,[visible],allowed)).has(visible)).toBe(false);
    expect((await cards.getCard(visible,allowed))!.card).not.toHaveProperty("dependsOn");
    expect((await cards.getFolder("dependencies",true,allowed))!.cards.find(card => card.id === visible)).not.toHaveProperty("dependsOn");
    expect((await cards.listPagedCards({folderId:"dependencies",includeClosed:true,allowedFolderIds:allowed,limit:50})).cards
      .find(card => card.id === visible)).not.toHaveProperty("dependsOn");
    const options = {cardServiceProvider:async()=>cards,provider:{listFolders:async()=>[{id:"dependencies"},{id:"dependency-private"}]}} as never;
    const access = () => ({restricted:true,allowedFolderIds:allowed});
    const rest = await listCardRouteBody(options,{folderId:"dependencies"},access);
    expect(rest.cards.find(card=>card.id===visible)).not.toHaveProperty("dependsOn");
    const detail = await readCardRouteBody(options,visible,access) as {card:Record<string,unknown>};
    expect(detail.card).not.toHaveProperty("dependsOn");
    const folder = await readFolderSnapshot(cards,"dependencies",undefined,"full",true,{allowedFolderIds:allowed});
    expect(folder.cards.find(card=>card.id===visible)).not.toHaveProperty("dependsOn");
    expect((await cards.mcpRead.getCard(visible,{},allowed)).card).not.toHaveProperty("dependsOn");
    for (const input of [{ folder_id:"dependencies" }, { query:"제한 조회" }]) {
      const list = await cards.mcpRead.listCards(input,allowed);
      expect(list.cards.find(card => card.id === visible)).not.toHaveProperty("dependsOn");
    }
    const restricted = await cards.mcpRead.getCard(visible,{},allowed);
    await cards.setCardStatus({ actorKind:"user",actorSessionId:null,cardId:hidden,status:"done" });
    expect(await cards.mcpRead.getCard(visible,{since:restricted.changeToken},allowed)).toMatchObject({unchanged:true});
    await expect(sql.begin(tx => replaceCardDependencies(tx,visible,[hidden],allowed)))
      .rejects.toMatchObject({statusCode:422,message:`선행 카드 ${hidden}을 찾을 수 없습니다`});
    const number = (await cards.getCard(hidden))!.card.number;
    await expect(cards.createCard({ ...actor,folderId:"dependencies",title:"차단",request:"",assignee:{kind:"agent",agentId:"dev"},
      dependsOn:[`#${number}`],allowedFolderIds:allowed,idempotencyKey:key() }))
      .rejects.toMatchObject({statusCode:422,message:`선행 카드 #${number}을 찾을 수 없습니다`});
    await expect(mutateCardRouteBody(options,"create_card",undefined,{folderId:"dependencies",title:"차단",request:"",dependsOn:[`#${number}`],
      assignee:{kind:"agent",agentId:"dev"},idempotencyKey:key()},access,()=>actor))
      .rejects.toMatchObject({statusCode:422,message:`선행 카드 #${number}을 찾을 수 없습니다`});
    await expect(cards.updateUnstartedCard({ ...actor,cardId:visible,dependsOn:[`#${number}`],allowedFolderIds:allowed,idempotencyKey:key() },authorize))
      .rejects.toMatchObject({statusCode:422,message:`선행 카드 #${number}을 찾을 수 없습니다`});
    expect((await readCardDependencies(sql,[visible],null)).get(visible)).toHaveLength(1);
  });

  it("preserves omitted dispatch settings when updating either switch or concurrency", async () => {
    const sql = createFolderContentSqlAdapter(h.liveSql);
    const before = await readCardDispatchSettings(sql);
    expect(typeof before.version).toBe("number");
    const switched = await updateCardDispatchSettings(sql, { reviewMeetsDependency: true,
      startReleasedDependents: true, expectedVersion: before.version, updatedBy: "director" });
    expect(switched).toMatchObject({ nodeConcurrency: { default: 0 }, reviewMeetsDependency: true, startReleasedDependents: true });
    expect(typeof switched.version).toBe("number");
    const changed = await updateCardDispatchSettings(sql, { nodeConcurrency: { default: 2 }, expectedVersion: switched.version, updatedBy: "director" });
    expect(changed).toMatchObject({ nodeConcurrency: { default: 2 }, reviewMeetsDependency: true, startReleasedDependents: true });
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":0}}' WHERE setting_key='card_dispatch'`;
  });

  it("rejects self references, cycles, cancelled predecessors and more than ten predecessors", async () => {
    const make = async (title: string, dependsOn?: string[]) => (await cards.createCard({ ...actor,
      folderId: "dependencies", title, request: "", assignee: { kind: "agent", agentId: "dev" },
      idempotencyKey: key(), dependsOn })).operation.target_id;
    const first = await make("순환 앞");
    const second = await make("순환 뒤", [first]);
    await expect(cards.updateUnstartedCard({ ...actor, cardId: first, dependsOn: [first], idempotencyKey: key() }, authorize))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(cards.updateUnstartedCard({ ...actor, cardId: first, dependsOn: [second], idempotencyKey: key() }, authorize))
      .rejects.toMatchObject({ statusCode: 409, code: "CARD_DEPENDENCY_CYCLE" });
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, cardId: first, status: "cancelled" });
    await expect(make("취소 선행", [first])).rejects.toMatchObject({ statusCode: 422 });
    await expect(make("너무 많음", Array.from({ length: 11 }, () => second))).rejects.toMatchObject({ statusCode: 422 });
    expect((await cards.getCard(second))!.card).toMatchObject({ dependsOn: [{ id: first, status: "cancelled", met: false }] });
  });

  it("keeps a dependent waiting when its unfinished predecessor is archived", async () => {
    const make = async (title: string, dependsOn?: string[]) => (await cards.createCard({ ...actor,
      folderId: "dependencies", title, request: "", queue: true, assignee: { kind: "agent", agentId: "dev" },
      idempotencyKey: key(), dependsOn })).operation.target_id;
    const first = await make("보관 선행");
    const second = await make("보관 뒤", [first]);
    await cards.patchCard({ actorKind: "user", actorSessionId: null, cardId: first, archived: true });
    expect((await queue.queued()).map(card => card.id)).not.toContain(second);
    expect((await cards.getCard(second))!.card).toMatchObject({ dependsOn: [{ id: first, archived: true, met: false }] });
    const cancelled = await make("취소 선행");
    const follower = await make("취소 뒤", [cancelled]);
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, cardId: cancelled, status: "cancelled" });
    expect((await queue.queued()).map(card => card.id)).not.toContain(follower);
    expect((await cards.getCard(follower))!.card).toMatchObject({ dependsOn: [{ id: cancelled, status: "cancelled", met: false }] });
  });

  it("moves incoming and outgoing dependencies during merge and rejects a resulting cycle", async () => {
    const make = async (title: string, dependsOn?: string[]) => (await cards.createCard({ ...actor,
      folderId: "dependencies", title, request: "", assignee: { kind: "agent", agentId: "dev" },
      idempotencyKey: key(), dependsOn })).operation.target_id;
    const first = await make("합치기 선행");
    const source = await make("합칠 원본", [first]);
    const target = await make("합칠 대상");
    const follower = await make("합친 뒤", [source]);
    await cards.mergeCards({ ...actor, targetCardId: target, sourceCardIds: [source], idempotencyKey: key() }, authorize);
    expect((await cards.getCard(target))!.card).toMatchObject({ dependsOn: [{ id: first }] });
    expect((await cards.getCard(follower))!.card).toMatchObject({ dependsOn: [{ id: target }] });
    const a = await make("순환 합치기 A");
    const b = await make("순환 합치기 B", [a]);
    const c = await make("순환 합치기 C", [b]);
    await expect(cards.mergeCards({ ...actor, targetCardId: a, sourceCardIds: [c], idempotencyKey: key() }, authorize))
      .rejects.toMatchObject({ statusCode: 409, code: "CARD_DEPENDENCY_CYCLE" });
    expect((await cards.getCard(c))!.card.status).toBe("todo");
    const predecessors: string[] = [];
    for (let index = 0; index < 11; index++) predecessors.push(await make(`상한 선행 ${index}`));
    const full = await make("상한 대상", predecessors.slice(0, 10));
    const extra = await make("상한 원본", predecessors.slice(10));
    await expect(cards.mergeCards({ ...actor, targetCardId: full, sourceCardIds: [extra], idempotencyKey: key() }, authorize))
      .rejects.toMatchObject({ statusCode: 422 });
    expect((await cards.getCard(extra))!.card.status).toBe("todo");
  });

  it("rechecks the ordinary queue immediately after the predecessor is done", async () => {
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":0}}' WHERE setting_key='card_dispatch'`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    const ids = new Set<string>();
    const scoped = Object.create(queue) as CardDispatchRepository;
    scoped.queued = async () => (await queue.queued()).filter(card => ids.has(card.id));
    let dispatcher: CardDispatcher;
    const liveCards = new CardControlPlaneService(sql,{appendEventTx:appendCardEventTx},undefined,change => dispatcher.acceptMutation(change));
    const launch = vi.fn(async (input: {sessionId:string;cardId:string;nodeId:string;agentId:string;modelPreset:string|null;prompt:string}) => {
      await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,status,model_preset)
        VALUES(${input.sessionId},${input.cardId},${input.nodeId},${input.agentId},'running',${input.modelPreset})`;
    });
    dispatcher = new CardDispatcher({repository:scoped,cards:async()=>liveCards,defaultNodeId:"node",
      resolveTarget:card=>({nodeId:"node",agentId:card.assignee_agent_id!,modelPreset:"test",available:true,reason:null}),
      launch,sendMessage:async()=>{},deliveryExists:async()=>false,abandonDelivery:async()=>{},notify:async()=>{},warn:message=>{throw new Error(message);} });
    const make = async (title:string,dependsOn?:string[]) => (await liveCards.createCard({...actor,folderId:"dependencies",title,request:"",
      queue:true,assignee:{kind:"agent",agentId:"dev"},idempotencyKey:key(),dependsOn})).operation.target_id;
    const first = await make("기본 선행"); ids.add(first);
    const second = await make("기본 뒤",[first]); ids.add(second);
    await dispatcher.drain();
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":1}}' WHERE setting_key='card_dispatch'`;
    await liveCards.setCardStatus({actorKind:"user",actorSessionId:null,cardId:first,status:"done"});
    await dispatcher.drain();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({cardId:second});
    expect(launch.mock.calls[0]![0].prompt).toContain("기본 선행(완료)");
    await h.sql`UPDATE sessions SET status='completed' WHERE session_id=${launch.mock.calls[0]![0].sessionId}`;
  },60000);

  it("includes predecessor status in a centrally admitted card prompt", async () => {
    const first = (await cards.createCard({...actor,folderId:"dependencies",title:"중앙 선행",request:"",
      assignee:{kind:"agent",agentId:"dev"},idempotencyKey:key()})).operation.target_id;
    const second = (await cards.createCard({...actor,folderId:"dependencies",title:"중앙 뒤",request:"",queue:true,
      assignee:{kind:"agent",agentId:"dev"},dependsOn:[first],idempotencyKey:key()})).operation.target_id;
    const card = (await cards.getCard(second))!.card;
    const target = {nodeId:"node",agentId:"dev",modelPreset:"test",available:true,reason:null};
    const run = {id:"decision",lease_token:"lease",policy_version:1,state:"decided",target,
      snapshot:[{cardId:second,cardVersion:card.version,folderName:"선행 시험"}],
      decision:{decisions:[{cardId:second,cardVersion:card.version,action:"run",reason:"준비"}]}};
    let active = true;
    const admit = vi.fn(async(_input:unknown)=>{});
    const repository = {pendingWorkers:async()=>[],active:async()=>active?run:null,claim:async()=>run,
      finish:async()=>{active=false;},note:async()=>{}};
    const coordinator = new CardOrchestrationCoordinator({repository:repository as never,
      cards:async()=>({getCard:(id:string)=>cards.getCard(id),recordDispatch:admit}) as never,
      dispatch:{running:async()=>[]} as never,
      settings:async()=>({version:1,policy:{enabled:active,candidates:[]}}) as never,
      resolveTarget:()=>target,selectOrchestrator:async()=>({candidate:target,reason:null}) as never,
      ensureFolder:async()=>"dependencies",launchDecision:async()=>{},launchWorker:async()=>{},sendMessage:async()=>{},
      warn:message=>{throw new Error(message);} });
    await coordinator.kick();
    expect(admit).toHaveBeenCalledOnce();
    expect(admit.mock.calls[0]![0]).toMatchObject({admission:{workerInput:{prompt:expect.stringContaining("중앙 선행(할 일)")}}});
  },60000);

  it("includes unfinished predecessors when run_card starts a card manually", async () => {
    const db = await createPagePostgresHarness();
    let runtime: Awaited<ReturnType<typeof createCardDispatchRuntime>> | undefined;
    try {
      await prepareCardWorkSchema(db);
      await db.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
      await db.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql",import.meta.url),"utf8"));
      await db.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":0}}','test')`;
      await db.sql`INSERT INTO folders(id,name) VALUES('manual-deps','수동')`;
      const sql = createFolderContentSqlAdapter(db.liveSql);
      const localCards = new CardControlPlaneService(sql,{appendEventTx:appendCardEventTx});
      const first = (await localCards.createCard({actorKind:"user",actorSessionId:null,folderId:"manual-deps",title:"수동 선행",request:""})).operation.target_id;
      const second = (await localCards.createCard({actorKind:"user",actorSessionId:null,folderId:"manual-deps",title:"수동 뒤",request:"",
        assignee:{kind:"agent",agentId:"dev"},nodeId:"node",modelPreset:"test",dependsOn:[first]})).operation.target_id;
      const owner = "director@example.test";
      const findUserByEmail = async(email:string)=>email===owner?{email,isAdmin:true,allowedFolderIds:[]}:null;
      const repository = new CardDispatchRepository(async()=>sql);
      const resolveSessionOwner = createSessionOwnerResolver({getSession:async id=>(await db.sql`SELECT * FROM sessions WHERE session_id=${id}`)[0]??null,
        findUserByEmail,findExternalAgent:async()=>null,findCardExecutionUser:id=>repository.cardExecutionActorUser(id)});
      const createSession = vi.fn((payload:any)=>({node:{nodeId:"node"},command:{payload},modelPresetId:"test"}));
      const bridge = {sendPendingCommand:async(routed:any)=>{
        const payload=routed.command.payload;
        await db.sql`INSERT INTO sessions(session_id,node_id,agent_id,status,card_id,folder_id,model_preset,metadata)
          VALUES(${payload.agentSessionId},'node','dev','initializing',${payload.cardId},'manual-deps','test',${db.sql.json([])})`;
        await recordWorkReceipt(db,payload.agentSessionId,"running",{registrationId:`reg-${payload.agentSessionId}`,executionCommandId:`cmd-${payload.agentSessionId}`});
        return {type:"session_created",agentSessionId:payload.agentSessionId,status:"ok"};
      }};
      runtime = await createCardDispatchRuntime({defaultExecutionNodeId:"node",sqlResolver:{resolveSql:async()=>db.liveSql,close:async()=>{}},
        router:{selectNodeForCreate:()=>({nodeId:"node",profileId:"dev",modelPresetId:"test"}),createSession,
          routeExistingSessionPendingCommand:async()=>({}),waitForCreatedSession:async()=>true} as any,
        bridge:bridge as any,availability:{resolveForNode:()=>({available:true}),requireAvailable:()=>{}} as any,
        notifier:{} as any,admin:{} as any,broadcaster:{append:()=>{}} as any,warn:()=>{},onFolderHeaderUpdated:async()=>{},
        usageSnapshot:()=>({}) as any,ensureSystemFolder:async()=>{},validateFolder:async()=>true,resolveSessionOwner,findUserByEmail});
      const execution = await runtime.executionServiceProvider();
      await execution.execute({actorKind:"user",actorSessionId:null,actorUserId:owner,cardId:second,expectedVersion:1,idempotencyKey:key()});
      expect(createSession.mock.calls[0]![0].prompt).toContain("수동 선행(할 일)");
    } finally {
      await runtime?.dispatcher.drain();
      await db.cleanup();
    }
  },60000);

  it.each([
    { enabled: false, central: false, starts: false },
    { enabled: true, central: false, starts: true },
    { enabled: true, central: true, starts: false },
  ])("starts released cards at zero capacity only with immediate start and no central dispatcher: $enabled/$central", async ({ enabled, central, starts }) => {
    await h.sql`UPDATE system_settings SET value=${h.sql.json({ nodeConcurrency: { default: 0 }, startReleasedDependents: enabled })} WHERE setting_key='card_dispatch'`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    let dispatcher: CardDispatcher;
    const liveCards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined,
      change => dispatcher.acceptMutation(change));
    const launch = vi.fn(async (input: { sessionId: string; cardId: string; nodeId: string; agentId: string; modelPreset: string | null; prompt: string }) => {
      await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,status,model_preset)
        VALUES(${input.sessionId},${input.cardId},${input.nodeId},${input.agentId},'running',${input.modelPreset})`;
    });
    dispatcher = new CardDispatcher({ repository: queue, cards: async () => liveCards, defaultNodeId: "node",
      resolveTarget: card => ({ nodeId: "node", agentId: card.assignee_agent_id!, modelPreset: "test", available: true, reason: null }),
      launch, sendMessage: async () => {}, deliveryExists: async () => false, abandonDelivery: async () => {},
      notify: async () => {}, warn: message => { throw new Error(message); },
      orchestration: { enabled: async () => central, kick: async () => {}, ownsSession: async () => false } });
    const make = async (title: string, dependsOn?: string[]) => (await liveCards.createCard({ ...actor,
      folderId: "dependencies", title, request: "", queue: true, assignee: { kind: "agent", agentId: "dev" },
      idempotencyKey: key(), dependsOn })).operation.target_id;
    const first = await make("즉시 선행");
    const second = await make("즉시 뒤", [first]);
    await dispatcher.drain();
    await liveCards.setCardStatus({ actorKind: "user", actorSessionId: null, cardId: first, status: "done" });
    await dispatcher.drain();
    expect((await liveCards.getCard(second))!.card.status).toBe(starts ? "running" : "queued");
    expect(launch).toHaveBeenCalledTimes(starts ? 1 : 0);
    if (starts) {
      const number = (await liveCards.getCard(first))!.card.number;
      expect(launch.mock.calls[0]![0].prompt).toContain(`선행 카드: #${number} 즉시 선행(완료)`);
    }
  });
});

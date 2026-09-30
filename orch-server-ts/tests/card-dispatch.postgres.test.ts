import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { buildCardPrompt } from "../src/cards/card_prompt.js";
import { readCardDispatchSettings, updateCardDispatchSettings } from "../src/cards/card_dispatch_settings.js";
import { registerCardDispatchSettingsRoutes } from "../src/cards/card_dispatch_settings_routes.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { PushNotifier, SessionForegroundObserverTracker } from "../src/push/push_notifier.js";
import { RecurringJobScheduler } from "../src/recurring-jobs/scheduler.js";
import type { RecurringJobService } from "../src/recurring-jobs/service.js";
import type { RecurringJobRepository } from "../src/recurring-jobs/types.js";

// Reuses the disposable DB harness and event append pattern of cards-workflow.
describe("card dispatch and session lifecycle", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  let repo: CardDispatchRepository;
  let sequence = 0;
  let available = true;
  const messages = vi.fn(async (_sessionId: string, _text: string) => {});
  const notify = vi.fn(async (_input: unknown) => {});
  const warn = vi.fn();
  const launch = vi.fn(async (input: { sessionId: string; cardId: string; nodeId: string; agentId: string; modelPreset: string | null }) => {
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,agent_id,status,model_preset)
      VALUES(${input.sessionId},${input.cardId},${input.nodeId},${input.agentId},'running',${input.modelPreset})`;
  });
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const key = () => `dispatch:${++sequence}`;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('dispatch-folder','실험')`;
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN termination_reason TEXT, ADD COLUMN termination_event_id INTEGER`;
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":1}}','migration')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    repo = new CardDispatchRepository(sql);
    cards = new CardControlPlaneService(sql, { appendEventTx: async (tx,p) => {
      const rows=await tx<{ id:number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ repository: repo, cards: async () => cards,
      resolveTarget: card => ({ nodeId: card.node_id ?? 'eiaserinnys', agentId: card.assignee_agent_id!, modelPreset: card.model_preset ?? 'default-model',
        available, reason: available ? null : '사용량 제한' }), launch, sendMessage: messages, notify, warn });
  }, 60_000);
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`DELETE FROM card_questions`;
    await h.sql`DELETE FROM card_reports`;
    await h.sql`DELETE FROM folder_operations`;
    await h.sql`DELETE FROM cards`;
    await h.sql`DELETE FROM sessions`;
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":1}}',version=1`;
    messages.mockClear(); notify.mockClear(); launch.mockClear(); warn.mockClear(); available=true;
  });
  async function make(title: string, queue = false) {
    const result=await cards.createCard({ ...human,folderId:'dispatch-folder',title,request:'수행',queue,
      assignee:{kind:'agent',agentId:'roselin'},idempotencyKey:key() });
    await dispatcher.drain();
    return result.operation.target_id;
  }
  async function start() { const id=await make('작업',true); return { id, sessionId:String((await cards.getCard(id))!.sessions[0]!.session_id) }; }
  async function terminal(sessionId: string, reason: string | null = null) {
    await h.sql`UPDATE sessions SET status=${reason ? 'error' : 'completed'},termination_reason=${reason},termination_event_id=1 WHERE session_id=${sessionId}`;
    await dispatcher.sessionEnded(sessionId);
    await dispatcher.drain();
  }
  it("launches only the first of two queued cards at node concurrency one", async () => {
    const first=await make('첫'); const second=await make('둘째');
    await h.sql`INSERT INTO sessions(session_id,card_id,node_id,status) VALUES ('human-session',${first},'eiaserinnys','running')`;
    await cards.setCardStatus({ ...human,cardId:first,status:'queued',idempotencyKey:key() });
    await cards.setCardStatus({ ...human,cardId:second,status:'queued',idempotencyKey:key() });
    await dispatcher.drain();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toMatchObject({cardId:first,agentId:'roselin',nodeId:'eiaserinnys'});
    expect((await cards.getCard(first))!.card.status).toBe('running');
    expect((await cards.getCard(second))!.card.status).toBe('queued');
  });
  it("blocks a running card with no_report when its session ends without a report and frees the slot", async () => {
    const {id,sessionId}=await start(); const next=await make('次',true);
    await terminal(sessionId);
    expect((await cards.getCard(id))!.card).toMatchObject({status:'blocked',blocked_kind:'no_report',blocked_detail:'세션이 보고 없이 끝남'});
    expect((await cards.getCard(next))!.card.status).toBe('running');
  });
  it("sends the answered question to its session and keeps the card running", async () => {
    const {id,sessionId}=await start();
    await cards.askQuestion({actorKind:'agent',actorSessionId:sessionId,cardId:id,text:'진행?',idempotencyKey:key()});
    await dispatcher.drain();
    await terminal(sessionId); // A completed question turn stays blocked until answered.
    await h.sql`UPDATE sessions SET status='idle' WHERE session_id=${sessionId}`;
    const q=(await cards.getCard(id))!.questions[0]!;
    await cards.answerQuestion({...human,cardId:id,questionId:String(q.id),answer:'진행',idempotencyKey:key()});
    await dispatcher.drain();
    expect(messages).toHaveBeenCalledWith(sessionId,'질문에 답이 왔다: 진행? → 진행. 이어서 진행한다.');
    expect((await cards.getCard(id))!.card.status).toBe('running');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({kind:'question',title:'작업',question:'진행?'}));
  });
  it("resumes a rejected review or requeues a finished session and requires a reason", async () => {
    const {id,sessionId}=await start();
    await cards.addReport({...human,cardId:id,title:'보고',format:'markdown',body:'증거',idempotencyKey:key()});
    await cards.setCardStatus({...human,cardId:id,status:'review',idempotencyKey:key()}); await dispatcher.drain();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({kind:'review',title:'작업'}));
    await expect(cards.setCardStatus({...human,cardId:id,status:'running',idempotencyKey:key()})).rejects.toThrow(/reason|사유/);
    await cards.setCardStatus({...human,cardId:id,status:'running',reason:'수정',idempotencyKey:key()}); await dispatcher.drain();
    expect(messages).toHaveBeenCalledWith(sessionId,'검수 반려: 수정. 고친 뒤 새 보고를 올리고 다시 검수를 요청한다.');
    await cards.setCardStatus({...human,cardId:id,status:'review',idempotencyKey:key()}); await dispatcher.drain();
    await terminal(sessionId);
    available=false;
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":0}}'`;
    await cards.setCardStatus({...human,cardId:id,status:'running',reason:'재작업',idempotencyKey:key()}); await dispatcher.drain();
    expect((await cards.getCard(id))!.card.status).toBe('queued');
  });
  it("requeues answered questions from finished sessions and includes the answer in the next prompt", async () => {
    const {id,sessionId}=await start();
    await cards.askQuestion({actorKind:'agent',actorSessionId:sessionId,cardId:id,text:'방향?',idempotencyKey:key()}); await dispatcher.drain();
    await terminal(sessionId);
    const q=(await cards.getCard(id))!.questions[0]!;
    await cards.answerQuestion({...human,cardId:id,questionId:String(q.id),answer:'A',idempotencyKey:key()}); await dispatcher.drain();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]![0]).toHaveProperty('prompt',expect.stringContaining('방향? → A'));
  });
  it("blocks unavailable presets and resumes the same limit-hit session when available", async () => {
    available=false; const id=await make('한도',true);
    expect((await cards.getCard(id))!.card).toMatchObject({status:'blocked',blocked_kind:'limit'});
    expect(launch).not.toHaveBeenCalled();
    available=true; await dispatcher.checkLimits(); await dispatcher.drain();
    const sessionId=String((await cards.getCard(id))!.sessions[0]!.session_id);
    available=false; await terminal(sessionId,'limit_hit');
    expect((await cards.getCard(id))!.card.blocked_kind).toBe('limit');
    available=true; await dispatcher.checkLimits(); await dispatcher.drain();
    expect(messages).toHaveBeenCalledWith(sessionId,'한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다. 이어서 카드 규칙대로 진행한다.');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("skips human or missing assignees and honors node-specific zero capacity", async () => {
    const id=await make('담당');
    await cards.patchCard({...human,cardId:id,assignee:{kind:'human'},idempotencyKey:key()});
    await cards.setCardStatus({...human,cardId:id,status:'queued',idempotencyKey:key()}); await dispatcher.drain();
    expect((await cards.getCard(id))!.card).toMatchObject({status:'queued',blocked_detail:'담당 에이전트 없음'});
    expect(launch).not.toHaveBeenCalled();
    await h.sql`UPDATE system_settings SET value='{"nodeConcurrency":{"default":1,"eiaserinnys":0}}'`;
    const next=await make('상한',true); expect((await cards.getCard(next))!.card.status).toBe('queued');
  });
  it("returns 409 for a stale settings PUT and rejects negative or fractional concurrency", async () => {
    const sql=createBoardYjsSqlAdapter(h.liveSql); const app=Fastify();
    registerCardDispatchSettingsRoutes(app,{currentEmail:()=>human.actorUserId,isAdminEmail:()=>true,
      get:()=>readCardDispatchSettings(sql),put:input=>updateCardDispatchSettings(sql,input)});
    try {
      const settings=(await app.inject({method:'GET',url:'/api/settings/card-dispatch'})).json();
      expect(settings.settings.nodeConcurrency).toEqual({default:1});
      const payload={nodeConcurrency:{default:2},expectedVersion:1};
      expect((await app.inject({method:'PUT',url:'/api/settings/card-dispatch',payload})).statusCode).toBe(200);
      expect((await app.inject({method:'PUT',url:'/api/settings/card-dispatch',payload})).statusCode).toBe(409);
      for (const value of [-1,0.5]) expect((await app.inject({method:'PUT',url:'/api/settings/card-dispatch',payload:{nodeConcurrency:{default:value},expectedVersion:2}})).statusCode).toBe(422);
    } finally {await app.close();}
  });
  it("accepts the agent question HTTP contract and returns 201 without replaying the alert", async () => {
    const {id,sessionId}=await start(); const app=Fastify();
    registerCardRoutes(app,{cardServiceProvider:async()=>cards,provider:{listFolders:()=>[{id:'dispatch-folder'}],listSessionAssignments:()=>({})},
      accessProvider:{resolveAccess:()=>({restricted:false,allowedFolderIds:[]})},authBearerToken:'test',environment:'production'});
    try {
      const request={method:'POST' as const,url:`/api/cards/${id}/questions`,headers:{'x-soulstream-agent-session-id':sessionId,authorization:'Bearer test'},
        payload:{text:'허용?',options:['예'],idempotencyKey:key()}};
      expect((await app.inject(request)).statusCode).toBe(201); await dispatcher.drain();
      expect((await app.inject(request)).statusCode).toBe(201); await dispatcher.drain();
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {await app.close();}
  });
});

it("assembles the exact card execution first prompt", () => {
  expect(buildCardPrompt({cardId:'c1',title:'작업',folderName:'실험',request:'원문',brief:'경과',reason:'검증 보완',
    running:[{title:'다른 작업',folderName:'개발'}],queued:[{title:'다음 작업',folderName:'실험'}]})).toMatchSnapshot();
});

it("runs card availability from the existing recurring scheduler tick", async () => {
  const onTick=vi.fn();
  const scheduler=new RecurringJobScheduler({service:{} as RecurringJobService,
    repository:{listDueJobs:async()=>[],listActiveRuns:async()=>[]} as unknown as RecurringJobRepository,onTick});
  await scheduler.tick(); expect(onTick).toHaveBeenCalledOnce(); await scheduler.stop();
});

it("reuses existing push fan-out and folder exclusions for card questions and reviews", async () => {
  const send=vi.fn(async()=>({ok:true,invalidToken:false}));
  const notifier=new PushNotifier({provider:{send},repository:{listTokens:async()=>[{deviceId:'d',expoToken:'token'}]} as never,
    catalog:{findSessionFolderId:()=>undefined,listFolders:()=>[{id:'hidden',settings:{excludeFromNotification:true}}]},
    sessionLookup:()=>undefined,loadSessionReviewState:async()=>undefined,resolveNodeEmail:()=> 'owner@example.com',
    foregroundObservers:new SessionForegroundObserverTracker(),onWarning:vi.fn()});
  await notifier.notifyCard({nodeId:'node',cardId:'c',folderId:'f',title:'카드',kind:'question',question:'질문 본문'});
  await notifier.notifyCard({nodeId:'node',cardId:'c',folderId:'f',title:'카드',kind:'review'});
  await notifier.notifyCard({nodeId:'node',cardId:'c',folderId:'hidden',title:'제외',kind:'review'});
  expect(send).toHaveBeenNthCalledWith(1,'token','카드','질문 본문',expect.objectContaining({cardId:'c',kind:'card_question'}));
  expect(send).toHaveBeenNthCalledWith(2,'token','검수 요청: 카드','검수 요청: 카드',expect.objectContaining({cardId:'c',kind:'card_review'}));
  expect(send).toHaveBeenCalledTimes(2); await notifier.close();
});

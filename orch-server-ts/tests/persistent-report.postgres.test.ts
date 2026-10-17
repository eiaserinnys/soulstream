import { readFileSync } from "node:fs";
import postgres from "postgres";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";
import type { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { intervenePayload } from "../src/session/session_action_command_payloads.js";

// Same disposable container and production-schema pattern as PAS settings tests; no external DB URL.
describe("PAS reports on production PostgreSQL schema", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: () => void;
  let reports: PersistentReportService;
  let cards: CardControlPlaneService;
  const publish = vi.fn();
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const entry = (key: string) => ({ key, kind: "ask", title: key, card_numbers: [], context: "맥락", action: "결정", options: ["진행"] });
  beforeAll(async () => {
    const container = startPostgresTestContainer({ user: "pas_report_test", password: "pas_report_test", database: "pas_report_test_db" });
    stop = container.stop;
    const url = `postgres://pas_report_test:pas_report_test@127.0.0.1:${container.port}/pas_report_test_db`;
    // Like page_postgres_harness, keep startup retries out of the service pool.
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      await bootstrap.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    } finally { await bootstrap.end({ timeout: 2 }); }
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES ('report-folder','보고')`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,metadata) VALUES
      ('pas','report-folder','test-node',${sql.json([{type:"persistent_session",value:{enabled:true}}, {type:"other",value:"유지"}])}),
      ('normal','report-folder','test-node','[]')`;
    const adapted = createBoardYjsSqlAdapter(sql as never);
    reports = new PersistentReportService(adapted, publish);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx,p) => {
      const rows = await tx<{id:number}[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, undefined, publish);
  }, 90_000);
  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  it("preserves order, replaces completely, rejects the thirteenth and writes no events", async () => {
    for (let n = 0; n < 12; n++) expect((await reports.put('pas',entry(`r${n}`))).ok).toBe(true);
    const before = await reports.get('pas');
    const rejected = await reports.put('pas',entry('r12'));
    expect(rejected).toMatchObject({ ok:false, errors:[{path:'entries',reason:expect.any(String)}] });
    expect(await reports.get('pas')).toEqual(before);
    await reports.put('pas',{ ...entry('r2'),title:'새 제목',state:'answered',answer:'진행' });
    expect((await reports.get('pas'))[2]).toMatchObject({key:'r2',title:'새 제목',answer:'진행'});
    await reports.put('pas',entry('r2'));
    expect((await reports.get('pas'))[2]).toMatchObject({state:'open',answer:''});
    await reports.remove('pas','r0');
    expect(Number((await sql`SELECT COUNT(*) AS n FROM events`)[0]!.n)).toBe(0);
    const metadata = (await sql`SELECT metadata FROM sessions WHERE session_id='pas'`)[0]!.metadata;
    expect(metadata).toContainEqual({type:'other',value:'유지'});
    await sql`SELECT session_apply_metadata_entry('pas',${JSON.stringify({type:'persistent_generation',value:{number:2}})},'persistent_generation',NOW())`;
    expect((await reports.get('pas')).map(x=>x.key)).toEqual(before.filter(x=>x.key!=='r0').map(x=>x.key));
  });
  it("rejects non-PAS and missing card numbers with paths and current summaries", async () => {
    expect(await reports.put('normal',entry('ordinary'))).toMatchObject({ok:false,code:'NOT_PERSISTENT',entries:[]});
    const before = await reports.get('pas');
    expect(await reports.put('pas',{...entry('bad-card'),card_numbers:[999999]})).toMatchObject({ok:false,errors:[{path:'card_numbers',reason:expect.any(String)}]});
    expect(await reports.get('pas')).toEqual(before);
  });
  it("serializes simultaneous edits without losing different keys", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await Promise.all([reports.put('pas',entry('left')),reports.put('pas',entry('right'))]);
    expect((await reports.get('pas')).map(e=>e.key).sort()).toEqual(['left','right']);
  });
  it("answers one open entry once, passes reply/visible contexts and ignores nonhuman or missing entries", async () => {
    const context = [{key:'persistent_report_reply',content:{key:'left',option:'진행'}}, {key:'persistent_report_visible',content:{key:'left',title:'left'}}];
    const parsed = intervenePayload('pas',{text:'left: 진행',context_items:context});
    expect(parsed).toMatchObject({ok:true,value:{extra_context_items:context}});
    publish.mockClear();
    await reports.acceptReply('pas',context,{source:'browser'});
    expect((await reports.get('pas'))[0]).toMatchObject({state:'answered',answer:'진행'});
    expect(publish).toHaveBeenCalledTimes(1);
    await reports.acceptReply('pas',context,{source:'browser'});
    await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:'gone',option:'진행'}}],{source:'browser'});
    await reports.acceptReply('pas',[context[1]!],{source:'browser'});
    await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:'right',option:'진행'}}],{source:'agent'});
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await reports.get('pas'))[1]!.state).toBe('open');
  });
  it("removes question-bound entries and waits for every linked card to finish", async () => {
    const first=(await cards.createCard({...human,folderId:'report-folder',title:'첫 건',request:''})).operation.target_id;
    const second=(await cards.createCard({...human,folderId:'report-folder',title:'둘째',request:''})).operation.target_id;
    const numbers=(await sql`SELECT number FROM cards WHERE id IN (${first},${second}) ORDER BY number`).map(c=>Number(c.number));
    await reports.put('pas',{...entry('both'),card_numbers:numbers});
    await cards.setCardStatus({...human,cardId:first,status:'done'});
    expect((await reports.get('pas')).some(e=>e.key==='both')).toBe(true);
    await cards.setCardStatus({...human,cardId:second,status:'cancelled'});
    expect((await reports.get('pas')).some(e=>e.key==='both')).toBe(false);
    await cards.askQuestion({...human,cardId:first,text:'판단?'});
    const question=(await cards.getCard(first))!.questions[0]!.id;
    await reports.put('pas',{...entry('question'),question_id:question});
    await cards.answerQuestion({...human,cardId:first,questionId:String(question),answer:'진행'});
    expect((await reports.get('pas')).some(e=>e.key==='question')).toBe(false);

    await sql`UPDATE cards SET assignee_kind='session',assignee_session_id='normal' WHERE id=${first}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'normal',cardId:first,text:'철회할 질문'});
    const withdrawn=(await cards.getCard(first))!.questions.find(q=>q.answer===null)!.id;
    await reports.put('pas',{...entry('withdrawn'),question_id:String(withdrawn)});
    await cards.withdrawQuestion({actorKind:'agent',actorSessionId:'normal',cardId:first,questionId:String(withdrawn),reason:'대화에서 결정됨'});
    expect((await reports.get('pas')).some(e=>e.key==='withdrawn')).toBe(false);
  });
  it("DELETE enforces authenticated access, emits [] and never calls a model", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await reports.put('pas',{...entry('seen'),kind:'see',options:undefined});
    const requireSessionAccess=vi.fn(async ({request}:any)=>{ if(request.headers.authorization!=='Bearer director') throw Object.assign(new Error('인증 필요'),{statusCode:401}); });
    const app=Fastify();
    registerPersistentSessionSettingsRoutes(app,{service:{} as PersistentSessionSettingsService,reports,requireSessionAccess});
    expect((await app.inject({method:'DELETE',url:'/api/persistent-sessions/pas/reports/seen'})).statusCode).toBe(401);
    const result=await app.inject({method:'DELETE',url:'/api/persistent-sessions/pas/reports/seen',headers:{authorization:'Bearer director'}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({persistent_report:[]});
    expect(publish.mock.lastCall?.[0][0]).toMatchObject({persistent_report:[]});
    await app.close();
  });
  it("prunes only when entering done/cancelled or answering a question, not when editing a finished card", async () => {
    const cardId = (await cards.createCard({...human,folderId:'report-folder',title:'내림 호출',request:''})).operation.target_id;
    const prune = vi.spyOn(PersistentReportService.prototype, 'pruneForCard');
    try {
      await cards.setCardStatus({...human,cardId,status:'done'});
      expect(prune).toHaveBeenCalledTimes(1);
      expect(prune).toHaveBeenCalledWith(cardId);
      await cards.setCardStatus({...human,cardId,status:'done'});
      await cards.patchCard({...human,cardId,title:'제목 수정'});
      await cards.patchCard({...human,cardId,archived:true});
      expect(prune).toHaveBeenCalledTimes(1);
      await cards.setCardStatus({...human,cardId,status:'cancelled'});
      expect(prune).toHaveBeenCalledTimes(2);
      await cards.askQuestion({...human,cardId,text:'판단?'});
      expect(prune).toHaveBeenCalledTimes(2);
      const question = (await cards.getCard(cardId))!.questions[0]!.id;
      await cards.answerQuestion({...human,cardId,questionId:String(question),answer:'진행'});
      expect(prune).toHaveBeenCalledTimes(3);
    } finally { prune.mockRestore(); }
  });
  it("keeps a see entry unchanged when a reply context is received", async () => {
    await reports.put('pas',{...entry('see-only'),kind:'see',options:undefined});
    const before=await reports.get('pas');
    publish.mockClear();
    await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:'see-only',option:'확인'}}],{source:'browser'});
    expect(await reports.get('pas')).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });
});

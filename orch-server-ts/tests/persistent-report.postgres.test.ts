import { readFileSync } from "node:fs";
import postgres from "postgres";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportTimelineLine } from "@soulstream/wire-schema/persistent-report";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { mutateCardRouteBody } from "../src/cards/card_route_body.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";
import type { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { intervenePayload } from "../src/session/session_action_command_payloads.js";

// Same disposable container and production-schema pattern as PAS settings tests; no external DB URL.
describe("PAS reports on production PostgreSQL schema", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: () => void;
  let reports: PersistentReportService;
  let cards: CardControlPlaneService;
  let dbPort: ConstructorParameters<typeof CardControlPlaneService>[1];
  let adapted: ReturnType<typeof createFolderContentSqlAdapter>;
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
    adapted = createFolderContentSqlAdapter(sql as never);
    reports = new PersistentReportService(adapted, publish);
    dbPort = { appendEventTx: async (tx: any, p: { sessionId: string; eventType: string; payload: string; searchableText: string; createdAt: Date; dedupeKey?: string | null }) => {
      const rows = await tx<{id:number}[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } };    cards = new CardControlPlaneService(adapted, dbPort, undefined, undefined, publish);
  }, 90_000);
  beforeEach(async()=>{
    await sql`DELETE FROM folder_operations`;await sql`DELETE FROM cards`;
    await sql`UPDATE sessions SET metadata=${sql.json([{type:"persistent_session",value:{enabled:true}},{type:"other",value:"유지"}])} WHERE session_id='pas'`;
    await sql`UPDATE sessions SET metadata='[]' WHERE session_id='normal'`;
  });
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
  it("notifies only changed open puts and keeps the timestamp for identical content", async () => {
    const onPosted = vi.fn();
    const posting = new PersistentReportService(adapted, publish, onPosted);
    const payload = entry('posted');
    expect(await posting.put('pas',payload)).toMatchObject({ok:true,changed:true});
    const first = (await posting.get('pas')).find(e=>e.key==='posted')!;
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(onPosted).toHaveBeenCalledWith({sessionId:'pas',entry:expect.objectContaining({key:'posted',state:'open'})});

    await new Promise(resolve=>setTimeout(resolve,5));
    expect(await posting.put('pas',payload)).toMatchObject({ok:true,changed:false});
    expect((await posting.get('pas')).find(e=>e.key==='posted')!.updated_at).toBe(first.updated_at);
    expect(onPosted).toHaveBeenCalledTimes(1);

    expect(await posting.put('pas',{...payload,context:'수정된 맥락'})).toMatchObject({ok:true,changed:true});
    expect(onPosted).toHaveBeenCalledTimes(2);
    expect(await posting.put('pas',{...entry('answered'),state:'answered',answer:'진행'})).toMatchObject({ok:true,changed:true});
    expect(onPosted).toHaveBeenCalledTimes(2);
    await posting.remove('pas','posted');
    expect(onPosted).toHaveBeenCalledTimes(2);
  });
  it("answers one open entry once, passes reply/visible contexts and ignores nonhuman or missing entries", async () => {
    await reports.put('pas',entry('left'));await reports.put('pas',entry('right'));
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
    await cards.askQuestion({...human,cardId:first,text:'판단?',options:['진행']});
    const question=(await cards.getCard(first))!.questions[0]!.id;
    await reports.put('pas',{...entry('question'),question_id:question});
    await cards.patchCard({...human,cardId:first,title:'질문 카드 제목 변경'});
    expect((await reports.get('pas')).find(e=>e.key==='question')).toMatchObject({key:'question',title:'question',question_id:String(question)});
    expect((await reports.get('pas')).find(e=>e.key==='question')).not.toHaveProperty('card_id');
    expect((await reports.get('pas')).find(e=>e.key==='question')).not.toHaveProperty('card_status');
    await cards.answerQuestion({...human,cardId:first,questionId:String(question),answer:'진행'});
    expect((await reports.get('pas')).some(e=>e.key==='question')).toBe(false);

    await sql`UPDATE cards SET assignee_kind='session',assignee_session_id='normal' WHERE id=${first}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'normal',cardId:first,text:'철회할 질문',options:['진행']});
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
  it("syncs the calculated board after every committed card write",async()=>{
    const cardId=(await cards.createCard({...human,folderId:'report-folder',title:'판 재계산',request:''})).operation.target_id;
    const sync=vi.spyOn(PersistentReportService.prototype,'syncCard');
    try {
      await cards.setCardStatus({...human,cardId,status:'done'});
      await cards.setCardStatus({...human,cardId,status:'done'});
      await cards.patchCard({...human,cardId,title:'제목 수정'});
      await cards.addComment({...human,cardId,body:'기록'});
      expect(sync).toHaveBeenCalledTimes(4);
      expect(sync.mock.calls.every(call=>call.length===1&&call[0]===cardId)).toBe(true);
    }finally{sync.mockRestore();}
  });

  it("closes a question and removes its PAS cq_ entry when a user comment resumes the card", async () => {
    const cardId = (await cards.createCard({
      ...human,folderId:'report-folder',title:'커멘트로 질문 종료',request:'요청',
    })).operation.target_id;
    await sql`UPDATE cards SET assignee_kind='session',assignee_session_id='pas',created_session_id='pas' WHERE id=${cardId}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'pas',cardId,text:'결정이 필요합니다',options:['진행']});
    const questionId = String((await cards.getCard(cardId))!.questions[0]!.id);
    expect(await reports.putQuestion('pas',questionId)).toMatchObject({ok:true});
    expect((await reports.get('pas')).some(row=>row.key===`cq_${questionId}`)).toBe(true);

    await cards.addComment({...human,cardId,body:'이대로 계속해 주세요'});

    expect((await cards.getCard(cardId))!.card).toMatchObject({status:'running',blocked_kind:null,blocked_detail:null});
    expect((await sql`SELECT withdrawn_at,withdrawn_by_session_id,withdrawal_reason FROM card_questions WHERE id=${questionId}`)[0])
      .toMatchObject({withdrawn_at:expect.any(Date),withdrawn_by_session_id:null,
        withdrawal_reason:'사용자가 커멘트로 답해 서버가 닫았습니다'});
    expect((await reports.get('pas')).some(row=>row.key===`cq_${questionId}`)).toBe(false);
    await sql`UPDATE cards SET assignee_kind=NULL,assignee_session_id=NULL WHERE id=${cardId}`;
  });

  it("closes a question and removes its PAS cq_ entry when human session input resumes the card", async () => {
    const cardId = (await cards.createCard({...human,folderId:'report-folder',title:'메시지로 질문 종료',request:'요청'})).operation.target_id;
    await sql`UPDATE cards SET assignee_kind='session',assignee_session_id='pas',created_session_id='pas' WHERE id=${cardId}`;
    await cards.askQuestion({actorKind:'agent',actorSessionId:'pas',cardId,text:'결정이 필요합니다',options:['진행']});
    const detail = (await cards.getCard(cardId))!;
    const questionId = String(detail.questions[0]!.id);
    expect(await reports.putQuestion('pas',questionId)).toMatchObject({ok:true});

    await cards.resumeBlockedCardOnHumanInput({cardId,expectedVersion:detail.card.version});

    expect((await cards.getCard(cardId))!.card).toMatchObject({status:'running',blocked_kind:null,blocked_detail:null});
    expect((await sql`SELECT withdrawn_at,withdrawn_by_session_id,withdrawal_reason FROM card_questions WHERE id=${questionId}`)[0])
      .toMatchObject({withdrawn_at:expect.any(Date),withdrawn_by_session_id:null,
        withdrawal_reason:'사용자 메시지로 작업이 재개되어 서버가 닫았습니다'});
    expect((await reports.get('pas')).some(row=>row.key===`cq_${questionId}`)).toBe(false);
    await sql`UPDATE cards SET assignee_kind=NULL,assignee_session_id=NULL WHERE id=${cardId}`;
  });

  it("preserves open questions across status changes, including completion", async () => {
    const resumeId = (await cards.createCard({...human,folderId:'report-folder',title:'상태 재개 질문',request:''})).operation.target_id;
    await cards.askQuestion({...human,cardId:resumeId,text:'진행할까요?',options:['진행']});
    const resumeQuestion = String((await cards.getCard(resumeId))!.questions[0]!.id);
    await cards.setCardStatus({...human,cardId:resumeId,status:'running'});
    expect((await sql`SELECT withdrawn_at FROM card_questions WHERE id=${resumeQuestion}`)[0]!.withdrawn_at).toBeNull();

    const holdId = (await cards.createCard({...human,folderId:'report-folder',title:'보류 질문',request:''})).operation.target_id;
    await cards.askQuestion({...human,cardId:holdId,text:'보류해도 남을까요?',options:['진행']});
    const holdQuestion = String((await cards.getCard(holdId))!.questions[0]!.id);
    await cards.setCardStatus({...human,cardId:holdId,status:'on_hold'});
    expect((await sql`SELECT withdrawn_at FROM card_questions WHERE id=${holdQuestion}`)[0]!.withdrawn_at).toBeNull();
    await cards.setCardStatus({...human,cardId:holdId,status:'review'});
    expect((await sql`SELECT withdrawn_at FROM card_questions WHERE id=${holdQuestion}`)[0]!.withdrawn_at).toBeNull();
    await cards.setCardStatus({...human,cardId:holdId,status:'done'});
    expect((await sql`SELECT withdrawn_at,withdrawal_reason FROM card_questions WHERE id=${holdQuestion}`)[0])
      .toMatchObject({withdrawn_at:null,withdrawal_reason:null});
  });
  it("keeps one card entry current, swaps it for an open question, and removes it outside review or blocked", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id='pas'`;
    const cardId=(await cards.createCard({actorKind:'agent',actorSessionId:'pas',actorUserId:null,folderId:'report-folder',
      title:'카드 장 동기화',request:'요청',assignee:{kind:'session',sessionId:'pas'}})).operation.target_id;
    await cards.updateCardNow({actorKind:'agent',actorSessionId:'pas',cardId,now:'현재 상황판',turn:'user',ask:'검수해 주세요'});
    await cards.setCardStatus({...human,cardId,status:'review'});
    let board=await reports.get('pas');
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({key:`card_${cardId}`,kind:'see',title:'카드 장 동기화',card_numbers:[(await cards.getCard(cardId))!.card.number],
      context:'검수해 주세요',action:'',options:[],state:'open',answer:'',card_id:cardId,card_status:'review'});

    await cards.updateCardNow({actorKind:'agent',actorSessionId:'pas',cardId,now:'새 상황판',turn:'user',ask:'수정된 검수를 봐 주세요'});
    board=await reports.get('pas');
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({key:`card_${cardId}`,context:'수정된 검수를 봐 주세요',card_status:'review'});

    await cards.askQuestion({actorKind:'agent',actorSessionId:'pas',cardId,text:'진행할까요?',options:['진행','중단']});
    const questionId=String((await cards.getCard(cardId))!.questions[0]!.id);
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    expect((await reports.putQuestion('pas',questionId)).ok).toBe(true);
    expect((await reports.get('pas'))).toMatchObject([{key:`cq_${questionId}`,card_id:cardId,card_status:'blocked'}]);
    await cards.answerQuestion({...human,cardId,questionId,answer:'진행'});
    expect((await reports.get('pas')).some(e=>e.key===`cq_${questionId}`)).toBe(false);

    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).map(e=>e.key)).toEqual([`card_${cardId}`]);
    await cards.setCardStatus({...human,cardId,status:'running'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(true);
    await cards.setCardStatus({...human,cardId,status:'on_hold'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(true);
    await cards.setCardStatus({...human,cardId,status:'done'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(true);
    await cards.setCardStatus({...human,cardId,status:'awaiting_verification',
      wakeAt:new Date(Date.now()+60*60*1000).toISOString(),waitingFor:'배포 확인'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
  });
  it("removes card and question entries from connected and other boards on hold, keeps the question answerable, and restores only the card entry", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id='pas'`;
    await sql`UPDATE cards SET assignee_kind='agent',assignee_agent_id='report-agent',assignee_session_id=NULL WHERE assignee_session_id='pas'`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,metadata,agent_id) VALUES
      ('pas-unrelated-on-hold','report-folder','test-node',${sql.json([{type:"persistent_session",value:{enabled:true}}])},'report-agent')`;
    const cardId=(await cards.createCard({actorKind:'agent',actorSessionId:'pas',actorUserId:null,folderId:'report-folder',
      title:'보류 카드 판 동기화',request:'요청',assignee:{kind:'session',sessionId:'pas'}})).operation.target_id;
    const number=(await cards.getCard(cardId))!.card.number!;
    await cards.setCardStatus({...human,cardId,status:'review'});
    await cards.askQuestion({actorKind:'agent',actorSessionId:'pas',cardId,text:'질문을 남깁니다',options:['진행']});
    const questionId=String((await cards.getCard(cardId))!.questions[0]!.id);
    expect((await reports.putQuestion('pas',questionId)).ok).toBe(true);
    expect((await reports.get('pas')).map(e=>e.key)).toEqual([`cq_${questionId}`]);
    expect((await reports.put('pas-unrelated-on-hold',{...entry('ordinary-card'),card_numbers:[number]})).ok).toBe(true);

    await cards.setCardStatus({...human,cardId,status:'on_hold'});
    expect((await reports.get('pas')).some(e=>e.key===`cq_${questionId}`||e.key===`card_${cardId}`)).toBe(false);
    expect((await reports.get('pas-unrelated-on-hold')).some(e=>e.key==='ordinary-card')).toBe(false);
    expect((await cards.getCard(cardId))!.questions.find(q=>String(q.id)===questionId)).toMatchObject({answer:null});

    await cards.answerQuestion({...human,cardId,questionId,answer:'진행'});
    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).map(e=>e.key)).toEqual([`card_${cardId}`]);
    expect((await reports.get('pas-unrelated-on-hold')).some(e=>e.key==='ordinary-card')).toBe(false);
  });
  it("restores open questions to the supervising PAS after leaving on hold before restoring the card entry", async () => {
    const enabled = [{ type: "persistent_session", value: { enabled: true } }, { type: "caller_info", value: { source: "browser", email: "director@example.com" } }];
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,session_type,metadata) VALUES
      ('hold-owner-a','report-folder','test-node',NULL,${sql.json(enabled)}),
      ('hold-owner-b','report-folder','test-node',NULL,${sql.json(enabled)})`;
    const asked: string[] = [];
    const withBoard = new CardControlPlaneService(adapted, dbPort, undefined, undefined, publish, undefined, undefined, async ({ cardId, questionId }) => {
      asked.push(questionId);
      await reports.placeQuestion(cardId, questionId);
    });
    const cardId = (await withBoard.createCard({ actorKind: "agent", actorSessionId: "hold-owner-a", actorUserId: null,
      folderId: "report-folder", title: "열린 질문 복원", request: "", assignee: { kind: "session", sessionId: "hold-owner-a" } })).operation.target_id;
    await withBoard.updateCardNow({ actorKind: "agent", actorSessionId: "hold-owner-a", cardId, now: "질문을 확인해 주세요", turn: "user", ask: "질문 답을 기다립니다" });
    await withBoard.setCardStatus({ ...human, cardId, status: "review" });
    await withBoard.askQuestion({ actorKind: "agent", actorSessionId: "hold-owner-a", actorUserId: null, cardId, text: "계속할까요?", options: ["진행", "중단"] });
    const questionId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${questionId}`)).toBe(true);

    await withBoard.setCardStatus({ ...human, cardId, status: "on_hold" });
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${questionId}`)).toBe(false);
    await withBoard.setCardStatus({ ...human, cardId, status: "review" });
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${questionId}`)).toBe(true);
    expect(asked).toEqual([questionId]);
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `card_${cardId}`)).toBe(false);
    expect((await reports.get("hold-owner-b")).some(entry => entry.key === `cq_${questionId}` || entry.key === `card_${cardId}`)).toBe(false);

    await withBoard.answerQuestion({ ...human, cardId, questionId, answer: "진행" });
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${questionId}`)).toBe(false);
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `card_${cardId}`)).toBe(true);

    await withBoard.askQuestion({ actorKind: "agent", actorSessionId: "hold-owner-a", actorUserId: null, cardId, text: "두 번째 질문", options: ["진행"] });
    const secondQuestionId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    await withBoard.setCardStatus({ ...human, cardId, status: "on_hold" });
    await withBoard.askQuestion({ actorKind: "agent", actorSessionId: "hold-owner-a", actorUserId: null, cardId, text: "보류 중 질문", options: ["진행"] });
    const heldQuestionId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    expect(asked).toEqual([questionId, secondQuestionId, heldQuestionId]);
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${heldQuestionId}`)).toBe(true);
    await withBoard.setCardStatus({ ...human, cardId, status: "on_hold" });
    await withBoard.setCardStatus({ ...human, cardId, status: "done" });
    expect((await reports.get("hold-owner-a")).some(entry => entry.key === `cq_${secondQuestionId}`)).toBe(false);
    await sql`UPDATE sessions SET metadata=${sql.json([{ type: "other", value: "test cleanup" }])}
      WHERE session_id IN ('hold-owner-a','hold-owner-b')`;
  });
  it("links only persistent creator and operation sessions and rejects PAS-owned keys and card numbers", async () => {
    const enabled=[{type:'persistent_session',value:{enabled:true}}];
    await sql`UPDATE cards SET assignee_kind='agent',assignee_agent_id='report-agent',assignee_session_id=NULL WHERE assignee_session_id='pas'`;
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id='pas'`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,metadata,agent_id) VALUES
      ('pas-unrelated','report-folder','test-node',${sql.json(enabled)},'report-agent')`;
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id='normal'`;
    const creatorCard=(await cards.createCard({actorKind:'agent',actorSessionId:'pas',actorUserId:null,folderId:'report-folder',
      title:'생성 카드',request:'요청'})).operation.target_id;
    const creatorNumber=(await cards.getCard(creatorCard))!.card.number!;
    await cards.setCardStatus({...human,cardId:creatorCard,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${creatorCard}`)).toBe(true);
    expect((await reports.get('pas-unrelated'))).toEqual([]);

    const executeCard=(await cards.createCard({...human,folderId:'report-folder',title:'실행 카드',request:'요청'})).operation.target_id;
    await sql`INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,actor_session_id)
      VALUES(${`pas-sync-execute-${executeCard}`},'report-folder','card',${executeCard},'execute_card','pas')`;
    await cards.setCardStatus({...human,cardId:executeCard,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${executeCard}`)).toBe(true);

    const commentCard=(await cards.createCard({...human,folderId:'report-folder',title:'후속 지시 카드',request:'요청'})).operation.target_id;
    await cards.addComment({actorKind:'agent',actorSessionId:'pas',cardId:commentCard,body:'후속 지시',mode:'spoken'});
    await cards.setCardStatus({...human,cardId:commentCard,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${commentCard}`)).toBe(true);

    const nonpersistent=(await cards.createCard({actorKind:'agent',actorSessionId:'normal',actorUserId:null,folderId:'report-folder',
      title:'일반 세션 카드',request:'요청'})).operation.target_id;
    await cards.setCardStatus({...human,cardId:nonpersistent,status:'review'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${nonpersistent}`)).toBe(false);
    expect((await reports.get('pas-unrelated')).some(e=>e.key===`card_${nonpersistent}`)).toBe(false);

    expect(await reports.put('pas',{...entry('card_reserved'),key:'card_reserved'})).toMatchObject({ok:false,errors:[{path:'key',reason:'서버가 쓰는 key입니다'}]});
    expect(await reports.put('pas',{...entry('cq_reserved'),key:'cq_reserved'})).toMatchObject({ok:false,errors:[{path:'key',reason:'서버가 쓰는 key입니다'}]});
    expect(await reports.put('pas',{...entry('linked-card'),card_numbers:[creatorNumber]}))
      .toMatchObject({ok:false,errors:[{path:'card_numbers',reason:'이 카드는 서버가 판에 올립니다. 담당이 상황판과 카드 질문을 쓰게 하세요'}]});
    const unrelated=(await cards.createCard({...human,folderId:'report-folder',title:'무관한 카드',request:'요청'})).operation.target_id;
    const unrelatedNumber=(await cards.getCard(unrelated))!.card.number!;
    expect((await reports.put('pas',{...entry('unrelated-card'),card_numbers:[unrelatedNumber]})).ok).toBe(true);
  });
  it("links a child card through its assigned parent only when the parent creator is persistent", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id IN ('pas','normal')`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,metadata,agent_id)
      VALUES('pas-child-worker','report-folder','test-node','[]','report-agent'),
        ('nonpersistent-child-worker','report-folder','test-node','[]','report-agent')`;

    const parent=(await cards.createCard({actorKind:'agent',actorSessionId:'pas',actorUserId:null,folderId:'report-folder',
      title:'PAS 부모 카드',request:'요청',assignee:{kind:'session',sessionId:'pas-child-worker'}})).operation.target_id;
    const child=(await cards.createCard({actorKind:'agent',actorSessionId:'pas-child-worker',actorUserId:null,folderId:'report-folder',
      title:'담당 세션의 자식 카드',request:'요청'})).operation.target_id;
    expect(parent).not.toBe(child);
    await cards.setCardStatus({...human,cardId:child,status:'review'});
    const childNumber=(await cards.getCard(child))!.card.number!;
    expect((await reports.get('pas')).some(e=>e.key===`card_${child}`)).toBe(true);
    expect(await reports.put('pas',{...entry('linked-child'),card_numbers:[childNumber]}))
      .toMatchObject({ok:false,errors:[{path:'card_numbers',reason:'이 카드는 서버가 판에 올립니다. 담당이 상황판과 카드 질문을 쓰게 하세요'}]});

    const nonpersistentParent=(await cards.createCard({actorKind:'agent',actorSessionId:'normal',actorUserId:null,folderId:'report-folder',
      title:'일반 세션 부모 카드',request:'요청',assignee:{kind:'session',sessionId:'nonpersistent-child-worker'}})).operation.target_id;
    const nonpersistentChild=(await cards.createCard({actorKind:'agent',actorSessionId:'nonpersistent-child-worker',actorUserId:null,folderId:'report-folder',
      title:'일반 세션의 자식 카드',request:'요청'})).operation.target_id;
    expect(nonpersistentParent).not.toBe(nonpersistentChild);
    await cards.setCardStatus({...human,cardId:nonpersistentChild,status:'review'});
    const boardSessions=await sql<{session_id:string}[]>`SELECT session_id FROM sessions
      WHERE session_type IS DISTINCT FROM 'llm'
        AND metadata @> '[{"type":"persistent_session","value":{"enabled":true}}]'::jsonb`;
    expect(boardSessions.map(row=>row.session_id)).toContain('pas');
    for (const {session_id} of boardSessions)
      expect((await reports.get(session_id)).some(e=>e.key===`card_${nonpersistentChild}`)).toBe(false);
  });
  it("replaces a legacy PAS card entry and respects manual dismissal until the card changes", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    await sql`UPDATE cards SET assignee_kind='agent',assignee_agent_id='report-agent',assignee_session_id=NULL WHERE assignee_session_id='pas'`;
    await sql`UPDATE sessions SET agent_id='report-agent' WHERE session_id='pas'`;
    const cardId=(await cards.createCard({actorKind:'agent',actorSessionId:'pas',actorUserId:null,folderId:'report-folder',
      title:'이행할 카드',request:'요청',assignee:{kind:'session',sessionId:'pas'}})).operation.target_id;
    const cardNumber=(await cards.getCard(cardId))!.card.number!;
    const legacy={...entry('legacy-card-entry'),card_numbers:[cardNumber],state:'open',answer:'',updated_at:new Date().toISOString()};
    await sql`SELECT session_apply_metadata_entry('pas',${JSON.stringify({type:'persistent_report',value:{entries:[legacy]}})},'persistent_report',NOW())`;
    await cards.setCardStatus({...human,cardId,status:'review'});
    expect((await reports.get('pas')).map(e=>e.key)).toEqual([`card_${cardId}`]);

    await reports.remove('pas',`card_${cardId}`);
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    await cards.addComment({...human,cardId,body:'기록만 남깁니다'});
    expect((await reports.get('pas')).some(e=>e.key===`card_${cardId}`)).toBe(false);
    await cards.updateCardNow({actorKind:'agent',actorSessionId:'pas',cardId,now:'상황판 변경',turn:'agent'});
    expect(await reports.get('pas')).toEqual([]);
    await cards.setCardStatus({...human,cardId,status:'blocked',blockedKind:'no_report'});
    expect((await reports.get('pas')).map(e=>e.key)).toEqual([`card_${cardId}`]);
  });
  it("keeps a see entry unchanged when a reply context is received", async () => {
    await reports.put('pas',{...entry('see-only'),kind:'see',options:undefined});
    const before=await reports.get('pas');
    publish.mockClear();
    await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:'see-only',option:'확인'}}],{source:'browser'});
    expect(await reports.get('pas')).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });
  it("places a card question as a cq_ board entry, replaces on resend and keeps it when twelve direct entries fill the board", async () => {
    for (const e of await reports.get('pas')) if(!e.key.startsWith('cq_')) await reports.remove('pas',e.key);
    const cardId=(await cards.createCard({...human,folderId:'report-folder',title:'판 게시',request:''})).operation.target_id;
    await sql`UPDATE cards SET created_session_id='pas' WHERE id=${cardId}`;
    await cards.askQuestion({...human,cardId,text:'게시할 질문',options:['진행','중단']});
    const questionId=String((await cards.getCard(cardId))!.questions.at(-1)!.id);
    expect((await reports.putQuestion('pas',questionId)).ok).toBe(true);
    const placed=(await reports.get('pas')).find(e=>e.key===`cq_${questionId}`)!;
    expect(placed).toMatchObject({kind:'ask',question_id:questionId,options:['진행','중단'],state:'open',answer:'',card_id:cardId,card_status:'blocked'});
    expect(placed.card_numbers).toEqual([(await cards.getCard(cardId))!.card.number]);
    await reports.putQuestion('pas',questionId);
    expect((await reports.get('pas')).filter(e=>e.key===`cq_${questionId}`)).toHaveLength(1);
    for (const e of await reports.get('pas')) if(!e.key.startsWith('cq_')) await reports.remove('pas',e.key);
    for (let n=0;n<12;n++) expect((await reports.put('pas',entry(`fill${n}`))).ok).toBe(true);
    expect(await reports.putQuestion('pas',questionId)).toMatchObject({ok:true});
    expect((await reports.get('pas')).some(e=>e.key===`cq_${questionId}`)).toBe(true);
    expect(await reports.get('pas')).toHaveLength(13);
    expect((await cards.getCard(cardId))!.questions).toHaveLength(1);
  });
  it("clips a long card title and question text with an ellipsis and leaves exact lengths untouched", async () => {
    for (const e of await reports.get('pas')) if(!e.key.startsWith('cq_')) await reports.remove('pas',e.key);
    const placed = async (title: string, text: string) => {
      const cardId=(await cards.createCard({...human,folderId:'report-folder',title,request:''})).operation.target_id;
      await sql`UPDATE cards SET created_session_id='pas' WHERE id=${cardId}`;
    await cards.askQuestion({...human,cardId,text,options:['진행']});
      const questionId=String((await cards.getCard(cardId))!.questions.at(-1)!.id);
      await reports.putQuestion('pas',questionId);
      return (await reports.get('pas')).find(e=>e.key===`cq_${questionId}`)!;
    };
    const longTitle='ㄱ'.repeat(30), longText='나'.repeat(130);
    const clipped=await placed(longTitle,longText);
    expect(clipped.title).toBe([...longTitle].slice(0,23).join('')+'…');
    expect(clipped.context).toBe([...longText].slice(0,119).join('')+'…');
    const exactTitle='다'.repeat(24), exactText='라'.repeat(120);
    const exact=await placed(exactTitle,exactText);
    expect(exact.title).toBe(exactTitle);
    expect(exact.context).toBe(exactText);
    const spaceTitle='ㄱ'.repeat(22)+' '+'ㄴ'.repeat(7);
    const spaced=await placed(spaceTitle,'질문');
    expect(spaced.title).toBe('ㄱ'.repeat(22)+'…');
  });
  it("answers a card question from the board, acknowledges a same-option resend and rejects a conflict or invalid option", async () => {
    for (const e of await reports.get('pas')) await reports.remove('pas',e.key);
    const cardId=(await cards.createCard({...human,folderId:'report-folder',title:'판 답',request:''})).operation.target_id;
    await cards.askQuestion({...human,cardId,text:'답할 질문',options:['진행','중단']});
    const questionId=String((await cards.getCard(cardId))!.questions.at(-1)!.id);
    await reports.putQuestion('pas',questionId);
    const context=[{key:'persistent_report_reply',content:{key:`cq_${questionId}`,option:'진행'}}];
    expect(await reports.acceptReply('pas',context,{source:'browser'})).toEqual({action:'card',cardId,questionId,option:'진행'});
    await mutateCardRouteBody({ cardServiceProvider: async () => cards, provider: { listFolders: async () => [{ id: 'report-folder' }], listSessionAssignments: async () => ({}) } },
      'answer_card_question', cardId, { answer: '진행', idempotencyKey: `report-answer:${questionId}` },
      async () => ({ restricted: false }), async () => ({ actorKind: 'user', actorUserId: 'director@example.com', actorSessionId: null }), questionId);
    expect((await reports.get('pas')).some(e=>e.key===`cq_${questionId}`)).toBe(false);
    expect((await cards.getCard(cardId))!.questions.at(-1)!.answer).toBe('진행');
    expect(Number((await sql`SELECT COUNT(*) AS n FROM card_questions WHERE id=${questionId} AND answered_by='director@example.com'`)[0]!.n)).toBe(1);
    expect(await reports.acceptReply('pas',context,{source:'browser'})).toEqual({action:'card-acked',cardId});
    expect(await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:`cq_${questionId}`,option:'중단'}}],{source:'browser'}))
      .toMatchObject({action:'reject',code:'CARD_QUESTION_CLOSED',status:409});
    const otherId=(await cards.createCard({...human,folderId:'report-folder',title:'판 답2',request:''})).operation.target_id;
    await cards.askQuestion({...human,cardId:otherId,text:'선택지 질문',options:['가','나']});
    const other=String((await cards.getCard(otherId))!.questions.at(-1)!.id);
    await reports.putQuestion('pas',other);
    expect(await reports.acceptReply('pas',[{key:'persistent_report_reply',content:{key:`cq_${other}`,option:'다'}}],{source:'browser'}))
      .toMatchObject({action:'reject',code:'CARD_QUESTION_OPTION_INVALID',status:422});
    expect((await cards.getCard(otherId))!.questions.at(-1)!.answer).toBeNull();
  });
  it("places a new question only on the supervising PAS and projects every open question from the current card facts", async () => {
    const enabled = (email: string) => [{ type: "persistent_session", value: { enabled: true } }, { type: "caller_info", value: { source: "browser", email } }];
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,session_type,metadata) VALUES
      ('owner-a','report-folder','test-node',NULL,${sql.json(enabled('director@example.com'))}),
      ('owner-b','report-folder','test-node',NULL,${sql.json(enabled('director@example.com'))}),
      ('owner-other','report-folder','test-node',NULL,${sql.json(enabled('other@example.com'))}),
      ('owner-llm','report-folder','test-node','llm',${sql.json(enabled('director@example.com'))})`;
    const agent = { actorKind: "agent" as const, actorSessionId: "owner-a", actorUserId: null };
    let placement: Awaited<ReturnType<PersistentReportService["placeQuestion"]>> | undefined;
    const withBoard = new CardControlPlaneService(adapted, dbPort, undefined, undefined, publish, undefined, undefined, async ({ cardId, questionId }) => {
      placement = await reports.placeQuestion(cardId, questionId);
    });
    const cardId = (await withBoard.createCard({ ...agent, folderId: 'report-folder', title: '게시 대상', request: '',
      assignee: { kind: 'session', sessionId: 'owner-a' } })).operation.target_id;
    await cards.askQuestion({ ...human, cardId, text: '이전 질문', options: ['진행'] });
    const oldId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    expect((await reports.get('owner-a')).some(e => e.question_id === oldId)).toBe(true);
    await withBoard.askQuestion({ ...agent, cardId, text: '새 질문', options: ['진행', '중단'] });
    const newId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    expect(newId).not.toBe(oldId);
    expect(placement?.placed).toEqual(['owner-a']);
    expect(placement?.failed).toEqual([]);
    expect(placement?.changed).toEqual([]);
    const repeated = await reports.placeQuestion(cardId, newId);
    expect(repeated.placed).toEqual(['owner-a']);
    expect(repeated.failed).toEqual([]);
    expect(repeated.changed).toEqual([]);
    const placed = (await reports.get('owner-a')).filter(e => e.question_id === newId);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ key: `cq_${newId}`, kind: 'ask', options: ['진행', '중단'] });
    for (const s of ['owner-b', 'owner-other', 'owner-llm'])
      expect((await reports.get(s)).filter(e => e.question_id === newId)).toHaveLength(0);
    expect((await reports.get('owner-a')).some(e => e.question_id === oldId)).toBe(true);
    expect((await withBoard.answerQuestion({ ...human, cardId, questionId: oldId, answer: '진행' })).operation).toBeTruthy();
  });
  it("keeps a question off an unrelated PAS of the same owner and places nothing without a supervising PAS", async () => {
    const enabled = [{ type: "persistent_session", value: { enabled: true } }, { type: "caller_info", value: { source: "browser", email: "director@example.com" } }];
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,session_type,metadata) VALUES
      ('sup-a','report-folder','test-node',NULL,${sql.json(enabled)}),
      ('sup-b','report-folder','test-node',NULL,${sql.json(enabled)})`;
    const timeline: { sessionId: string; line: ReportTimelineLine }[] = [];
    const questionReports = new PersistentReportService(adapted, publish, undefined, async (sessionId, line) => {
      timeline.push({ sessionId, line });
    });
    const withBoard = new CardControlPlaneService(adapted, dbPort, undefined, undefined, publish, undefined, undefined, async ({ cardId, questionId }) => {
      await questionReports.placeQuestion(cardId, questionId);
    });
    const agent = { actorKind: "agent" as const, actorSessionId: "sup-a", actorUserId: null };
    const cardId = (await withBoard.createCard({ ...agent, folderId: 'report-folder', title: '감독 판 질문', request: '',
      assignee: { kind: 'session', sessionId: 'sup-a' } })).operation.target_id;
    await withBoard.askQuestion({ ...agent, cardId, text: '어느 판에 오를까요?', options: ['진행'] });
    const questionId = String((await withBoard.getCard(cardId))!.questions.at(-1)!.id);
    expect((await questionReports.get('sup-a')).map(e => e.key)).toEqual([`cq_${questionId}`]);
    expect((await questionReports.get('sup-b')).some(e => e.key === `cq_${questionId}`)).toBe(false);
    expect(timeline.map(item => item.sessionId)).toEqual(['sup-a']);
    expect(timeline[0]!.line).toMatchObject({ line_key: `card:${cardId}`, status: 'question', card_id: cardId });

    const unsupervized = (await cards.createCard({ ...human, folderId: 'report-folder', title: '감독 없음', request: '' })).operation.target_id;
    await cards.askQuestion({ ...human, cardId: unsupervized, text: '감독 없는 질문', options: ['진행'] });
    const unsupervizedQuestionId = String((await cards.getCard(unsupervized))!.questions.at(-1)!.id);
    expect(await questionReports.placeQuestion(unsupervized, unsupervizedQuestionId)).toEqual({ placed: [], failed: [], changed: [] });
    await sql`UPDATE sessions SET metadata=${sql.json([{ type: "other", value: "test cleanup" }])}
      WHERE session_id IN ('sup-a','sup-b')`;
  });
});

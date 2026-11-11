import {readCardBoardSessions} from "../src/session/card_board_connections.js";
import {cardBoardEntries,dismissalMatches} from "../src/session/card_board_entries.js";
import {readDismissedCards} from "../src/session/persistent_report_service.js";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema } from "./card-work-postgres-fixture.js";
import { appendCardEventTx, recordWorkReceipt } from "./card-work-postgres-fixture.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardExecutionService } from "../src/cards/card_execution_service.js";
import { CardOrchestrationRepository } from "../src/cards/card_orchestration_repository.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import type { CardStatus } from "../src/cards/control_plane/card_types.js";

const human={actorKind:"user" as const,actorSessionId:null,actorUserId:"director"};
const execution={registrationId:"machine-registration",executionCommandId:"machine-command"};
const metadata=(enabled:boolean)=>[{type:"persistent_session",value:{enabled}}];
export async function createCardMachineWorld() {
  const h=await createPagePostgresHarness();
  expect(Number((await h.sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
  await prepareCardWorkSchema(h);
  const schema=await readFile(new URL("../../packages/db-schema/sql/schema.sql",import.meta.url),"utf8");
  const start=schema.indexOf("CREATE OR REPLACE FUNCTION session_apply_metadata_entry(");
  await h.sql.unsafe(schema.slice(start,schema.indexOf("$$;",start)+3));
  await h.sql`INSERT INTO folders(id,name) VALUES('machine','기계 대조')`;
  await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
  await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES('card_dispatch','{"nodeConcurrency":{"default":2}}','test'),('card_orchestration','{"enabled":false}','test')`;
  await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/113_card_orchestration.sql",import.meta.url),"utf8"));
  const sql=createFolderContentSqlAdapter(h.liveSql);
  const reports=new PersistentReportService(sql,()=>{});
  const cards=new CardControlPlaneService(sql,{appendEventTx:appendCardEventTx},undefined,undefined,()=>{},()=>{},[],
    async({cardId,questionId})=>{await reports.placeQuestion(cardId,questionId);});
  const executions=new CardExecutionService({sql,cards,validate:async()=>({nodeId:"node",agentId:"worker",modelPreset:"model"}),launch:async()=>{},ensure:async()=>({state:"already_running",execution})});
  const repo=new CardDispatchRepository(async()=>sql);
  let now=Date.now(),available=false,failSend=false;
  const dispatcher=new CardDispatcher({repository:repo,cards:async()=>cards,
    resolveTarget:()=>({nodeId:"node",agentId:"worker",modelPreset:"model",available,reason:null}),
    launch:async()=>{},sendMessage:async()=>{if(failSend)throw new Error("test transport failure");},notify:async()=>{},
    deliveryExists:async()=>false,abandonDelivery:async()=>{},warn:()=>{},now:()=>now});
  let cardId="",baseOwner="owner",limitedOwner:string|null=null,short=false;
  async function reset() {
    await dispatcher.drain();
    await h.sql`DELETE FROM card_orchestration_dispatches`;await h.sql`DELETE FROM card_orchestration_runs`;await h.sql`DELETE FROM folder_operations`;await h.sql`DELETE FROM cards`;await h.sql`DELETE FROM sessions`;
    for(const id of ["pas","owner","replacement","other"]) await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status,metadata)
      VALUES(${id},'node','worker','model','running',${h.sql.json(metadata(false))})`;
    cardId="";baseOwner="owner";limitedOwner=null;short=false;available=false;failSend=false;now=Date.now();
  }
  async function row() {return (await h.sql`SELECT * FROM cards WHERE id=${cardId}`)[0]!;}
  async function ownerId() {return String((await row()).assignee_session_id);}
  async function openId(){return String((await h.sql`SELECT id FROM card_questions WHERE card_id=${cardId} AND answer IS NULL AND withdrawn_at IS NULL ORDER BY asked_at,id LIMIT 1`)[0]?.id);}
  async function apply(type:string) {
    const agent=async()=>({actorKind:"agent" as const,actorSessionId:(await row()).assignee_session_id??"other"});
    const statusOf:Record<string,CardStatus>={question:"blocked",limit:"blocked",noReport:"blocked",other:"blocked",verification:"awaiting_verification",hold:"on_hold"};
    if(type==="CREATE_TODO"||type==="CREATE_QUEUED") {
      cardId=(await cards.createCard({actorKind:"agent",actorSessionId:"pas",assignee:null,folderId:"machine",title:"기계 대조",request:"확인",queue:type==="CREATE_QUEUED"})).operation.target_id;return;
    }
    if(type.startsWith("HUMAN_MOVE_")||type.startsWith("ASSIGNEE_MOVE_")) {
      const target=type.replace(/^(HUMAN|ASSIGNEE)_MOVE_/,"");
      const actor=type.startsWith("HUMAN_")?human:await agent();
      const before=await row();
      await cards.setCardStatus({...actor,cardId,status:(statusOf[target]??target) as Exclude<CardStatus,"uncreated">,
        blockedKind:target==="question"?"question":target==="limit"?"limit":target==="noReport"?"no_report":null,
        blockedDetail:target==="noReport"?"보고 없음":null,wakeAt:target==="verification"?new Date(Date.now()+3600000).toISOString():undefined,waitingFor:target==="verification"?"배포 확인":undefined});return;
    }
    switch(type) {
      case "PAS_APPEARS":await h.sql`UPDATE sessions SET metadata=${h.sql.json(metadata(true))} WHERE session_id='pas'`;await reports.syncBoard("pas");return;
      case "ACK_CARD":expect((await reports.remove("pas",`card_${cardId}`)).ok).toBe(true);return;
      case "BOARD_ONE":case "BOARD_FULL":case "BOARD_ROOM":case "BOARD_OTHER_REMOVED":{
        const target=type==="BOARD_FULL"?12:type==="BOARD_ROOM"?0:11;
        const isOwn=(e:{card_id?:string})=>e.card_id===cardId;
        let entries=await reports.get("pas");
        const others=entries.filter(e=>!isOwn(e));
        for(const e of others.slice(target))await reports.remove("pas",e.key);
        entries=await reports.get("pas");
        let count=entries.filter(e=>!isOwn(e)).length;
        while(count<target) {
          expect((await reports.put("pas",{key:`fill${count++}`,kind:"ask",title:"별도 질문",context:"맥락",action:"결정",options:["진행"],card_numbers:[]})).ok).toBe(true);
        }
        return;
      }
      case "ASSIGN_SESSION":await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id='owner'`;await cards.patchCard({...human,cardId,assignee:{kind:"session",sessionId:"owner"}});return;
      case "ASSIGN_AGENT":await cards.updateUnstartedCard({actorKind:"agent",actorSessionId:"other",cardId,agentId:"worker",nodeId:"node",idempotencyKey:`settings-${Date.now()}`},async()=>{});return;
      case "ASSIGN_HUMAN":await cards.patchCard({...human,cardId,assignee:{kind:"human",userId:"director"}});return;
      case "REPLACE_LIVE":case "REPLACE_LIMITED":{
        const replacement=`replacement-${Date.now()}-${Math.random()}`;
        await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status,metadata,card_id) VALUES(${replacement},'node','worker','model','running','[]',${cardId})`;
        if(type==="REPLACE_LIMITED")await recordWorkReceipt(h,replacement,"error",null,"limit_hit");
        await cards.patchCard({...human,cardId,assignee:{kind:"session",sessionId:replacement}});return;
      }
      case "ASK_OWNER":case "ASK_OTHER":await cards.askQuestion({actorKind:"agent",actorSessionId:type==="ASK_OTHER"?"other":await ownerId(),cardId,text:"결정",options:["진행"]});return;
      case "ANSWER_DETAIL":await cards.answerQuestion({...human,cardId,questionId:await openId(),answer:"진행"});return;
      case "ANSWER_BOARD":{
        const wasEnabled=((await h.sql`SELECT metadata FROM sessions WHERE session_id='pas'`)[0]!.metadata as {type:string;value:{enabled?:boolean}}[]).some(m=>m.type==='persistent_session'&&m.value.enabled===true);
        if(!wasEnabled)await h.sql`UPDATE sessions SET metadata=${h.sql.json(metadata(true))} WHERE session_id='pas'`;
        const decision=await reports.acceptReply("pas",[{key:"persistent_report_reply",content:{key:`cq_${await openId()}`,option:"진행"}}],{source:"browser"});
        if(!wasEnabled){await h.sql`UPDATE sessions SET metadata=${h.sql.json(metadata(false))} WHERE session_id='pas'`;await reports.syncBoard("pas");}
        if(decision.action==="reject")throw Object.assign(new Error(decision.message),{statusCode:decision.status});
        if(decision.action!=="card")throw new Error(`Unexpected board reply: ${decision.action}`);
        await cards.answerQuestion({...human,cardId,questionId:decision.questionId,answer:decision.option});return;
      }
      case "WITHDRAW_AUTHOR":{
        const questionId=await openId();
        const question=(await h.sql`SELECT session_id FROM card_questions WHERE id=${questionId}`)[0]!;
        await cards.withdrawQuestion({actorKind:"agent",actorSessionId:question.session_id,cardId,questionId,reason:"결정됨"});return;
      }
      case "WITHDRAW":await cards.withdrawQuestion({...await agent(),cardId,questionId:await openId(),reason:"결정됨"});return;
      case "HUMAN_MESSAGE":await cards.resumeBlockedCardOnHumanInput({cardId,expectedVersion:(await row()).version});return;
      case "HUMAN_COMMENT":await cards.addComment({...human,cardId,body:"이어갑니다"});return;
      case "AGENT_COMMENT":await cards.addComment({...await agent(),cardId,body:"확인했습니다"});return;
      case "REQUEST_REVIEW":await cards.requestCardReview({...await agent(),cardId,ask:"결과를 확인해 주세요"});return;
      case "START_ADMITTED_WORK":{
        const d=(await h.sql`SELECT * FROM card_orchestration_dispatches WHERE card_id=${cardId} AND state='admitted'`)[0]!;
        await h.sql`UPDATE system_settings SET value='{"enabled":true}' WHERE setting_key='card_orchestration'`;
        await h.sql`UPDATE card_orchestration_dispatches SET state='launching' WHERE card_id=${cardId}`;
        const orchestration=new CardOrchestrationRepository(async()=>sql);
        expect(await orchestration.authorizeWorker({runId:d.run_id,sessionId:d.session_id,executionToken:d.launch_token,nodeId:d.node_id,cardId})).toBe(true);
        await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id=${d.session_id}`;
        await recordWorkReceipt(h,d.session_id,"running",execution);
        await cards.startCardWork({actorKind:"agent",actorSessionId:d.session_id,cardId,execution});
        await h.sql`UPDATE system_settings SET value='{"enabled":false}' WHERE setting_key='card_orchestration'`;
        return;
      }
      case "START_WORK":await recordWorkReceipt(h,await ownerId(),"running",execution);await cards.startCardWork({...await agent(),cardId,execution});return;
      case "SERVER_SHORT_LIMIT":case "SERVER_LONG_LIMIT":{
        limitedOwner=await ownerId();baseOwner=limitedOwner;short=type==="SERVER_SHORT_LIMIT";
        if(short) {
          const reset=new Date(now+3600000).toISOString();
          await h.sql`SELECT event_append(${limitedOwner},'credential_alert',${JSON.stringify({status:"rejected",resets_at:reset})},'',NOW(),NULL)`;
          const ended=(await h.sql`SELECT event_append(${limitedOwner},'session_ended',${JSON.stringify({termination_reason:"limit_hit",resets_at:reset})},'',NOW(),NULL) AS id`)[0]!.id;
          await h.sql`UPDATE sessions SET status='error',termination_reason='limit_hit',termination_event_id=${ended} WHERE session_id=${limitedOwner}`;
        } else await recordWorkReceipt(h,limitedOwner,"error",null,"limit_hit");
        await dispatcher.sessionEnded(limitedOwner);return;
      }
      case "SERVER_LIVE_RESUME":await dispatcher.checkLimits();return;
      case "SERVER_LIMIT_TIME":case "SERVER_LIMIT_RELAUNCH":now+=7200000;available=true;await dispatcher.checkLimits();available=false;return;
      case "OWNER_END":await recordWorkReceipt(h,await ownerId(),"completed",null);await dispatcher.sessionEnded(await ownerId());return;
      case "WAKE_TIME":case "WAKE_FAIL":now=new Date((await row()).wake_at).getTime()+1;failSend=type==="WAKE_FAIL";await dispatcher.checkLimits();failSend=false;return;
      case "RECORD_EXECUTION":case "RECORD_EXECUTION_LATE":{
        const sessionId=(await row()).assignee_session_id??"owner";
        await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id=${sessionId}`;
        await recordWorkReceipt(h,sessionId,"running",execution);
        const requestId=`proof-${Date.now()}-${Math.random()}`;
        await h.sql`INSERT INTO card_execution_requests(id,idempotency_key,keys,card_id,session_id,mode,target,previous_status,baseline_event_id,updated_at)
          VALUES(${requestId},${requestId},'{}',${cardId},${sessionId},'resume','{}','todo',0,
            ${type==="RECORD_EXECUTION_LATE"?new Date(Date.now()-3600000):new Date()})`;
        await executions.observe(cardId,requestId,human);return;
      }
      case "ADMIT_DISPATCH":case "ADMIT_LIMIT":{
        const r=await row(),runId=`admit-${Date.now()}`,leaseToken="test-lease";
        const sessionId=r.assignee_session_id??"owner";
        await h.sql`UPDATE system_settings SET value='{"enabled":true}' WHERE setting_key='card_orchestration'`;
        await h.sql`DELETE FROM card_orchestration_dispatches`;await h.sql`DELETE FROM card_orchestration_runs`;
        await h.sql`INSERT INTO card_orchestration_runs(id,policy_version,input_hash,snapshot,target,session_id,execution_token,lease_token,lease_expires_at,state,decision)
          VALUES(${runId},1,'test','[]','{}','judge','token',${leaseToken},NOW()+INTERVAL '1 hour','decided',${h.sql.json({decisions:[{cardId,cardVersion:r.version,action:"run"}]})})`;
        const params={cardId,expectedVersion:r.version,sessionId,nodeId:"node",admission:{runId,leaseToken,workerInput:{agentId:"worker",modelPreset:"model",configuredModelPreset:null}}};
        if(type==="ADMIT_DISPATCH")await cards.recordDispatch(params);else await cards.resumeDispatchedCard(params);
        await h.sql`UPDATE system_settings SET value='{"enabled":false}' WHERE setting_key='card_orchestration'`;
        return;
      }
      case "SERVER_LIMIT_REQUEUE":await dispatcher.checkLimits();return;
      case "DISPATCH":await cards.recordDispatch({cardId,expectedVersion:(await row()).version,sessionId:"owner",nodeId:"node"});return;
      case "NOTE_MISSING":await cards.noteMissingAssignee({cardId,expectedVersion:(await row()).version});return;
      case "CREATE_FAIL":case "ATTACHMENT_FAIL":await cards.setCardStatus({actorKind:"system",actorSessionId:null,cardId,status:"blocked",blockedKind:"no_report",blockedDetail:"시험 실패"});return;
      case "BULK_TODO":case "BULK_QUEUED":case "BULK_HOLD":case "BULK_CANCELLED":{
        const target=type.slice(5).toLowerCase();
        const result=await cards.bulkSetCardStatus({actorKind:"agent",actorSessionId:"other",cardIds:[cardId],status:target==="hold"?"on_hold":target as "todo"|"queued"|"cancelled",idempotencyKey:`bulk-${Date.now()}-${Math.random()}`},async()=>{});
        if(!result.results[0]?.ok)throw Object.assign(new Error(result.results[0] && "error" in result.results[0]?result.results[0].error:"bulk failed"),{statusCode:409});return;
      }
      case "MERGE_SOURCE":{
        const target=(await cards.createCard({...human,folderId:"machine",title:"합칠 곳",request:"결과"})).operation.target_id;
        await cards.mergeCards({actorKind:"agent",actorSessionId:"other",targetCardId:target,sourceCardIds:[cardId],idempotencyKey:`merge-${Date.now()}`},async()=>{});return;
      }
      default:throw new Error(`Unsupported contrast event: ${type}`);
    }
  }
  return {h,cards,reports,dispatcher,executions,reset,apply,cardId:()=>cardId,cleanup:async()=>{await dispatcher.drain();await h.cleanup();}};
}
export type CardMachineWorld=Awaited<ReturnType<typeof createCardMachineWorld>>;

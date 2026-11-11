import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import type { CardControlPlaneService as Service } from '../src/cards/card_control_plane_service.js';
const {CardControlPlaneService}=await import(process.env.CARD_BASELINE_SERVICE??'../src/cards/card_control_plane_service.js');
import { createPagePostgresHarness, type PagePostgresHarness } from './page/page_postgres_harness.js';
import { appendCardEventTx, prepareCardWorkSchema } from './card-work-postgres-fixture.js';
import { createFolderContentSqlAdapter } from '../src/board/folder_content_sql.js';

// Same disposable database and real facade as card-limit-reservation.postgres.test.ts.
// Run unchanged against the 54476b489 facade/patch modules to establish the oracle.
let h:PagePostgresHarness,cards:Service;
const human={actorKind:'user' as const,actorSessionId:null,actorUserId:'director'};
beforeAll(async()=>{
 h=await createPagePostgresHarness();
 expect(Number((await h.sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
 await prepareCardWorkSchema(h);
 await h.sql`INSERT INTO folders(id,name) VALUES('final','최종 쓰기')`;
 cards=new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql),{appendEventTx:appendCardEventTx});
},60000);
beforeEach(async()=>{
 await h.sql`DELETE FROM folder_operations`;await h.sql`DELETE FROM cards`;await h.sql`DELETE FROM sessions`;
 await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,status) VALUES('owner','node','worker','completed'),('replacement','node','worker','completed')`;
});
afterAll(async()=>h?.cleanup());
async function create(){return (await cards.createCard({...human,folderId:'final',title:'검증',request:'확인',assignee:{kind:'session',sessionId:'owner'}})).operation.target_id;}
async function row(id:string){return (await h.sql`SELECT * FROM cards WHERE id=${id}`)[0]!;}
it('baseline 54476b489 explicitly clears verification fields when changing to a nonverification status',async()=>{
 const cardId=await create(),wakeAt=new Date(Date.now()+3600000).toISOString();
 await cards.setCardStatus({...human,cardId,status:'awaiting_verification',wakeAt,waitingFor:'확인'});
 expect(await row(cardId)).toMatchObject({wake_at:new Date(wakeAt),waiting_for:'확인'});
 await cards.setCardStatus({...human,cardId,status:'done'});
 expect(await row(cardId)).toMatchObject({status:'done',wake_at:null,waiting_for:null,limit_resume_session_id:null,limit_resume_at:null,
  completed_kind:'user',completed_user_id:'director'});
 expect((await row(cardId)).completed_at).toBeInstanceOf(Date);
});
it.each(['replacement','archive'] as const)('baseline 54476b489 %s clears the limit reservation and preserves its notice semantics',async action=>{
 const cardId=await create(),resumeAt=new Date(Date.now()+3600000);
 await h.sql`UPDATE cards SET status='blocked',blocked_kind='limit',limit_resume_session_id='owner',limit_resume_at=${resumeAt} WHERE id=${cardId}`;
 const before=await row(cardId);
 await cards.patchCard({...human,cardId,...(action==='replacement'?{assignee:{kind:'session' as const,sessionId:'replacement'}}:{archived:true})});
 const after=await row(cardId);
 expect(after).toMatchObject({status:'blocked',blocked_kind:'limit',limit_resume_session_id:null,limit_resume_at:null,version:before.version+1});
 if(action==='replacement')expect(after.now).toMatchObject({text:'담당이 바뀌어 자동 재개 예약을 해제했습니다',turn:'agent'});
 else expect(after.now).toEqual(before.now);
});
it('baseline 54476b489 unarchive allocates a missing number and preserves an existing number',async()=>{
 const cardId=await create();
 await cards.patchCard({...human,cardId,archived:true});
 await h.sql`UPDATE cards SET number=NULL WHERE id=${cardId}`;
 await cards.patchCard({...human,cardId,archived:false});
 const number=(await row(cardId)).number;
 expect(number).toEqual(expect.any(Number));
 await cards.patchCard({...human,cardId,archived:true});await cards.patchCard({...human,cardId,archived:false});
 expect((await row(cardId)).number).toBe(number);
});
it('baseline 54476b489 bulk claim preserves now and stores one final status update',async()=>{
 const cardId=(await cards.createCard({...human,folderId:'final',title:'담당 확보',request:'확인',assignee:{kind:'agent',agentId:'worker'}})).operation.target_id;
 await h.sql`UPDATE sessions SET card_id=${cardId} WHERE session_id='owner'`;
 const before=await row(cardId);
 expect(await cards.bulkSetCardStatus({actorKind:'agent',actorSessionId:'owner',cardIds:[cardId],status:'on_hold',idempotencyKey:'claim'},async()=>{}))
  .toMatchObject({results:[{ok:true,status:'on_hold',version:before.version+1}]});
 expect(await row(cardId)).toMatchObject({assignee_kind:'session',assignee_session_id:'owner',now:before.now,limit_resume_session_id:null,limit_resume_at:null});
});

for(const method of ['bulk','update','merge','settings'] as const)it(`baseline 54476b489 ${method} accepts a session kind whose deleted owner ID is null`,async()=>{
 const cardId=await create();
 await h.sql`DELETE FROM sessions WHERE session_id='owner'`;
 expect(await row(cardId)).toMatchObject({assignee_kind:'session',assignee_session_id:null,status:'todo'});
 const actor={actorKind:'agent' as const,actorSessionId:'replacement',cardId,idempotencyKey:method};
 if(method==='bulk')expect(await cards.bulkSetCardStatus({...actor,cardIds:[cardId],status:'queued'},async()=>{})).toMatchObject({results:[{ok:true,status:'queued'}]});
 if(method==='update')await cards.updateUnstartedCard({...actor,title:'수정'},async()=>{});
 if(method==='settings')await cards.saveExecutionSettings({...actor,folderId:'final',nodeId:null,agentId:'worker',modelPreset:null});
 if(method==='merge'){
  const target=(await cards.createCard({...human,folderId:'final',title:'대상',request:'확인'})).operation.target_id;
  await cards.mergeCards({...actor,targetCardId:target,sourceCardIds:[cardId]},async()=>{});
  expect(await row(cardId)).toMatchObject({status:'cancelled'});
 }
});

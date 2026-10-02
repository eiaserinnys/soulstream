import Fastify from 'fastify';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createPagePostgresHarness, type PagePostgresHarness } from './page/page_postgres_harness.js';
import { createBoardYjsSqlAdapter } from '../src/board-yjs/board_yjs_sql.js';
import { CardControlPlaneService } from '../src/cards/card_control_plane_service.js';
import { registerCardRoutes } from '../src/cards/card_routes.js';
import { appendCardEventTx } from './card-work-postgres-fixture.js';

// Uses the existing disposable container, real routes, and event/operation provenance.
let h: PagePostgresHarness, cards: CardControlPlaneService;
const human={actorKind:'user' as const,actorSessionId:null,actorUserId:'director'};
let sequence=0;
const key=()=>`free-status-${++sequence}`;
beforeAll(async()=>{
 h=await createPagePostgresHarness();
 await h.sql`INSERT INTO folders(id,name) VALUES('free','상태')`;
 await h.sql`INSERT INTO sessions(session_id,status) VALUES('owner','running'),('other','running')`;
 cards=new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql),{appendEventTx:appendCardEventTx});
},60000);
afterAll(async()=>h?.cleanup());
it.each(['user','agent'] as const)('allows reportless %s transitions with open questions, archive, completion and reopening',async actor=>{
 const made=await cards.createCard({...human,folderId:'free',title:'자유 상태',request:'원문',assignee:{kind:'session',sessionId:'owner'}});
 const id=made.operation.target_id;
 await h.sql`UPDATE cards SET archived=TRUE WHERE id=${id}`;
 await h.sql`INSERT INTO card_questions(id,card_id,session_id,text) VALUES(${key()},${id},'owner','미답')`;
 const app=Fastify();
 registerCardRoutes(app,{provider:{listFolders:()=>[{id:'free'}],listSessionAssignments:()=>({})},accessProvider:{resolveAccess:()=>({restricted:false})},
  resolveDashboardUserId:()=>human.actorUserId,authBearerToken:'service',environment:'production',cardServiceProvider:async()=>cards});
 const headers=actor==='agent'?{authorization:'Bearer service','x-soulstream-agent-session-id':'owner'}:{};
 try {
  for(const status of ['review','done','running','cancelled','todo','queued','blocked'] as const){
   const before=(await cards.getCard(id))!.card;
   const changed=await app.inject({method:'POST',url:`/api/cards/${id}/status`,headers,payload:{status,expectedVersion:before.version,idempotencyKey:key()}});
   expect(changed.statusCode,changed.body).toBe(200);
   const detail=(await cards.getCard(id))!;
   expect(detail.card).toMatchObject({status,archived:true});expect(detail.reports).toEqual([]);expect(detail.questions[0]!.answer).toBeNull();
   if(status==='done')expect(detail.card).toMatchObject({completed_kind:actor,completed_session_id:actor==='agent'?'owner':null,completed_user_id:actor==='user'?'director':null,completed_at:expect.any(Date)});
   else expect(detail.card).toMatchObject({completed_kind:null,completed_session_id:null,completed_event_id:null,completed_user_id:null,completed_at:null});
   if(status==='blocked')expect(detail.card).toMatchObject({blocked_kind:null,blocked_detail:null,queue_position_key:null});
  }
  const before=(await cards.getCard(id))!;
  await cards.answerQuestion({...human,cardId:id,questionId:String(before.questions[0]!.id),answer:'확인',idempotencyKey:key()});
  expect((await cards.getCard(id))!.card.status).toBe('blocked');
 }finally{await app.close();}
});
it('keeps assignee authority, CAS and enum integrity for direct status changes',async()=>{
 const made=await cards.createCard({...human,folderId:'free',title:'권한',request:'',assignee:{kind:'session',sessionId:'owner'}});
 const id=made.operation.target_id;
 await expect(cards.setCardStatus({actorKind:'agent',actorSessionId:'other',cardId:id,status:'done',expectedVersion:1,idempotencyKey:key()})).rejects.toMatchObject({statusCode:403});
 await cards.setCardStatus({actorKind:'agent',actorSessionId:'owner',cardId:id,status:'done',expectedVersion:1,idempotencyKey:key()});
 await expect(cards.setCardStatus({...human,cardId:id,status:'todo',expectedVersion:1,idempotencyKey:key()})).rejects.toMatchObject({statusCode:409});
});

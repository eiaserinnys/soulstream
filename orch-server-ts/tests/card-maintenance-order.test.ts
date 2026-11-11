import { expect,it } from 'vitest';
import type { CardControlPlaneService as Service } from '../src/cards/card_control_plane_service.js';
const {CardControlPlaneService}=await import(process.env.CARD_BASELINE_SERVICE??'../src/cards/card_control_plane_service.js');
const {CardMaintenanceService}=await import(process.env.CARD_BASELINE_MAINTENANCE??'../src/cards/card_maintenance_service.js');
import type { CardRow, RepositorySql } from '../src/cards/control_plane/card_types.js';

// Same public facade/real transaction callback harness as card-server-order.
function harness(overrides:Record<string,unknown>={},options:{pending?:boolean;owner?:string;missingOwner?:boolean;claim?:boolean}={}){
 const queries:string[]=[];
 const card={id:'card',folder_id:'folder',title:'카드',number:1,version:2,status:'todo',archived:false,request:'확인',brief:'',
  items:[],attachments:[],attachment_refs:[],now:null,assignee_kind:'agent',assignee_agent_id:'worker',assignee_session_id:null,
  wake_at:null,waiting_for:null,limit_resume_session_id:null,limit_resume_at:null,...overrides} as unknown as CardRow;
 const sql=Object.assign(async(strings:TemplateStringsArray)=>{
  const query=strings.join('');queries.push(query);
  if(query.includes('SELECT * FROM cards'))return [structuredClone(card)];
  if(query.includes('FROM folder_operations')||query.includes('pg_advisory'))return [];
  if(query.includes('FROM card_execution_requests'))return options.pending?[{id:'pending'}]:[];
  if(query.includes('SELECT status FROM sessions'))return options.missingOwner?[]:[{status:options.owner??'completed'}];
  if(query.includes('SELECT s.session_id FROM cards'))return options.claim?[{session_id:'actor'}]:[];
  throw Error(`Unexpected SQL: ${query}`);
 },{json:(v:unknown)=>v,array:(v:unknown)=>v,begin:async(fn:any)=>fn(sql)}) as unknown as RepositorySql;
 const service=Object.create(CardControlPlaneService.prototype) as Service;
 const core={mutateTx:async(_sql:unknown,p:any)=>{await p.apply(sql,1);return {operation:{target_id:card.id,payload_json:p.payload},eventId:1};},
  mutate:async(p:any)=>{await p.apply(sql,1);return {idempotent:false,operation:{payload_json:p.payload}};}};
 Object.assign(service,{repo:{getCard:async()=>structuredClone(card)},repoSql:sql,core});
 const maintenance=new CardMaintenanceService({sql,repo:{},core,
  patchTx:async(_sql:unknown,_card:unknown,fields:Record<string,unknown>)=>Object.assign(card,fields,{version:card.version+1}),
  statusTx:(sql:RepositorySql,card:CardRow,eventId:number,p:any,payload:any)=>(service as any).applyStatusTx(sql,card,eventId,p,payload,'bulk_idle'),afterCommit:async()=>{}});
 Object.assign(service,{maintenance});
 return {service,queries,card};
}
const actor={actorKind:'agent' as const,actorSessionId:'actor',cardId:'card',idempotencyKey:'key'};
const update=(h:ReturnType<typeof harness>,extra={})=>h.service.updateUnstartedCard({...actor,title:'수정',...extra},async()=>{});
it('baseline 54476b489 maintenance rejects whitespace-only actor before any SQL',async()=>{
 const h=harness(),error=await update(h,{actorSessionId:' '}).then(()=>null,e=>e);
 expect(error).toMatchObject({statusCode:403,message:'card mutation requires an agent session'});expect(error.code).toBeUndefined();
 expect(h.queries).toEqual([]);
});
it('baseline 54476b489 unstarted state rejects before pending SQL and version',async()=>{
 const h=harness({archived:true});await expect(update(h,{expectedVersion:1})).rejects.toMatchObject({code:'CARD_NOT_UNSTARTED',statusCode:409,
  message:'카드 #1은 보관됨으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'});
 expect(h.queries).toHaveLength(4);expect(h.queries[3]).toContain('FOR UPDATE');
});
it('baseline 54476b489 unstarted pending check precedes version conflict',async()=>{
 const h=harness({}, {pending:true});await expect(update(h,{expectedVersion:1})).rejects.toMatchObject({code:'CARD_EXECUTION_PENDING',statusCode:409,
  message:'카드 #1은 실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'});
 expect(h.queries).toHaveLength(5);expect(h.queries[4]).toContain('card_execution_requests');
});
it('baseline 54476b489 unstarted version check follows pending before formatting attachments',async()=>{
 const h=harness();await expect(update(h,{expectedVersion:1,request:'https://invalid.example'})).rejects.toMatchObject({statusCode:409,
  message:'folder card version conflict: card expected version 1, actual version 2'});
 expect(h.queries).toHaveLength(5);expect(h.queries[4]).toContain('card_execution_requests');
});
for(const [label,overrides,options,count,message] of [
 ['human',{assignee_kind:'human'},{},4,'사람이 담당인 카드는 bulk_set_card_status로 바꿀 수 없습니다.'],
 ['cardRunning',{assignee_kind:'session',assignee_session_id:'owner',status:'running'},{},4,'카드 #1의 담당이 실행 중입니다. 담당 세션이 지금 턴을 돌고 있습니다. 후속 지시는 dispatch_work로 전하거나 턴이 끝난 뒤 다시 시도하세요.'],
 ['missingOwner',{assignee_kind:'session',assignee_session_id:'owner'},{missingOwner:true},5,'담당 세션을 찾을 수 없습니다. 현재 담당을 확인하세요.'],
 ['initializing',{assignee_kind:'session',assignee_session_id:'owner'},{owner:'initializing'},5,'카드 #1의 담당이 실행 중입니다. 담당 세션이 지금 턴을 돌고 있습니다. 후속 지시는 dispatch_work로 전하거나 턴이 끝난 뒤 다시 시도하세요.'],
 ['connectedRest',{assignee_kind:'session',assignee_session_id:'owner'},{},5,'담당 세션이 있는 카드는 보류·취소만 가능합니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'],
] as const)it(`baseline 54476b489 bulk ${label} preserves SQL prefix and per-card error`,async()=>{
 const h=harness(overrides,options);
 expect(await h.service.bulkSetCardStatus({...actor,cardIds:['card'],status:'todo'},async()=>{})).toEqual({results:[{card_id:'card',ok:false,error:message}]});
 expect(h.queries).toHaveLength(count);expect(h.queries[3]).toContain('FOR UPDATE');
 if(count===5)expect(h.queries[4]).toContain('SELECT status FROM sessions');
});
it('baseline 54476b489 bulk claims only after guards and preserves one write',async()=>{
 const h=harness({}, {claim:true});
 expect(await h.service.bulkSetCardStatus({...actor,cardIds:['card'],status:'on_hold'},async()=>{})).toMatchObject({results:[{ok:true,status:'on_hold',version:3}]});
 expect(h.queries).toHaveLength(6);expect(h.queries[4]).toContain('SELECT s.session_id FROM cards');
 expect(h.card).toMatchObject({assignee_kind:'session',assignee_session_id:'actor'});
});
for(const pending of [false,true])it(`baseline 54476b489 settings pending=${pending} precedes owner and folder move`,async()=>{
 const h=harness({assignee_kind:'session',assignee_session_id:'owner'}, {pending});
 await expect(h.service.saveExecutionSettings({...actor,folderId:'new-folder',nodeId:null,agentId:null,modelPreset:null})).rejects.toMatchObject(pending?
  {statusCode:409,code:'CARD_EXECUTION_PENDING',message:'실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요.'}:
  {statusCode:409,message:'담당 세션이 연결된 카드의 설정은 변경할 수 없습니다.'});
 expect(h.queries).toHaveLength(2);expect(h.queries[0]).toContain('FOR UPDATE');expect(h.queries[1]).toContain('card_execution_requests');
});

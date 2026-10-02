import type {WidgetCard} from './card-groups';
type Sync={folderId:string|null;limit:number;fetchedAt:string};
export interface WidgetState {cards:WidgetCard[];total:number;hasData:boolean;sync:Sync|null;disposed:boolean;pending:boolean;notice:string;summaryOverride?:string;syncText:string}
type Result={isError?:boolean;structuredContent?:{cards?:WidgetCard[];total?:number;sync?:Sync;syncError?:{authorization:boolean}}};
/** Host MCP bridge only. No backend HTTP, credentials, storage or dashboard state. */
export function createWidgetBridge(publish:(state:WidgetState)=>void){
 const state:WidgetState={cards:[],total:0,hasData:false,sync:null,disposed:false,pending:false,notice:'',syncText:'읽기 전용 · 대화에서 전달된 스냅샷 · 원본 자동 동기화 없음'};
 let initialized=false,timer:ReturnType<typeof setTimeout>|undefined,pending:{id:number;epoch:number;timeout:ReturnType<typeof setTimeout>}|null=null,rpcId=1,generation=0;
 const emit=()=>publish({...state});
 function stopPending(){if(pending){clearTimeout(pending.timeout);pending=null;}state.pending=false;}
 function schedule(){clearTimeout(timer);timer=undefined;if(state.sync&&!state.disposed&&!document.hidden)timer=setTimeout(refresh,30000);}
 function failure(result:Result){
  if(!state.hasData||result.structuredContent?.syncError?.authorization){state.cards=[];state.hasData=false;}
  state.notice=state.hasData?'새로고침 실패 · 이전 데이터를 표시합니다. 다시 시도해 주세요':'카드를 불러오지 못했습니다. 접근 권한과 서버 연결을 확인해 주세요';
  state.summaryOverride='동기화 실패'+(state.hasData?' · 이전 '+state.cards.length+'개 표시':'');state.syncText='읽기 전용 · 동기화 실패';emit();schedule();
 }
 function receive(result:Result,modelUpdate=false){
  if(modelUpdate){generation++;stopPending();}
  if(result?.isError){if(modelUpdate){state.sync=null;state.hasData=false;state.cards=[];clearTimeout(timer);}failure(result);return;}
  const data=result?.structuredContent;if(!data||!Array.isArray(data.cards))return;
  state.cards=data.cards;state.total=data.total??state.cards.length;state.hasData=true;
  state.sync=data.sync&&typeof data.sync==='object'?data.sync:null;state.notice='';state.summaryOverride=undefined;
  state.syncText=state.sync?'읽기 전용 · 30초마다 동기화 · 최근 '+new Date(state.sync.fetchedAt).toLocaleTimeString('ko-KR'):'읽기 전용 · 대화에서 전달된 스냅샷 · 원본 자동 동기화 없음';emit();schedule();
 }
 function refresh(){
  if(state.disposed||!state.sync||pending||!initialized||document.hidden)return;
  clearTimeout(timer);timer=undefined;const id=++rpcId,epoch=generation;
  state.pending=true;state.notice='새로고침 중…';
  const timeout=setTimeout(()=>{if(pending?.id!==id)return;stopPending();failure({});},10000);
  pending={id,epoch,timeout};emit();
  const args:{limit:number;folder_id?:string}={limit:state.sync.limit??100};if(state.sync.folderId)args.folder_id=state.sync.folderId;
  window.parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'list_live_cards',arguments:args}},'*');
 }
 const onVisibility=()=>{if(document.hidden){clearTimeout(timer);timer=undefined;}else if(state.sync){refresh();schedule();}};
 function cleanup(){state.disposed=true;state.hasData=false;state.sync=null;state.cards=[];state.total=0;clearTimeout(timer);stopPending();document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('message',onMessage);window.removeEventListener('pagehide',cleanup);emit();}
 function onMessage(event:MessageEvent){
  if(state.disposed||event.source!==window.parent)return;
  const m=event.data;if(m?.jsonrpc!=='2.0')return;
  const hasId=typeof m.id==='string'||typeof m.id==='number';
  if(typeof m.method==='string'){
   if(m.method==='ui/resource-teardown'&&hasId){cleanup();window.parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');return;}
   if(!hasId&&m.method==='ui/notifications/tool-result')receive(m.params,true);return;
  }
  if(m.id===1&&!initialized&&(Object.hasOwn(m,'result')||Object.hasOwn(m,'error'))){
   if(m.error){failure({});return;}initialized=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');schedule();return;
  }
  if(pending&&m.id===pending.id){const valid=pending.epoch===generation;stopPending();if(!valid)return;if(m.error)failure({});else receive(m.result);}
 }
 document.addEventListener('visibilitychange',onVisibility);window.addEventListener('message',onMessage);window.addEventListener('pagehide',cleanup);
 if(window.parent!==window)window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{appInfo:{name:'soulstream-cards',version:'0.3.0'},appCapabilities:{},protocolVersion:'2026-01-26'}},'*');
 emit();return {refresh};
}

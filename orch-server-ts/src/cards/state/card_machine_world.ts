import type { DecisionAction } from './card_decision.js';
import { cardCommandEntryFailure } from './card_command_entrance.js';
import { transition } from 'xstate';
import { cardDecisionMachine } from './card_decision_machine.js';
import { CARD_ACTORS, CARD_FACT_VALUES, enumerateCardFacts, type DecisionEvent, type CardDecisionCommand } from './card_decision_facts.js';
import { rowToStateValue, stateValueToColumns, statusLeaf, type CardStateValue } from './card_state_value.js';
import { cardBoardEntries } from '../../session/card_board_entries.js';
export type DecisionSnapshot=ReturnType<typeof cardDecisionMachine.resolveState>;
export interface CardWorld {snapshot:DecisionSnapshot;owner:'live'|'ended'|'shortLimit'|'longLimit';pas:'none'|'room'|'one'|'full';dismissed:boolean}
export function worldKey(w:CardWorld){return JSON.stringify([w.snapshot.value,w.owner,w.pas,w.dismissed]);}
export function boardEntriesOf(w:CardWorld):('question'|'card')[]{
 const v=w.snapshot.value as CardStateValue,c=stateValueToColumns(v),stamp='2000-01-01T00:00:00.000Z';
 const card={...c,id:'machine',number:1,title:'카드',blocked_detail:null,now:null,status_changed_at:stamp,updated_at:stamp};
 const questions=v.question==='open'?[{id:'question',card_id:'machine',text:'질문',options:['진행'],answer:null,withdrawn_at:null,asked_at:stamp}]:[];
 return cardBoardEntries(card as any,questions as any,w.pas!=='none'&&statusLeaf(v)!=='uncreated',w.dismissed?[{card_id:'machine',status:c.status,blocked_kind:c.blocked_kind,status_changed_at:stamp} as any]:[]).map(e=>e.question_id?'question':'card');
}
/** Only contradictions between independently recorded facts are filtered here. */
export function factsConsistent(w:CardWorld,event:DecisionEvent):boolean {
 const v=w.snapshot.value as CardStateValue,f=event.facts,c=event.type;
 if((statusLeaf(v)==='uncreated')!==(c==='CREATE'))return false;
 if(['author','ownerAuthor'].includes(event.actor)&&!['ANSWER_QUESTION','WITHDRAW_QUESTION'].includes(c))return false;
 if(c==='PATCH_CARD_CONTROL'&&f.hasArchiveInput===false&&f.nextArchived!==(v.archive==='archived'))return false;
 if(f.reply===true&&f.hasMode===false)return false;
 if(['owner','ownerAuthor'].includes(event.actor)&&v.assignee!=='session')return false;
 if(f.claim===true&&(v.assignee!=='agent'||!['author','otherAgent'].includes(event.actor)))return false;
 if(c==='PATCH_CARD_CONTROL'){
 if(f.hasAssignment===false&&f.assignmentChanged===true)return false;
 if(f.hasAssignment===true&&f.assigneeInput!==v.assignee&&f.assignmentChanged!==true)return false;
 if(f.hasAssignment===true&&f.assigneeInput===v.assignee&&v.assignee!=='session'&&f.assignmentChanged===true)return false;
 }
 if(c==='SAVE_EXECUTION_SETTINGS'&&f.assignmentChanged!==(f.assigneeInput!==v.assignee))return false;
 if(c==='REGISTER_REPLACEMENT'&&f.assignmentChanged!==true)return false;
 if(c==='CONFIRM_EXECUTION'&&f.assignmentChanged!==(v.assignee!=='session'||f.sessionMatch===false))return false;
 if(f.itemExists===true&&f.hasItems===false)return false;
 if(f.execution===true&&!['owner','ownerAuthor','author','otherAgent'].includes(event.actor))return false;
 if(f.question!==undefined){
 if(v.question==='none'&&(f.question==='open'||f.otherOpen===true))return false;
 if(v.question==='open'&&f.question!=='open'&&!f.otherOpen)return false;
 if(f.question==='missing'&&['author','ownerAuthor'].includes(event.actor))return false;
 }
 if(f.ownerState!==undefined&&v.assignee==='session'){
 if(w.owner==='live'&&!['running','initializing'].includes(String(f.ownerState)))return false;
 if(w.owner!=='live'&&f.ownerState!=='idle')return false;
 }
 if(c==='BLOCK_FOR_LIMIT'){
 if(f.termination!==(w.owner==='shortLimit'||w.owner==='longLimit'))return false;
 if(f.short!==(w.owner==='shortLimit'))return false;
 }
 if(f.admitted===true&&(!f.execution||!f.admissionReceipt||!f.admissionValid))return false;
 if(f.admitted===false&&f.admissionReceipt===true&&f.admissionValid===true)return false;
 if(f.admissionReceipt===false&&f.admissionValid===true)return false;
 if(f.hasAdmission===false&&f.admission!=='ok')return false;
 if(f.hasItem===false&&f.itemExists===true)return false;
 if(c==='START_WORK'&&w.owner!=='live'&&v.assignee==='session'&&f.execution===true)return false;
 return true;
}
const commands=Object.keys(CARD_FACT_VALUES) as CardDecisionCommand[];
const variants:DecisionEvent[]=commands.flatMap(type=>[...enumerateCardFacts(type)].flatMap(facts=>CARD_ACTORS.map(actor=>({type,actor,facts}))))
 .filter(event=>!cardCommandEntryFailure(event.type,{hasMode:event.facts.hasMode,requestedSpoken:event.facts.requestedSpoken},
  {kind:event.actor==='human'?'user':event.actor==='server'?'system':event.actor==='external'?'llm':'agent',sessionId:event.actor==='anonymousAgent'?null:'session'}));
export function* worldCommandEdges(w:CardWorld){
 for(const event of variants){
 if(!factsConsistent(w,event))continue;
 const [snapshot,actions]=transition(cardDecisionMachine,w.snapshot,event);
 const verdict=(actions as unknown as DecisionAction[]).find(a=>['apply','noop','reject'].includes(a.type))!;
 const before=w.snapshot.value as CardStateValue,after=snapshot.value as CardStateValue;
 const a=stateValueToColumns(before),b=stateValueToColumns(after);
 const owner=after.assignee==='session'&&(before.assignee!=='session'||event.facts.assignmentChanged===true||event.type==='REGISTER_REPLACEMENT')?'live':w.owner;
 yield {event,verdict:verdict.type,failure:(verdict.params as any)?.failure,guard:(verdict.params as any)?.guard,actions,next:{...w,snapshot,owner,dismissed:a.status!==b.status||a.blocked_kind!==b.blocked_kind?false:w.dismissed} as CardWorld};
 }
}
export function worldEnvironmentEdges(w:CardWorld){
 const result:{event:string;next:CardWorld}[]=[];
 if((w.snapshot.value as CardStateValue).assignee==='session'&&w.owner==='live')for(const owner of ['ended','shortLimit','longLimit'] as const)result.push({event:`OWNER_END.${owner}`,next:{...w,owner}});
 if(w.pas==='none')result.push({event:'PAS_APPEARS',next:{...w,pas:'room'}});
 else{
 for(const [event,pas] of [['BOARD_ONE','one'],['BOARD_FULL','full'],['BOARD_ROOM','room'],['BOARD_OTHER_REMOVED','one']] as const)result.push({event,next:{...w,pas}});
 const v=w.snapshot.value as CardStateValue;
 if(v.question==='none'&&['question','noReport','other','limit'].includes(statusLeaf(v)))result.push({event:'ACK_CARD',next:{...w,dismissed:true}});
 }
 return result;
}
let cached:ReturnType<typeof explore>|undefined;
export function exploreCardWorld(){return cached??=explore();}
function explore(){
 const initial:CardWorld={snapshot:cardDecisionMachine.resolveState({value:rowToStateValue(null,[]),context:{}}),owner:'live',pas:'none',dismissed:false};
 const worlds=[initial],seen=new Map([[worldKey(initial),0]]),paths:string[][]=[[]];
 const permissions:Record<string,{apply:number;reject:number;guards:Set<string>}>= {};
 const commandCache=new Map<string,Map<CardWorld['owner'],{next:{value:CardStateValue;owner:CardWorld['owner'];resetDismissal:boolean;event:string}[];permissions:typeof permissions}>>();
 const counted=new Set<string>();
 function summarize(w:CardWorld){
 const owners=['live','ended','shortLimit','longLimit'] as const;
 // All actions in this machine have static symbolic params, no entry/exit,
 // eventless transitions or context writes. For one snapshot, identical
 // selected definition branches therefore have identical pure results.
 // The inventory contract asserts this restriction; no policy is reimplemented.
 const branches=new Map<object,number>();
 const transitions=new Map<string,ReturnType<typeof transition<typeof cardDecisionMachine>>>();
 const results=new Map(owners.map(owner=>[owner,{next:new Map<string,{value:CardStateValue;owner:CardWorld['owner'];resetDismissal:boolean;event:string}>(),permissions:{} as typeof permissions}]));
 for(const event of variants){
 const applicable=owners.filter(owner=>factsConsistent({...w,owner},event));
 if(!applicable.length)continue;
 const chosen=cardDecisionMachine.getTransitionData(w.snapshot,event);
 const signature=chosen.map(t=>{if(!branches.has(t))branches.set(t,branches.size);return branches.get(t);}).join(',');
 let outcome=transitions.get(signature);
 if(!outcome){outcome=transition(cardDecisionMachine,w.snapshot,event);transitions.set(signature,outcome);}
 const [snapshot,actions]=outcome;
 const verdict=(actions as unknown as DecisionAction[]).find(a=>['apply','noop','reject'].includes(a.type))!;
 const value=snapshot.value as CardStateValue,before=w.snapshot.value as CardStateValue;
 const a=stateValueToColumns(before),b=stateValueToColumns(value),resetDismissal=a.status!==b.status||a.blocked_kind!==b.blocked_kind;
 for(const owner of applicable){
 const result=results.get(owner)!,key=`${event.type}:${event.actor}${event.type==='ADD_COMMENT'?':'+event.facts.entrance:''}`,p=result.permissions[key]??={apply:0,reject:0,guards:new Set<string>()};
 if(verdict.type==='reject'){p.reject++;p.guards.add(`${(verdict.params as any)?.guard}: ${(verdict.params as any)?.failure}`);continue;}p.apply++;
 const nextOwner=value.assignee==='session'&&(before.assignee!=='session'||event.facts.assignmentChanged===true||event.type==='REGISTER_REPLACEMENT')?'live':owner;
 const k=JSON.stringify([value,nextOwner,resetDismissal]);
 if(!result.next.has(k))result.next.set(k,{value,owner:nextOwner,resetDismissal,event:JSON.stringify(event)});
 }
 }
 return new Map([...results].map(([owner,r])=>[owner,{next:[...r.next.values()],permissions:r.permissions}]));
 }
 for(let index=0;index<worlds.length;index++){
 const w=worlds[index]!;
 const key=JSON.stringify(w.snapshot.value);
 let summary=commandCache.get(key);if(!summary){summary=summarize(w);commandCache.set(key,summary);}
 const current=summary.get(w.owner)!,countKey=`${key}:${w.owner}`;
 if(!counted.has(countKey)){
 counted.add(countKey);
 for(const [name,p] of Object.entries(current.permissions)){const target=permissions[name]??={apply:0,reject:0,guards:new Set<string>()};target.apply+=p.apply;target.reject+=p.reject;p.guards.forEach(g=>target.guards.add(g));}
 }
 const candidates=[...worldEnvironmentEdges(w),...current.next.map(s=>({event:s.event,next:{...w,snapshot:cardDecisionMachine.resolveState({value:s.value,context:{}}),owner:s.owner,dismissed:s.resetDismissal?false:w.dismissed}}))];
 for(const {event,next} of candidates){const k=worldKey(next);if(!seen.has(k)){seen.set(k,worlds.length);worlds.push(next);paths.push([...paths[index]!,event]);}}
 }
 return {worlds,paths,permissions};
}

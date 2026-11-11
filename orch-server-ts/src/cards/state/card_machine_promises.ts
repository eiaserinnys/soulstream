import { transition } from 'xstate';
import { cardDecisionMachine } from './card_decision_machine.js';
import { exploreCardWorld, boardEntriesOf, type CardWorld } from './card_machine_world.js';
import { statusLeaf, type CardStateValue } from './card_state_value.js';
import type { DecisionEvent } from './card_decision_facts.js';
export interface TransitionMark {source:string;event:string;note:string;discrepancies:number[]}
export interface CardHole {id:string;parent:string;label:string;reachable:boolean;note?:string;incoming:{from:string;label:string}[]}
export interface PromiseResult {id:number;name:string;kept:boolean;violations:number;example:string[];discrepancies:number[]}
const value=(w:CardWorld)=>w.snapshot.value as CardStateValue;
const active=(w:CardWorld)=>value(w).archive==='active'&&!['uncreated','hold','done','cancelled'].includes(statusLeaf(value(w)));
const advance=(w:CardWorld,event:DecisionEvent)=>({...w,snapshot:transition(cardDecisionMachine,w.snapshot,event)[0]});
const answer={type:'ANSWER_QUESTION',actor:'human',facts:{question:'open',otherOpen:false}} as const;
export const questionAnswersDiffer=(w:CardWorld,read=(w:CardWorld,_boundary:string)=>advance(w,answer))=>value(w).question==='open'&&JSON.stringify(read(w,'detail').snapshot.value)!==JSON.stringify(read(w,'board').snapshot.value);
export const questionAuthorCannotWithdraw=(w:CardWorld,read=advance)=>value(w).question==='open'&&value(read(w,{type:'WITHDRAW_QUESTION',actor:'author',facts:{question:'open',otherOpen:false}})).question==='open';
export const unrecordedLimitResume=(w:CardWorld,read=advance)=>statusLeaf(value(w))==='limit'&&value(w).reservation==='none'&&[
 {type:'RESUME_SHORT_LIMIT',actor:'server',facts:{sessionMatch:true,due:true,resumeTimeMatch:true,pending:false}},
 {type:'RESUME_LONG_LIMIT',actor:'server',facts:{sessionMatch:true,pending:false,policyEnabled:false,hasAdmission:false,admission:'ok'}},
].some(event=>['running','queued'].includes(statusLeaf(value(read(w,event as unknown as DecisionEvent)))));
export const shortLimitReservationMissing=(w:CardWorld,read=advance)=>active(w)&&statusLeaf(value(w))==='running'&&value(w).assignee==='session'&&w.owner==='shortLimit'&&value(read(w,{type:'BLOCK_FOR_LIMIT',actor:'server',facts:{sessionMatch:true,termination:true,short:true}})).reservation!=='limit';
export const questionEntryMissing=(w:CardWorld,read=boardEntriesOf)=>active(w)&&w.pas!=='none'&&value(w).question==='open'&&!read(w).includes('question');
export const cardEntryMissing=(w:CardWorld,read=boardEntriesOf)=>active(w)&&w.pas!=='none'&&value(w).question==='none'&&['question','noReport','other','limit','review'].includes(statusLeaf(value(w)))&&!w.dismissed&&!read(w).includes('card');
export const CARD_PROMISES=[
 {name:'판에 올라야 할 장은 판에 있다 (1-가 질문 장)',discrepancies:[1,7],breaks:questionEntryMissing},
 {name:'서버의 한도 재개는 기록된 담당이 현재 담당일 때만 한다',discrepancies:[2],breaks:unrecordedLimitResume},
 {name:'같은 질문의 답은 카드 상세와 감독 판에서 결과가 같다',discrepancies:[4],breaks:questionAnswersDiffer},
 {name:'질문을 올릴 수 있는 세션은 철회할 수 있다',discrepancies:[8],breaks:questionAuthorCannotWithdraw},
 {name:'짧은 한도로 막히면 취소 전까지 시각 있는 예약이 있다',discrepancies:[],breaks:shortLimitReservationMissing},
 {name:'기다리는 카드는 판의 장이나 시각으로 나가는 길이 있다',discrepancies:[],breaks:(w:CardWorld)=>active(w)&&w.pas!=='none'&&['question','noReport','other','limit','review'].includes(statusLeaf(value(w)))&&!boardEntriesOf(w).length&&!['limit','verify'].includes(value(w).reservation)},
];
let cached:ReturnType<typeof compute>|undefined;
export function checkCardPromises(){return cached??=compute();}
function compute(){
 const world=exploreCardWorld();
 const result=(id:number,p:{name:string;discrepancies:number[];breaks:(w:CardWorld)=>boolean}):PromiseResult=>{
 const indices=world.worlds.flatMap((w,i)=>p.breaks(w)?[i]:[]);
 return {id,name:p.name,kept:indices.length===0,violations:indices.length,example:indices.length?world.paths[indices[0]!]!:[],discrepancies:p.discrepancies};
 };
 const promises=CARD_PROMISES.map((p,i)=>result(i+1,p));
 const cardEntryPromise=result(1,{name:'판에 올라야 할 장은 판에 있다 (1-나 카드 장)',discrepancies:[1],breaks:cardEntryMissing});
 const holes:CardHole[]=[
 {id:'holeCardMissing',parent:'s_on',label:'판에 올라야 하는데 카드 장이 없음',reachable:!cardEntryPromise.kept,incoming:[]},
 {id:'holeQuestionMissing',parent:'s_on',label:'질문은 열렸는데 판에 장이 없음',reachable:!promises[0]!.kept,incoming:[]},
 {id:'holeOrphan',parent:'cardDecision.question',label:'철회할 세션이 없는 질문',reachable:!promises[3]!.kept,incoming:[]},
 {id:'holeChangedLimitOwner',parent:'s_limit',label:'담당이 바뀐 한도 막힘',reachable:world.worlds.some(w=>['limit','longLimit'].includes(value(w).reservation)&&value(w).assignee!=='session'),incoming:[],note:'예약 담당 불일치는 DB CHECK가 금지하며 결정 상태의 별도 영역으로 만들지 않는다'},
 ];
 const definitions=(node:typeof cardDecisionMachine.root):number=>Object.values(node.on).reduce((sum,t)=>sum+t.length,0)+Object.values(node.states).reduce((sum,n)=>sum+definitions(n),0);
 const states=[...new Set(world.worlds.filter(w=>CARD_PROMISES[5]!.breaks(w)).map(w=>`s_${statusLeaf(value(w))}`))];
 return {...world,promises,cardEntryPromise,holes,marks:{states,transitions:[] as TransitionMark[]},configurationCount:world.worlds.length,definitionCount:definitions(cardDecisionMachine.root)};
}

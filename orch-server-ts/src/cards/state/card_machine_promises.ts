import { transition } from "xstate";
import { getAdjacencyMap, getShortestPaths } from "xstate/graph";
import { cardMachine, boardEntriesOf, type CardSnapshot } from "./card_machine.js";
import { CARD_EVENTS, EVENT_LABELS, type CardEvent } from "./card_machine_events.js";

export interface TransitionMark {source:string;event:string;note:string;discrepancies:number[]}
export interface CardHole {id:string;parent:string;label:string;reachable:boolean;note?:string;incoming:{from:string;label:string}[]}
export interface PromiseResult {id:number;name:string;kept:boolean;violations:number;example:string[];discrepancies:number[]}
const has=(s:CardSnapshot,id:string)=>s._nodes.some(n=>n.id===id);
const open=(s:CardSnapshot)=>!has(s,"qNone");
const pas=(s:CardSnapshot)=>!has(s,"pasNone");
const next=(s:CardSnapshot,event:string)=>transition(cardMachine,s,{type:event})[0];
/** The transition reader is replaceable only for checker mutation tests. */
export const questionAnswersDiffer=(s:CardSnapshot,advance:typeof next=next)=>open(s)&&JSON.stringify(advance(s,"ANSWER_DETAIL").value)!==JSON.stringify(advance(s,"ANSWER_BOARD").value);
export const questionAuthorCannotWithdraw=(s:CardSnapshot,advance:typeof next=next)=>open(s)&&open(advance(s,"WITHDRAW_AUTHOR"));
export const CARD_PROMISES = [
  {name:"판에 올라야 할 장은 판에 있다 (1-가 질문 장)",discrepancies:[1,7],breaks:(s:CardSnapshot)=>pas(s)&&has(s,"on")&&open(s)&&!has(s,"ePresent")},
  {name:"서버는 한도에 걸린 담당이 같을 때만 실행 중으로 옮긴다",discrepancies:[2],breaks:(s:CardSnapshot)=>has(s,"limit")&&(has(s,"lDifferent")||has(s,"lDifferentLong"))&&["SERVER_LIVE_RESUME","SERVER_LIMIT_RELAUNCH"].some(e=>has(next(s,e),"running"))},
  {name:"같은 질문의 답은 카드 상세와 감독 판에서 결과가 같다",discrepancies:[4],breaks:(s:CardSnapshot)=>questionAnswersDiffer(s)},
  {name:"질문을 올릴 수 있는 세션은 철회할 수 있다",discrepancies:[8],breaks:(s:CardSnapshot)=>questionAuthorCannotWithdraw(s)},
  {name:"짧은 한도로 막히면 깨울 예약이 있다",discrepancies:[],breaks:(s:CardSnapshot)=>has(s,"limit")&&(has(s,"lSame")||has(s,"lDifferent"))&&!has(s,"rLimit")},
  {name:"기다리는 카드는 판의 장이나 시각으로 나가는 길이 있다",discrepancies:[],breaks:(s:CardSnapshot)=>pas(s)&&["question","noReport","other","limit","review"].some(id=>has(s,id))&&boardEntriesOf(s).length===0&&!has(s,"rLimit")&&!has(s,"rVerify")},
];
/** The predicates are exported so repaired/violating configurations can test the checker itself. */
let cached:ReturnType<typeof computeCardPromises>|undefined;
export function checkCardPromises() { return cached??=computeCardPromises(); }
function computeCardPromises() {
  const adjacency=getAdjacencyMap(cardMachine,{events:CARD_EVENTS});
  const paths=getShortestPaths(cardMachine,{events:CARD_EVENTS});
  const pathByValue=new Map(paths.map(p=>[JSON.stringify(p.state.value),p.steps.map(step=>step.event.type).filter(type=>type!=="xstate.init")]));
  const states=Object.values(adjacency).map(a=>a.state);
  const promises:PromiseResult[]=CARD_PROMISES.map((p,i)=>{
    const broken=states.filter(p.breaks);
    return {id:i+1,name:p.name,kept:broken.length===0,violations:broken.length,example:broken.length?pathByValue.get(JSON.stringify(broken[0]!.value))??[]:[],discrepancies:p.discrepancies};
  });
  const marks=new Map<string,TransitionMark>();
  function mark(s:CardSnapshot,event:CardEvent,n:number) {
    for (const t of cardMachine.getTransitionData(s,event)) {
      const key=`${t.source.id}:${event.type}`;
      const value=marks.get(key)??{source:t.source.id,event:event.type,note:"",discrepancies:[]};
      if(!value.discrepancies.includes(n))value.discrepancies.push(n);
      value.note=`어긋남 ${value.discrepancies.join(", ")}`;marks.set(key,value);
    }
  }
  const cardEntryMissing=(s:CardSnapshot)=>pas(s)&&has(s,"qNone")&&s.hasTag("card-entry")&&!has(s,"cPresent");
  const holeTests = [
    {id:"holeCardMissing",parent:"on",label:"판에 올라야 하는데 카드 장이 없음",test:cardEntryMissing},
    {id:"holeQuestionMissing",parent:"on",label:"질문은 열렸는데 판에 장이 없음",test:CARD_PROMISES[0]!.breaks},
    {id:"holeQuestionOff",parent:"off",label:"질문을 연 채 내려간 카드",test:(s:CardSnapshot)=>open(s)&&has(s,"off")},
    {id:"holeOrphan",parent:"card.question",label:"철회할 세션이 없는 질문",test:CARD_PROMISES[3]!.breaks},
    {id:"holeChangedLimitOwner",parent:"limit",label:"담당이 바뀐 한도 막힘",test:(s:CardSnapshot)=>has(s,"limit")&&(has(s,"lDifferent")||has(s,"lDifferentLong"))},
  ];
  const holes:CardHole[]=holeTests.map(h=>({id:h.id,parent:h.parent,label:h.label,reachable:states.some(h.test),incoming:[]}));
  const definitions=new Set<string>();
  for(const a of Object.values(adjacency)) for(const edge of Object.values<{event:CardEvent;state:CardSnapshot}>(a.transitions)) {
    const event=edge.event;
    for(const t of cardMachine.getTransitionData(a.state,event)) definitions.add(`${t.source.id}:${event.type}:${(typeof t.guard==="string"?t.guard:typeof t.guard==="object"?t.guard.type:"composed")}:${t.target?.map(n=>n.id).join(",")??""}`);
    const b=edge.state;
    if(cardEntryMissing(b)&&(!cardEntryMissing(a.state)||event.type==="BOARD_ROOM")) mark(a.state,event,1);
    if(CARD_PROMISES[0]!.breaks(b)) {
      if(event.type==="ASK_OWNER"||event.type==="ASK_OTHER"||event.type==="BOARD_ROOM") mark(a.state,event,1);
      if(has(a.state,"done")||has(a.state,"cancelled")) mark(a.state,event,7);
    }
    if(CARD_PROMISES[1]!.breaks(a.state)&&["SERVER_LIVE_RESUME","SERVER_LIMIT_RELAUNCH"].includes(event.type)&&has(b,"running")) mark(a.state,event,2);
    if(CARD_PROMISES[2]!.breaks(a.state)&&event.type==="ANSWER_DETAIL") mark(a.state,event,4);
    if(CARD_PROMISES[3]!.breaks(b)) mark(a.state,event,8);
    holeTests.forEach((h,i)=>{
      if(!h.test(a.state)&&h.test(b)) {
        const incoming=holes[i]!.incoming;
        const source=cardMachine.getTransitionData(a.state,event).find(t=>t.target?.length)?.source.id??"status";
        if(!incoming.some(x=>x.from===source&&x.label===EVENT_LABELS[event.type])) incoming.push({from:source,label:EVENT_LABELS[event.type]!});
      }
    });
  }
  const missingCards=states.filter(cardEntryMissing);
  const cardEntryPromise:PromiseResult={id:1,name:"판에 올라야 할 장은 판에 있다 (1-나 카드 장)",kept:missingCards.length===0,violations:missingCards.length,example:missingCards.length?pathByValue.get(JSON.stringify(missingCards[0]!.value))??[]:[],discrepancies:[1]};
  holes[0]!.note="이번 대조에서 새로 발견. 가득 찬 판에서 질문 장을 버리는 어긋남 1과 같은 뿌리";
  return {promises,cardEntryPromise,marks:{states:[] as string[],transitions:[...marks.values()]},holes,configurationCount:states.length,definitionCount:definitions.size,adjacency,paths};
}

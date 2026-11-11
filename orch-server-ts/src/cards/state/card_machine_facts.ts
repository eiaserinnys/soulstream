import type { StateValue } from "xstate";
/** Read facts under the card lock when this mapper is used in production later. */
export interface CardFacts {
  status:"uncreated"|"todo"|"queued"|"running"|"blocked"|"review"|"awaiting_verification"|"on_hold"|"done"|"cancelled";
  blockedKind?:"question"|"limit"|"no_report"|null;
  blockedDetail?:string|null;
  assignee:"none"|"agent"|"human"|"originalLive"|"originalEnded"|"originalLimited"|"originalLongLimited"|"replacedLive"|"replacedEnded"|"replacedLimited";
  openQuestion?:"owner"|"orphan"|"other"|null;
  wakeAt?:string|Date|null;
  /** readLimitAutoResumeAt(current owner), NOT the former owner's deadline. */
  limitResumeAt?:string|Date|null;
  pas?:"none"|"room"|"full";
  questionEntry?:boolean;
  cardEntry?:boolean;
  /** Historical observation: caller supplies operation/event history or a test observer. */
  limitedOwner?:"none"|"same"|"different"|"sameLong"|"differentLong";
}
export function cardFactsToStateValue(f:CardFacts):StateValue {
  let status:StateValue;
  if (f.status==="uncreated") status="uncreated";
  else if (["on_hold","done","cancelled"].includes(f.status)) status={off:f.status==="on_hold"?"hold":f.status};
  else if (f.status==="todo"||f.status==="queued") status={on:{ready:f.status==="todo"?"todo":{queued:f.blockedDetail==="담당 에이전트 없음"?"missing":"normal"}}};
  else if (f.status==="running") status={on:"running"};
  else if (f.status==="review"||(f.status==="blocked"&&f.blockedKind==="limit")) status={on:{silent:f.status==="review"?"review":"limit"}};
  else status={on:{talk:f.status==="awaiting_verification"?"verification":f.blockedKind==="question"?"question":f.blockedKind==="no_report"?"noReport":"other"}};
  return {status,cardEntry:f.cardEntry?"present":"none",question:f.openQuestion??"none",reservation:f.wakeAt?"verify":f.status==="blocked"&&f.blockedKind==="limit"&&f.limitResumeAt?"limit":"none",assignee:f.assignee,
    questionEntry:f.questionEntry?"present":"none",pasBoard:!f.pas||f.pas==="none"?"none":{available:f.pas},limitedOwner:f.limitedOwner??"none"};
}

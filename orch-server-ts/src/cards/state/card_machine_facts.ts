import type { StateValue } from "xstate";
/** Read facts under the card lock when this mapper is used in production later. */
export interface CardFacts {
  status:"uncreated"|"todo"|"queued"|"running"|"blocked"|"review"|"awaiting_verification"|"on_hold"|"done"|"cancelled";
  blockedKind?:"question"|"limit"|"no_report"|null;
  blockedDetail?:string|null;
  assignee:"none"|"agentAdmitted"|"agent"|"human"|"originalLive"|"originalEnded"|"originalLimited"|"originalLongLimited"|"replacedLive"|"replacedEnded"|"replacedLimited";
  openQuestion?:"owner"|"orphan"|"other"|null;
  wakeAt?:string|Date|null;
  /** Persisted reservation columns, never recomputed from termination events. */
  limitResumeAt?:string|Date|null;
  limitResumeSessionId?:string|null;
  assigneeSessionId?:string|null;
  supervised:boolean;
  /** Raw metadata counts. Numbers are facts only, never machine context. */
  boardEntryCount:number;
  cardEntryCount:number;
  questionEntryCount:number;
}
export function cardFactsToStateValue(f:CardFacts):StateValue {
  let status:StateValue;
  if (f.status==="uncreated") status="uncreated";
  else if (["on_hold","done","cancelled"].includes(f.status)) status={off:f.status==="on_hold"?"hold":f.status};
  else if (f.status==="todo"||f.status==="queued") status={on:{ready:f.status==="todo"?"todo":{queued:f.blockedDetail==="담당 에이전트 없음"?"missing":"normal"}}};
  else if (f.status==="running") status={on:"running"};
  else if (f.status==="review"||(f.status==="blocked"&&f.blockedKind==="limit")) status={on:{silent:f.status==="review"?"review":"limit"}};
  else status={on:{talk:f.status==="awaiting_verification"?"verification":f.blockedKind==="question"?"question":f.blockedKind==="no_report"?"noReport":"other"}};
  const otherEntries=f.boardEntryCount-f.cardEntryCount-f.questionEntryCount;
  const stage=otherEntries>=12?"full":otherEntries===11?"one":"room";
  return {status,cardEntry:f.cardEntryCount>0?"present":"none",question:f.openQuestion??"none",reservation:f.wakeAt?"verify":f.limitResumeSessionId?(f.limitResumeAt?"limit":"longLimit"):"none",assignee:f.assignee==="agentAdmitted"?{agent:"admitted"}:f.assignee,
    questionEntry:f.questionEntryCount>0?"present":"none",pasBoard:f.supervised?{available:stage}:"none",limitedOwner:!f.limitResumeSessionId?"none":f.limitResumeSessionId===f.assigneeSessionId?(f.limitResumeAt?"same":"sameLong"):(f.limitResumeAt?"different":"differentLong")};
}

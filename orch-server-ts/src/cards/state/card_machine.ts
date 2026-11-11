import { setup, stateIn, and, or, not } from "xstate";
import { EVENT_LABELS, STATUS_LEAVES, MEMORY_CHART_GROUPS, type StatusLeaf } from "./card_machine_events.js";

// All guards inspect the pre-event configuration. Parallel regions consume an
// event together; actions are labels only, never production side effects.
const at = (id:string) => stateIn(`#${id}`);
const any = (...ids:string[]) => or(ids.map(at));
const session = any("originalLive","originalEnded","originalLimited","originalLongLimited","replacedLive","replacedEnded","replacedLimited");
const live = any("originalLive","replacedLive");
const open = not(at("qNone"));

const off = at("off");
type Predicate=ReturnType<typeof stateIn>;
const guards:Record<string,Predicate> = {
  always: and([]), unborn: at("uncreated"), session, live, open,
  agentRest: or([session,any("aNone","aAgent")]),
  newQuestionOwner: and([session,at("qNone")]),
  newQuestionOther: and([any("aNone","aAgent","aHuman"),at("qNone")]),
  supervised: not(at("pasNone")),
  noPas: at("pasNone"),
  otherAddedOne: any("pasRoom","pasOne"),
  otherAddedFull: and([any("pasRoom","pasOne"),at("cNone"),at("eNone")]),
  otherRemovedOne: at("pasFull"),
  canAskOther: any("aNone","aAgent","aHuman"),
  canWithdraw: and([session,open]),
  boardAnswer: open,
  authorWithdraw: open,
  answerBlocked: and([open,at("question")]),
  humanResume: and([session,at("talk")]),
  shortLimit: and([at("running"),live]),
  limitTime: and([at("limit"),session,at("rLimit"),at("lSame")]),
  relaunch: and([at("limit"),session,at("rLongLimit"),at("lSameLong")]),
  limitBlocked: at("limit"),
  verification: and([at("verification"),session]),
  running: at("running"), queued: at("queued"),
  admittedStart: and([at("queued"),at("aAgentAdmitted")]),
  queuedAssignable: and([at("queued"),or([session,at("aAgent")])]),
  limitAssignable: and([at("limit"),session,at("rLongLimit"),at("lSameLong")]),
  queuedMissing: and([at("queued"),any("aNone","aHuman")]),
  unstarted: any("todo","queued","queuedMissing","hold"),
  idle: and([not(live),not(at("aHuman")),not(at("running"))]),
  unassigned: any("aNone","aAgent"),
  mergeable: and([any("todo","queued","hold"),any("aNone","aAgent")]),
  assign: not(off),
  replaceLimit: and([session,at("limit")]),
  replaceable: and([session,any("limit","question")]),
};
type GuardName=keyof typeof guards;
type Region="status"|"question"|"reservation"|"assignee"|"questionEntry"|"pasBoard"|"limitedOwner"|"cardEntry";
type Rule={target?:string; guard?:GuardName | Predicate; actions?:string[]; description?:string; meta?:Record<string,unknown>};
const on:Record<Region,Record<string,Rule|Rule[]>>={status:{},question:{},reservation:{},assignee:{},questionEntry:{},pasBoard:{},limitedOwner:{},cardEntry:{}};
function put(region:Region,event:string,target:string|undefined,guard:GuardName="always",extra:Partial<Rule>={}) {
  on[region][event]={target:target?`#${target}`:undefined,guard,description:EVENT_LABELS[event],...extra};
}
function status(event:string,target:StatusLeaf,guard:GuardName="always",free=false) {
  put("status",event,target,guard,{
    ...(free?{meta:{chartGroup:"free-move"}}:{}),
    actions:["판 알림",...(["SERVER_LIMIT_TIME","SERVER_LIMIT_RELAUNCH","WAKE_TIME"].includes(event)?["담당 깨우기"]:[])],
  });
  if (target==="limit") {
    on.reservation[event]=[{target:"#rNone",guard:and([guards[guard]!,not(at("limit"))]),description:EVENT_LABELS[event]}];
    on.limitedOwner[event]=[{target:"#lNone",guard:and([guards[guard]!,not(at("limit"))]),description:EVENT_LABELS[event]}];
  } else {
    put("reservation",event,target==="verification"?"rVerify":"rNone",guard);
    put("limitedOwner",event,"lNone",guard);
  }
  // syncReportsAfterCommit compares the stored status column, not blocked_kind.
  // A blocked -> blocked write alone does not sync the board.
  const blockedTarget=["question","noReport","other","limit"].includes(target);
  const sync=and([guards[guard]!,...(blockedTarget&&!event.startsWith("ASK_")?[not(any("question","noReport","other","limit"))]:[])]);
  if (event.startsWith("ASK_")||["verification","todo","queued","running","hold","done","cancelled"].includes(target)) put("cardEntry",event,"cNone",guard);
  else on.cardEntry[event]=[
    {target:"#cPresent",guard:and([sync,at("qNone"),any("pasRoom","pasOne")]),description:EVENT_LABELS[event]},
    {target:"#cNone",guard:and([sync,open]),description:EVENT_LABELS[event]},
  ];
  // syncCard removes existing question entries when the card leaves the board.
  // Reposting occurs only when leaving hold, not done/cancelled (어긋남 7).
  if (["hold","done","cancelled"].includes(target)) put("questionEntry",event,"eNone",guard);
  else on.questionEntry[event]=[
    {target:"#ePresent",guard:and([guards[guard]!,at("hold"),open,any("pasRoom","pasOne")]),description:EVENT_LABELS[event]},
  ];
}
for (const key of Object.keys(STATUS_LEAVES) as StatusLeaf[]) {
  status(`HUMAN_MOVE_${key}`,key,key==="verification"?"session":"always",true);
  // This event is the current assignee path; claiming is represented separately.
  const guard = ["todo","queued","hold","cancelled"].includes(key)?"agentRest":"session";
  status(`ASSIGNEE_MOVE_${key}`,key,guard,true);
}
status("CREATE_TODO","todo","unborn");status("CREATE_QUEUED","queued","unborn");
for (const event of ["ASK_OWNER","ASK_OTHER"]) {
  const guard=event==="ASK_OWNER"?"newQuestionOwner":"newQuestionOther";
  status(event,"question",guard);
  put("question",event,event==="ASK_OWNER"?"qOwner":"qOrphan",guard);
  on.questionEntry[event]=[
    {guard:and([guards[guard]!,any("pasRoom","pasOne")]),target:"#ePresent",description:EVENT_LABELS[event],actions:["질문 장 올리기"]},
  ];
}
for (const event of ["ANSWER_DETAIL","ANSWER_BOARD","WITHDRAW","WITHDRAW_AUTHOR"]) {
  const guard=event==="WITHDRAW"?"canWithdraw":event==="WITHDRAW_AUTHOR"?"authorWithdraw":event==="ANSWER_BOARD"?"boardAnswer":"open";
  put("question",event,"qNone",guard);put("questionEntry",event,"eNone",guard);
  on.status[event]=[{target:"#running",guard:and([guards[guard]!,at("question")]),description:EVENT_LABELS[event]}];
  on.cardEntry[event]=[
    {target:"#cPresent",guard:and([guards[guard]!,any("review","noReport","other","limit"),any("pasRoom","pasOne")]),description:EVENT_LABELS[event]},
    {target:"#cNone",guard:and([guards[guard]!,not(any("review","noReport","other","limit"))]),description:EVENT_LABELS[event]},
  ];
  // answerQuestion writes status only for the last question on question-blocked cards.
}
for (const event of ["HUMAN_MESSAGE","HUMAN_COMMENT"]) {
  status(event,"running","humanResume");put("question",event,"qNone","humanResume",{actions:["열린 질문 닫기"]});
  put("questionEntry",event,"eNone","humanResume");
}
put("question","AGENT_COMMENT",undefined,"session");
status("START_ADMITTED_WORK","running","admittedStart");
put("assignee","START_ADMITTED_WORK","originalLive","admittedStart");
on.question.START_ADMITTED_WORK=[{target:"#qOther",guard:and([guards.admittedStart!,at("qOrphan")]),description:EVENT_LABELS.START_ADMITTED_WORK}];
status("START_WORK","running","session");status("REQUEST_REVIEW","review","session");
status("RECORD_EXECUTION","running");on.assignee.RECORD_EXECUTION=[
  {target:"#replacedLive",guard:any("replacedLive","replacedLimited","replacedEnded"),description:EVENT_LABELS.RECORD_EXECUTION},
  {target:"#originalLive",description:EVENT_LABELS.RECORD_EXECUTION},
];
on.assignee.RECORD_EXECUTION_LATE=(Array.isArray(on.assignee.RECORD_EXECUTION)?on.assignee.RECORD_EXECUTION:[]).map(r=>({...r}));
for(const event of ["RECORD_EXECUTION","RECORD_EXECUTION_LATE"])
  on.question[event]=[{target:"#qOther",guard:at("qOrphan"),description:EVENT_LABELS[event]}];
on.assignee.START_WORK=[
  {target:"#replacedLive",guard:and([session,any("replacedLive","replacedLimited","replacedEnded")]),description:EVENT_LABELS.START_WORK},
  {target:"#originalLive",guard:session,description:EVENT_LABELS.START_WORK},
];
status("DISPATCH","running","queued");
put("status","ADMIT_DISPATCH",undefined,"queuedAssignable");
on.assignee.ADMIT_DISPATCH=[{target:"#aAgentAdmitted",guard:and([at("queued"),at("aAgent")]),description:EVENT_LABELS.ADMIT_DISPATCH}];
for (const event of ["SERVER_SHORT_LIMIT","SERVER_LONG_LIMIT"]) {
  status(event,"limit","shortLimit");
  put("reservation",event,event==="SERVER_SHORT_LIMIT"?"rLimit":"rLongLimit","shortLimit");
  put("assignee",event,event==="SERVER_SHORT_LIMIT"?"originalLimited":"originalLongLimited","shortLimit");
  put("limitedOwner",event,event==="SERVER_SHORT_LIMIT"?"lSame":"lSameLong","shortLimit");
}
for (const [event,guard] of [["SERVER_LIMIT_TIME","limitTime"],["SERVER_LIMIT_RELAUNCH","relaunch"]] as const)
  status(event,"running",guard);
put("status","SERVER_LIVE_RESUME",undefined,"limitBlocked");
put("status","SERVER_LIMIT_REQUEUE",undefined,"limitBlocked");
status("ADMIT_LIMIT","queued","limitAssignable");
status("WAKE_TIME","running","verification");status("WAKE_FAIL","noReport","verification");
status("CREATE_FAIL","noReport","running");status("ATTACHMENT_FAIL","noReport","limitBlocked");
put("status","NOTE_MISSING","queuedMissing","queuedMissing");
put("assignee","ASSIGN_SESSION","originalLive","unassigned");
on.question.ASSIGN_SESSION=[{target:"#qOther",guard:and([guards.unassigned!,at("qOrphan")]),description:EVENT_LABELS.ASSIGN_SESSION}];
put("assignee","ASSIGN_AGENT","aAgent","mergeable");
put("assignee","ASSIGN_HUMAN","aHuman","unassigned");
for (const event of ["REPLACE_LIVE","REPLACE_LIMITED"]) {
  put("assignee",event,event==="REPLACE_LIVE"?"replacedLive":"replacedLimited","replaceable");
  put("reservation",event,"rNone","replaceLimit");
  put("limitedOwner",event,"lNone","replaceLimit");
  on.question[event]=[{target:"#qOther",guard:and([guards.replaceable!,at("qOwner")]),description:EVENT_LABELS[event]}];
}
on.assignee.OWNER_END=[
  {target:"#originalEnded",guard:at("originalLive"),description:EVENT_LABELS.OWNER_END},
  {target:"#replacedEnded",guard:at("replacedLive"),description:EVENT_LABELS.OWNER_END},
];
put("pasBoard","PAS_APPEARS","pasRoom","noPas");
put("pasBoard","BOARD_ONE","pasOne","otherAddedOne");
put("pasBoard","BOARD_FULL","pasFull","otherAddedFull");
put("pasBoard","BOARD_ROOM","pasRoom","supervised");
put("pasBoard","BOARD_OTHER_REMOVED","pasOne","otherRemovedOne");
for (const [event,target] of [["BULK_TODO","todo"],["BULK_QUEUED","queued"],["BULK_HOLD","hold"],["BULK_CANCELLED","cancelled"]] as const) status(event,target,target==="todo"||target==="queued"?"unassigned":"idle");
status("MERGE_SOURCE","cancelled","mergeable");

// A card is created once. Other commands require an existing card.
for(const handlers of Object.values(on)) for(const [event,value] of Object.entries(handlers)) {
  if(event.startsWith("CREATE_QUEUED")||event==="CREATE_TODO") continue;
  for(const rule of Array.isArray(value)?value:[value]) {
    const guard=typeof rule.guard==="string"?guards[rule.guard]!:rule.guard;
    rule.guard=and([not(at("uncreated")),...(guard?[guard]:[])]);
  }
}
// Give every composite branch a stable registered name for coverage and charts.
for(const [region,handlers] of Object.entries(on)) for(const [event,value] of Object.entries(handlers))
  (Array.isArray(value)?value:[value]).forEach((rule,index)=>{
    if(typeof rule.guard!=="string" && rule.guard) {
      const name=`${region}_${event}_${index}`;
      guards[name]=rule.guard;rule.guard=name;
    }
  });
// Repeated memory writes are grouped only in the diagrams. Guards, actions,
// targets and the definition identities used by contrast tests are unchanged.
for(const [region,handlers] of Object.entries(on))for(const value of Object.values(handlers))
  for(const rule of Array.isArray(value)?value:[value]) {
    const group=`memory-${region}-${rule.target?.slice(1)}`;
    if(MEMORY_CHART_GROUPS[group])rule.meta={...rule.meta,chartGroup:group};
  }
// Shared transitions live on their actual hierarchical source. In particular,
// all children of talk inherit the human-input resume rule once.
function statusEvents(...events:string[]) {
  const result:Record<string,Rule|Rule[]>={};
  for(const event of events){result[event]=on.status[event]!;delete on.status[event];}
  return result;
}
const local={
  uncreated:statusEvents("CREATE_TODO","CREATE_QUEUED"),
  queued:statusEvents("DISPATCH","ADMIT_DISPATCH","NOTE_MISSING"),
  running:statusEvents("SERVER_SHORT_LIMIT","SERVER_LONG_LIMIT","CREATE_FAIL"),
  talk:statusEvents("HUMAN_MESSAGE","HUMAN_COMMENT"),
  question:statusEvents("ANSWER_DETAIL","ANSWER_BOARD","WITHDRAW","WITHDRAW_AUTHOR"),
  limit:statusEvents("SERVER_LIVE_RESUME","SERVER_LIMIT_TIME","SERVER_LIMIT_RELAUNCH","SERVER_LIMIT_REQUEUE","ADMIT_LIMIT","ATTACHMENT_FAIL"),
  verification:statusEvents("WAKE_TIME","WAKE_FAIL"),
};
const leaf=(id:string,description:string,tags:string[]=[])=>({id,description,tags});
const stateLeaf=(id:StatusLeaf,tags:string[]=[])=>leaf(id,STATUS_LEAVES[id],tags);
// Config types permit a guard object as well as its registered name. The local
// Rule type keeps the region builder small; XState checks the complete config.
export const cardMachine=setup({
  types:{events:{} as {type:string}},
  guards,
  actions:Object.fromEntries(["열린 질문 닫기","질문 장 올리기","담당 깨우기","판 알림"].map(name=>[name,()=>{}])),
}).createMachine({
  id:"card",type:"parallel",description:"현행 카드 규칙 (운영 코드와 대조할 모형)",
  states:{
    status:{id:"status",description:"카드 상태",initial:"uncreated",on:on.status,states:{
      uncreated:{...leaf("uncreated","아직 만들지 않음"),on:local.uncreated},
      on:{id:"on",description:"판 위",initial:"ready",states:{
        ready:{id:"ready",description:"준비",initial:"todo",states:{
          todo:stateLeaf("todo",["unstarted","without-assignee"]),
          queued:{...stateLeaf("queued",["unstarted","without-assignee"]),on:local.queued,initial:"normal",states:{normal:leaf("queuedNormal","대기열"),missing:leaf("queuedMissing","담당 에이전트 없음 표시",["unnamed"]) }},
        }},
        running:{...stateLeaf("running"),on:local.running},
        talk:{id:"talk",description:"말로 풀리는 기다림",on:local.talk,initial:"other",states:{
          question:{...stateLeaf("question",["card-entry","timeline"]),on:local.question},
          noReport:stateLeaf("noReport",["card-entry","timeline"]),other:stateLeaf("other",["card-entry","timeline"]),
          verification:{...stateLeaf("verification"),on:local.verification},
        }},
        silent:{id:"silent",description:"말로 안 풀리는 기다림",initial:"review",states:{limit:{...stateLeaf("limit",["card-entry","timeline"]),on:local.limit},review:stateLeaf("review",["card-entry","timeline"]) }},
      }},
      off:{id:"off",description:"내려감",initial:"hold",states:{hold:stateLeaf("hold",["unstarted","without-assignee","timeline"]),done:stateLeaf("done",["ended","timeline"]),cancelled:stateLeaf("cancelled",["ended","without-assignee","timeline"]) }},
    }},
    question:{description:"열린 질문",initial:"none",on:on.question,states:{none:leaf("qNone","없음"),owner:leaf("qOwner","지금 담당이 올린 질문"),orphan:leaf("qOrphan","담당 없이 올린 질문"),other:leaf("qOther","옛 담당이 올린 질문")}},
    reservation:{description:"카드에 기록된 담당 재개 예약",initial:"none",on:on.reservation,states:{none:leaf("rNone","없음"),verify:leaf("rVerify","카드에 적힌 검증 시각"),limit:leaf("rLimit","카드에 적힌 짧은 한도 시각"),longLimit:leaf("rLongLimit","시각 없이 담당만 기록한 한도 재개")}},
    assignee:{description:"담당",initial:"none",on:on.assignee,states:{none:leaf("aNone","담당 없음"),agent:{...leaf("aAgent","에이전트만 정해짐"),initial:"idle",states:{idle:leaf("aAgentIdle","배정 전"),admitted:leaf("aAgentAdmitted","배정을 허가받고 첫 착수를 기다림",["unnamed"]) }},human:leaf("aHuman","사람"),originalLive:leaf("originalLive","원래 담당이 살아 있음"),originalEnded:leaf("originalEnded","원래 담당이 정상 종료"),originalLimited:leaf("originalLimited","원래 담당이 짧은 한도 종료"),originalLongLimited:leaf("originalLongLimited","원래 담당이 긴 한도 종료"),replacedLive:leaf("replacedLive","새 담당이 살아 있음"),replacedEnded:leaf("replacedEnded","새 담당이 정상 종료"),replacedLimited:leaf("replacedLimited","새 담당이 긴 한도 종료")}},
    // 걸음 2에서 판의 장을 구성에서 계산하는 출력으로 바꾸며 이 영역을 지운다.
    questionEntry:{description:"감독 판의 질문 장 (현행 코드의 기억)",initial:"none",on:on.questionEntry,states:{none:leaf("eNone","질문 장 없음"),present:leaf("ePresent","질문 장 있음")}},
    cardEntry:{description:"감독 판의 카드 장 (현행 코드의 기억, 걸음 2에서 계산 출력으로 바꿈)",initial:"none",on:on.cardEntry,states:{none:leaf("cNone","카드 장 없음"),present:leaf("cPresent","카드 장 있음")}},
    pasBoard:{description:"감독 PAS와 이 카드의 것이 아닌 장의 수 (환경)",initial:"none",on:on.pasBoard,states:{none:leaf("pasNone","감독 PAS 없음"),available:{description:"감독 PAS 있음",initial:"room",states:{room:leaf("pasRoom","다른 장 여유 (10장 이하)"),one:leaf("pasOne","다른 장 한 자리 남음 (11장)"),full:leaf("pasFull","다른 장 가득 (12장)")}}}},
    limitedOwner:{description:"카드에 기록된 한도 담당과 현재 담당의 관계",initial:"none",on:on.limitedOwner,states:{none:leaf("lNone","기록된 한도 담당 없음"),same:leaf("lSame","시각 있는 예약의 담당이 지금 담당"),sameLong:leaf("lSameLong","시각 없는 예약의 담당이 지금 담당"),differentLong:leaf("lDifferentLong","시각 없는 예약의 담당 불일치 (DB가 금지)",["unnamed"]),different:leaf("lDifferent","시각 있는 예약의 담당 불일치 (DB가 금지)",["unnamed"]) }},
  },
});
export type CardSnapshot=ReturnType<typeof cardMachine.resolveState>;
/** Read the existing memories; this is not the proposed step-2 calculation. */
export function boardEntriesOf(snapshot:CardSnapshot):("question"|"card")[] {
  const entries:("question"|"card")[]=[];
  if (snapshot.matches({questionEntry:"present"})) entries.push("question");
  if (snapshot.matches({cardEntry:"present"})) entries.push("card");
  return entries;
}

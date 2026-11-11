import { toMermaid, type ChartSpec } from "../../statechart/mermaid.js";
import { cardMachine } from "./card_machine.js";
import { CARD_EVENTS, EVENT_LABELS, EVENT_SOURCES, STATUS_DECISIONS, MEMORY_CHART_GROUPS } from "./card_machine_events.js";
import { checkCardPromises } from "./card_machine_promises.js";

export type CardPromiseReport=ReturnType<typeof checkCardPromises>;
interface CardChartPlan {id:string;title:string;explanation:string;spec:ChartSpec;events:string[];holes:string[]}
const freeMove="HUMAN_MOVE_running";
const groups={...MEMORY_CHART_GROUPS,"free-move":{from:"status",to:"status",label:"디렉터와 담당은 상태를 직접 옮긴다 [담당 권한 안에서]"}};
const plans:CardChartPlan[]=[
  {id:"01-overview",title:"전체: 상태와 함께 움직이는 기억",explanation:"카드 상태는 계층으로, 질문·예약·담당·판의 장은 나란한 영역으로 읽는다. 접힌 상자의 빨강은 그 아래에 약속을 어기는 구성이 도달한다는 뜻이다.",
    events:[freeMove,"ASK_OWNER","ASK_OTHER","HUMAN_MESSAGE","SERVER_SHORT_LIMIT","SERVER_LIVE_RESUME","SERVER_LIMIT_RELAUNCH","WAKE_TIME","REQUEST_REVIEW"],
    holes:["holeCardMissing","holeQuestionMissing","holeQuestionOff","holeChangedLimitOwner"],
    spec:{include:["card"],hide:["uncreated"],collapse:["ready","talk","silent","off","card.question","card.reservation","card.assignee","card.questionEntry","card.cardEntry","card.pasBoard","card.limitedOwner"]}},
  {id:"02-status",title:"카드 상태: 같은 기다림에서 물려받는 규칙",explanation:"말로 풀리는 기다림의 세 자식은 디렉터가 말하면 재개하는 규칙을 함께 물려받는다. 자유 이동 하나가 모든 잎 상태의 직접 이동을 대표한다.",
    events:[freeMove,"ASK_OWNER","HUMAN_MESSAGE","SERVER_SHORT_LIMIT","SERVER_LIVE_RESUME","SERVER_LIMIT_RELAUNCH","WAKE_TIME","WAKE_FAIL","REQUEST_REVIEW","ANSWER_DETAIL"],
    holes:["holeCardMissing","holeQuestionMissing","holeQuestionOff","holeChangedLimitOwner"],
    spec:{include:["status"],hide:["uncreated"]}},
  {id:"03-question",title:"질문: 기록은 열려 있어도 판의 장은 사라진다",explanation:"질문 한 개의 열림과 판에 저장된 질문 장은 별개의 기억이다. 완료와 취소 뒤 늦은 답도 카드 상세와 감독 판에서 받고 상태는 그대로 둔다. 질문을 올린 세션과 현재 담당이 철회할 수 있다.",
    events:[freeMove,"HUMAN_MOVE_hold","HUMAN_MOVE_done","ASK_OWNER","ASK_OTHER","ANSWER_DETAIL","ANSWER_BOARD","WITHDRAW","WITHDRAW_AUTHOR","HUMAN_MESSAGE"],
    holes:["holeQuestionMissing","holeQuestionOff"],
    spec:{include:["status","card.question","card.questionEntry","card.assignee","card.pasBoard"],hide:["uncreated"],collapse:["on","off","card.assignee","card.pasBoard"]}},
  {id:"04-limit-owner",title:"한도: 카드에 기록된 담당과 예약으로 재개한다",explanation:"한도 진입 때 담당과 선택적인 재개 시각을 카드에 기록한다. 담당 교체와 한도 탈출은 두 칸을 함께 지운다. 짧은 한도는 시각이 지난 뒤, 긴 한도는 모델이 풀린 뒤 기록된 같은 담당만 잇는다.",
    events:["SERVER_SHORT_LIMIT","SERVER_LONG_LIMIT","REPLACE_LIVE","REPLACE_LIMITED","SERVER_LIVE_RESUME","SERVER_LIMIT_TIME","SERVER_LIMIT_RELAUNCH"],
    holes:["holeChangedLimitOwner"],
    spec:{include:["status","card.reservation","card.assignee","card.limitedOwner"],hide:["uncreated","rVerify","aNone","aAgent","aHuman","originalEnded","replacedEnded","lDifferent","lDifferentLong"],collapse:["ready","talk","off","review"]}},
  {id:"05-board",title:"판: 다른 장 수와 이 카드의 장을 따로 센다",explanation:"환경은 다른 장이 10장 이하·11장·12장인 세 단계다. 이 카드의 카드 장을 먼저 내린 뒤 질문 장을 올리므로, 다른 장이 11장이면 교체할 한 자리가 남는다. 다른 장이 12장이면 새 장을 버리며, 이후 빈자리가 나도 질문 장을 복구하지 않는다.",
    events:["HUMAN_MOVE_review","ASK_OWNER","ANSWER_DETAIL","BOARD_ONE","BOARD_FULL","BOARD_ROOM","BOARD_OTHER_REMOVED"],
    holes:[],
    spec:{include:["card.cardEntry","card.questionEntry","card.pasBoard"]}},
];

// View-only containers: the generated states retain their identities and nesting.
// Parallel columns match the hand-drawn overview; LR stacks disconnected memory
// regions vertically in the statechart renderer. No semantic edge is added.
function overviewColumns(mermaid:string) {
  const lines=mermaid.split("\n");
  const start=lines.findIndex(line=>line.startsWith('    state "열린 질문"'));
  const end=lines.indexOf("}");
  return [...lines.slice(0,start),"    --",'    state "카드 상태와 동시에 움직이는 기억" as overviewMemory {',"        direction LR",
    ...lines.slice(start,end).filter(line=>!line.trimStart().startsWith("status -->")).map(line=>`    ${line}`),"    }",
    ...lines.slice(start,end).filter(line=>line.trimStart().startsWith("status -->")),...lines.slice(end)].join("\n");
}

function questionColumns(mermaid:string) {
  const lines=mermaid.split("\n");
  const start=lines.findIndex(line=>line.startsWith('state "'));
  let end=start,depth=0;
  do {if(lines[end]!.endsWith("{"))depth++;if(lines[end]!.trim()==="}")depth--;end++;}while(depth>0);
  const tail=lines.findIndex((line,index)=>index>=end&&/^(\w+ -->|class )/.test(line));
  return [...lines.slice(0,start),'state "질문의 상태와 기억" as questionView {',"    direction TB",
    ...lines.slice(start,end).map(line=>`    ${line}`),"    --",'    state "동시에 움직이는 질문과 판의 기억" as questionMemory {',"        direction LR",
    ...lines.slice(end,tail).map(line=>`        ${line}`),"    }","}",...lines.slice(tail)].join("\n");
}

export function renderCardCharts(report:CardPromiseReport) {
  return plans.map(plan=>{
    const events=new Set(plan.events);
    const visible=(id:string)=>{
      let node:typeof cardMachine.root|undefined=cardMachine.getStateNodeById(id),included=false;
      while(node){if(plan.spec.hide?.includes(node.id))return false;if(plan.spec.include.includes(node.id))included=true;node=node.parent;}
      return included;
    };
    const labels=new Set(plan.events.map(e=>EVENT_LABELS[e]));
    const holes=report.holes.filter(h=>plan.holes.includes(h.id)).map(h=>({...h,incoming:h.incoming.filter(e=>visible(e.from)&&labels.has(e.label)).slice(0,1)}));
    const projectedGroups=Object.fromEntries(Object.entries(groups).map(([key,group])=>[key,{...group}]));
    const groupMarks=new Map<string,Set<number>>();
    for(const mark of report.marks.transitions) if(events.has(mark.event))
      for(const transition of cardMachine.getStateNodeById(mark.source).on[mark.event]??[]) {
        const key=transition.meta?.chartGroup;
        if(typeof key!=="string"||!projectedGroups[key])continue;
        const numbers=groupMarks.get(key)??new Set<number>();
        mark.discrepancies.forEach(n=>numbers.add(n));groupMarks.set(key,numbers);
      }
    for(const [key,numbers] of groupMarks) projectedGroups[key]!.label+=` (어긋남 ${[...numbers].sort((a,b)=>a-b).join(", ")})`;
    if(plan.id==="01-overview") {
      // The overview lists the parallel memories; their writes are shown in
      // detail charts, rather than an uninformative loop around the whole card.
      for(const key of Object.keys(projectedGroups))if(key.startsWith("memory-"))
        projectedGroups[key]={from:"uncreated",to:"uncreated",label:projectedGroups[key]!.label};
    }
    const states=[...report.marks.states];
    if(report.holes.some(h=>h.id==="holeOrphan"&&h.reachable))states.push("qOrphan");
    if(plan.id==="05-board") {
      if(report.holes.some(h=>h.id==="holeCardMissing"&&h.reachable))states.push("cNone");
      if(report.holes.some(h=>h.id==="holeQuestionMissing"&&h.reachable))states.push("eNone");
    }
    const spec:ChartSpec={...plan.spec,groups:projectedGroups,parallel:"stack",
      hideEvents:CARD_EVENTS.filter(e=>!events.has(e.type)).map(e=>e.type),
      marks:{...report.marks,states},holes};
    const rendered=toMermaid(cardMachine.root,spec);
    if(plan.id==="01-overview")rendered.mermaid=overviewColumns(rendered.mermaid);
    if(plan.id==="03-question")rendered.mermaid=questionColumns(rendered.mermaid);
    if(plan.id==="05-board")rendered.mermaid=rendered.mermaid.replace("direction TB","direction LR");
    return {...plan,...rendered};
  });
}

export function generateCardStateDocument(report:CardPromiseReport=checkCardPromises()) {
  const charts=renderCardCharts(report);
  const stateCount=(node:typeof cardMachine.root):number=>1+Object.values(node.states).reduce((sum,n)=>sum+stateCount(n),0);
  const lines=["# 현행 카드 규칙", "", "이 문서는 XState 정의와 약속 검사에서 생성한다. 걸음 2의 질문 규칙과 저장된 한도 예약을 반영한 현행 모형이다.", "",
    "한 카드에 열린 질문은 하나까지만 대조했다. 한 카드의 동시 질문 여러 개, 보관, 권한 표 전체, 자동 배정 조정자 내부와 임의의 담당 변경 조합은 대조하지 않았다.", "",
    "판의 전체 장 수와 이 카드의 장 수는 DB 사실에서 읽는다. 기계에는 숫자를 저장하지 않고, 다른 장이 10장 이하·11장·12장인 단계만 둔다. 한도 담당과 재개 시각은 cards.limit_resume_session_id와 limit_resume_at에서 읽는다. 시각 없는 예약도 담당을 기록하며, 담당 교체가 기록을 지운다.", "",
    `영역 8개, 상태 노드 ${stateCount(cardMachine.root)}개, 사건 ${CARD_EVENTS.length}개, 도달 구성 ${report.configurationCount}개, 정의별 전이 갈래 ${report.definitionCount}개.`, "",
    "빨강은 약속을 어기는 도달 구성이 있다는 뜻이다. 별표는 이름 없는 상태나 구멍이다. 그림은 사건을 골라 나누며, 같은 사건의 화살표는 해당 그림에서 전부 남기거나 전부 숨긴다. 자유 이동과 같은 결과의 기억 쓰기는 각각 한 화살표로 묶는다. 기억 쓰기 화살표는 값이 실제로 바뀌는 대표 시작과 끝을 나타내며, 이미 같은 값인 쓰기는 따로 그리지 않는다.", ""];
  for(const chart of charts) lines.push(`## ${chart.title}`,"",chart.explanation,"","```mermaid",chart.mermaid,"```","",
    `화살표 ${chart.edgeCount}개. 남긴 사건: ${chart.events.map(e=>EVENT_LABELS[e]).join(" / ")}. 나머지 사건은 아래 전체 표에서 확인한다.`,"");
  lines.push("## 약속 검사", "", "약속 1-나는 이번 실제 DB 대조에서 새로 찾았다. 가득 찬 판에서 신규 카드 장이 사라지는 것으로, 질문 장을 버리는 어긋남 1과 같은 뿌리다.", "",
    "| 약속 | 결과 | 어긋남 | 어긴 구성 수 | 예시 사건 경로 |", "| :-- | :-- | :-- | --: | :-- |");
  for(const p of [report.promises[0]!,report.cardEntryPromise,...report.promises.slice(1)]) lines.push(`| ${p.name} | ${p.kept?"지킴":"어김"} | ${p.discrepancies.join(", ")||"별도 약속"} | ${p.violations} | ${p.example.map(e=>EVENT_LABELS[e]).join(" → ")||"없음"} |`);
  lines.push("", "## 사건과 원문 위치", "", `상태를 정하는 ${Object.keys(STATUS_DECISIONS).length}곳을 사건에 연결했다. 서버의 복합 루프 전체가 아니라 카드 서비스 변경 경계를 대조한다. 한도 자동 재개와 검증 깨우기는 실제 디스패처도 실행한다.`, "",
    "| 사건 | 뜻 | 원문 파일과 함수 |", "| :-- | :-- | :-- |");
  for(const event of CARD_EVENTS)lines.push(`| \`${event.type}\` | ${EVENT_LABELS[event.type]} | ${EVENT_SOURCES[event.type]!.map(s=>`\`${s}\``).join("<br>")} |`);
  lines.push("", "## 다시 만들기", "", "저장소 루트에서 실행한다. 첫 명령은 Markdown을 만들고, 선택한 폴더에는 같은 정의의 Mermaid 원문과 검사 결과도 저장한다.", "",
    "```bash", "corepack pnpm@10.32.1 --dir orch-server-ts exec tsx scripts/card-state-charts.ts <그림 원문 폴더>", "```", "");
  return {markdown:lines.join("\n"),charts,report};
}

import { CARD_SERVER_EVIDENCE_STAGES } from './card_server_command.js';
import { toMermaid, type ChartSpec } from '../../statechart/mermaid.js';
import { cardDecisionMachine } from './card_decision_machine.js';
import { CARD_FACT_VALUES, CARD_ACTORS, type CardDecisionCommand } from './card_decision_facts.js';
import { CARD_DECISION_SOURCES, CARD_COMMAND_ENTRANCES, CARD_RUNTIME_DECISION_CALLS } from './card_decision_inventory.js';
import { checkCardPromises } from './card_machine_promises.js';
import { rowToStateValue, STATUS_PATHS, stateValueToColumns, type CardStateValue } from './card_state_value.js';
import { boardEntriesOf } from './card_machine_world.js';
import { CARD_FAILURES } from './card_decision_errors.js';
export type CardPromiseReport=ReturnType<typeof checkCardPromises>;
const root=cardDecisionMachine.root;
const commands=Object.keys(CARD_FACT_VALUES) as CardDecisionCommand[];
const plans:{id:string;title:string;spec:ChartSpec;events:CardDecisionCommand[]}[]=[
 {id:'01-overview',title:'저장한 상태와 나란한 영역',events:['CREATE','SET_STATUS','ASK_QUESTION','HUMAN_INPUT','BLOCK_FOR_LIMIT','PATCH_CARD_CONTROL'],spec:{include:['cardDecision'],hide:['cardDecision.verdict'],collapse:['s_on','s_off','cardDecision.question','cardDecision.reservation','cardDecision.assignee','cardDecision.archive']}},
 {id:'02-status',title:'카드 상태 계층',events:['CREATE','SET_STATUS','ASK_QUESTION','REQUEST_REVIEW','BLOCK_FOR_LIMIT','RESUME_VERIFICATION'],spec:{include:['cardDecision.status']}},
 {id:'03-question',title:'열린 질문의 기억',events:['ASK_QUESTION','ANSWER_QUESTION','WITHDRAW_QUESTION','HUMAN_INPUT','ADD_COMMENT'],spec:{include:['cardDecision.question']}},
 {id:'04-reservation',title:'예약의 기억',events:['SET_STATUS','BLOCK_FOR_LIMIT','RESUME_SHORT_LIMIT','RESUME_LONG_LIMIT','RESUME_VERIFICATION','PATCH_CARD_CONTROL'],spec:{include:['cardDecision.reservation']}},
 {id:'05-assignee-archive',title:'담당 종류와 보관',events:['CREATE','CLAIM','CONFIRM_EXECUTION','REGISTER_REPLACEMENT','PATCH_CARD_CONTROL'],spec:{include:['cardDecision.assignee','cardDecision.archive']}},
 {id:'06-evidence',title:'서버 증거 단계 지목',events:Object.keys(CARD_SERVER_EVIDENCE_STAGES) as CardDecisionCommand[],spec:{include:['cardDecision.verdict'],targetless:true}},
];
function validateDescriptions(node:typeof root){
 for(const transitions of Object.values(node.on))for(const t of transitions)if(!t.description||!t.meta?.label)throw new Error(`Missing transition description: ${node.id} ${t.eventType}`);
 Object.values(node.states).forEach(validateDescriptions);
}
export function renderCardCharts(report:CardPromiseReport){
 validateDescriptions(root);
 return plans.map(plan=>({...plan,...toMermaid(root,{...plan.spec,parallel:'stack',hideEvents:commands.filter(c=>!plan.events.includes(c)),marks:report.marks,
 holes:plan.id==='02-status'?report.holes.filter(h=>h.id!=='holeOrphan'):plan.id==='03-question'?report.holes.filter(h=>h.id==='holeOrphan'):[]})}));
}
function permission(report:CardPromiseReport,c:CardDecisionCommand,actor:string,entrance:string|null=null){
 const family=actor==='human'?'human':actor==='server'?'server':'agent';
 const metadata=cardDecisionMachine.getStateNodeById('cardDecision.verdict.ready').on[c]![0]!.meta!;
 if(!((entrance?(metadata.entryActors as Record<string,readonly string[]>)[entrance]:metadata.entrances) as readonly string[]).includes(family))return '입구 없음';
 const p=report.permissions[`${c}:${actor}${entrance?':'+entrance:''}`];
 if(!p)return '도달 상태 없음';
 const errors=[...p.guards].sort().map(g=>{const [guard,id]=g.split(': ');const e=CARD_FAILURES[id!]!;return `${guard} (${e?.statusCode??'일반 오류'}, ${e?.code??id})`;}).join('<br>');
 return !p.reject?'모두 허용':!p.apply?`모두 거절: ${errors}`:`조건부: ${errors}`;
}
export function generateCardStateDocument(report:CardPromiseReport=checkCardPromises()){
 const charts=renderCardCharts(report);
 const lines=['# 카드 상태 결정 규칙','',
 '이 문서는 결정 기계와 검증 세계에서 만든 생성물이다. 동작 기준 커밋은 c8b9c745a, 구조 전환 시작 기준은 52fb382d5다. 기준 위의 결정 정의로 그림, 권한, 규칙과 검사를 함께 생성한다. PR 2의 사람과 질문 명령, PR 3의 서버 명령 여덟 개를 운영 서비스에 연결했다. 유지보수와 공통 patch는 PR 4에서 연결한다.','',
 '저장 영역은 status, question, reservation, assignee, archive다. verdict는 목표 없는 전이로 허용, 무변경, 거절을 고른다. 담당 세션 생존과 감독 PAS, 다른 장 수와 내린 기록은 검증 세계의 환경이다. 원래 담당과 교체 담당의 생존 상태, 질문 작성자 관계, limitedOwner는 저장 상태 그림에서 제거했다. 작성자와 담당 관계는 사건 사실로, 생존은 환경으로 옮겼으며 예약 담당 불일치는 DB CHECK가 금지한다.','',
 `도달 세계 ${report.configurationCount}개. 유한 사실은 명령별 값 목록을 전부 열거하고 사실 일관성만 걸러 BFS로 탐색한다. 권한 표는 도달 세계에서 실제 선택한 verdict와 거절 가드 결과다. 같은 결정 값과 환경 담당 상태의 판정은 재사용한다.`,
 ''];
 for(const chart of charts)lines.push(`## ${chart.title}`,'','```mermaid',chart.mermaid,'```','',`전이 화살표 ${chart.edgeCount}개. 이 보기의 명령은 ${chart.events.join(', ')}다. 다른 명령은 이 그림에서 모두 숨기고 아래 출처 표에 적었다. 빨강은 약속 6을 어기는 세계가 있는 상태이며, 점선 구멍은 도달하지 않는 구성을 뜻한다.`,'');
 lines.push('## 상태와 저장 칸','', '| 상태 | status | blocked_kind |','| :-- | :-- | :-- |');
 for(const leaf of Object.keys(STATUS_PATHS) as (keyof typeof STATUS_PATHS)[]){const value={...rowToStateValue(null,[]),status:STATUS_PATHS[leaf]},c=stateValueToColumns(value);lines.push(`| ${leaf} | ${c.status} | ${c.blocked_kind??'null'} |`);}
 lines.push('', 'writeStatus 액션이 있을 때만 status와 blocked_kind를 쓴다. 같은 상태를 다시 지정해도 완료 정보와 대기열 키 쓰기는 실행한다. 예약 제거, 담당 연결, 질문 행과 now 서식은 선택된 기호 액션을 decoder가 번역한다. 댓글의 claim, 항목, 상태 단계는 별개 UPDATE로 남긴다. status 칸을 쓰지 않는 담당 연결은 검증 예약을 보존한다.','',
 '## 판에 오르는 장','', '판은 상태 영역이 아니다. cardBoardEntries가 카드, 질문, 감독, 다른 장 단계와 내린 기록에서 장을 계산한다. 다른 장 수는 계산 장을 밀어내지 않으며 아래 모든 조합을 생성했다.','',
 '| 카드 상태 | 보관 | 질문 | 감독과 다른 장 | 내린 기록 | 계산 장 |','| :-- | :-- | :-- | :-- | :-- | :-- |');
 for(const status of Object.keys(STATUS_PATHS) as (keyof typeof STATUS_PATHS)[])for(const archive of ['active','archived'] as const)for(const question of ['none','open'] as const)for(const pas of ['none','room','one','full'] as const)for(const dismissed of [false,true]){
 const snapshot=cardDecisionMachine.resolveState({value:{...rowToStateValue(null,[]),status:STATUS_PATHS[status],archive,question},context:{}});
 lines.push(`| ${status} | ${archive} | ${question} | ${pas} | ${dismissed?'있음':'없음'} | ${boardEntriesOf({snapshot,pas,dismissed,owner:'live'}).join(', ')||'없음'} |`);
 }
 lines.push('', '## 주체 관계별 권한','', 'PAS는 agent 세션이다. 현재 담당, 작성자, 담당이면서 작성자인 관계를 별도 행으로 그대로 보여 준다. 입구 없음은 명령 출처 metadata에서 읽으며 거절 가드와 기존 오류는 실제 열거 결과다.','',
 '| 명령 | 주체 관계 | 사람 | 현재 담당 세션 | 다른 agent 세션 | PAS | 서버 | 필요한 증거 단계 |', '| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |');
 for(const c of commands)for(const entrance of c==='ADD_COMMENT'?CARD_FACT_VALUES.ADD_COMMENT.entrance:[null])for(const actor of CARD_ACTORS){const p=permission(report,c,actor,entrance),isAgent=!['human','server','external'].includes(actor),owner=['owner','ownerAuthor'].includes(actor);lines.push(`| ${c}${entrance?' ('+entrance+')':''} | ${actor} | ${actor==='human'?p:'해당 없음'} | ${isAgent&&owner?p:'해당 없음'} | ${isAgent&&!owner?p:'해당 없음'} | ${isAgent&&actor!=='anonymousAgent'?p:'해당 없음'} | ${actor==='server'?p:'해당 없음'} | ${CARD_SERVER_EVIDENCE_STAGES[c as keyof typeof CARD_SERVER_EVIDENCE_STAGES]?.join(' → ')||'없음'} |`);}
 lines.push('', '## 규칙 요약과 운영 호출지','', '| 명령 | 전이 설명 | 운영 출처 |', '| :-- | :-- | :-- |');
 for(const c of commands){const t=cardDecisionMachine.getStateNodeById('cardDecision.verdict.ready').on[c]![0]!;lines.push(`| ${c} | ${t.meta!.rule} | ${(t.meta!.callers as readonly string[]).join('<br>')} |`);}
 lines.push('', '### 연결된 운영 입구', '', '| 명령 | 결정 기계를 부르는 입구 |', '| :-- | :-- |');
 for(const [command,callers] of Object.entries(CARD_RUNTIME_DECISION_CALLS))lines.push(`| ${command} | ${callers.join('<br>')} |`);
 lines.push('', '주체 종류와 입력만 보는 입구 검사는 단일 입구 표를 읽어 카드 잠금과 version 확인보다 먼저 서비스 입구에서 확인한다. ANSWER_QUESTION은 사람만 들어오며, 커멘트 mode와 spoken의 신뢰 주체 검사도 이 표에 둔다. 상태와 증거를 보는 권한은 잠금 뒤 결정 기계가 정한다. 서버 입구는 기계가 needsEvidence로 지목한 단계만 읽고 다시 묻는다. 이 중간 결과에는 쓰기가 없고, 마지막 apply, noop, reject만 판정이다. 마지막 판정 뒤 decoder의 요청 쓰기만 기존 patchCardTx에 넘긴다. 예약의 최종 정리는 PR 4까지 patchCardTx가 맡는다. SQL 잠금, version fence, 멱등 키, 질문 조건부 UPDATE와 커밋 뒤 판과 알림 처리는 기존 서비스 경계에 남는다.','');
 lines.push('입력 모양 검사는 기존 위치를 지킨다. 검수 ask는 잠금과 version 확인 뒤, 상태 판정 전에 한 번 검사하고 확인한 값을 서식에 넘긴다. 검증 대기 문구처럼 기존에 판정 뒤 검사하던 서식은 이름별 지연 바인딩으로 둔다. decoder는 선택된 쓰기가 bind한 이름만 계산하며, 같은 이름의 결과는 한 번의 decode 안에서 재사용한다. 선택하지 않은 서식과 시각 변환은 실행하지 않는다.','');
 lines.push('## 서버 증거 단계', '', '| 명령 | 단계 지목 순서 |', '| :-- | :-- |');
 for(const [command,stages] of Object.entries(CARD_SERVER_EVIDENCE_STAGES))lines.push(`| ${command} | ${stages.join(' → ')||'없음'} |`);
 lines.push('', 'needsEvidence는 허용이나 거절이 아니다. 단계 증거가 없으면 먼저 필요한 읽기를 지목한다. 앞선 거절은 뒤의 읽기와 잠금을 생략한다. admission은 정책이 켜지고 허가 입력이 있을 때만, claim은 수락된 자동 실행이 아닐 때만 요구한다. 권한 표는 필요한 증거가 갖춰진 최종 판정을 열거하며 단계 지목 전이는 위 그림에 보인다.', '');
 lines.push('', '## 약속과 구멍','', '| 약속 | 위반 수 | 예시 최단 경로 |','| :-- | --: | :-- |');
 for(const p of [report.promises[0]!,report.cardEntryPromise,...report.promises.slice(1)])lines.push(`| ${p.name} | ${p.violations} | ${p.example.join(' → ')||'없음'} |`);
 lines.push('', '| 구멍 | 도달 | 설명 |','| :-- | :-- | :-- |');
 for(const h of report.holes)lines.push(`| ${h.label} | ${h.reachable?'닿음':'닿지 않음'} | ${h.note??''} |`);
 lines.push('', '기존 모형의 담당 생존, 작성자, admitted, 감독과 내린 기록을 저장 영역에서 뺐으므로 세계 구성 수와 약속 6의 위반 수는 이전의 구성 수와 단위가 다르다. 약속 1-가부터 5는 위반 0을 유지하고, 약속 6은 알려진 실패를 유지한다.','', '## 다시 만들기','', '```bash','corepack pnpm@10.32.1 --dir orch-server-ts exec tsx scripts/card-state-charts.ts docs/cards/generated','```','');
 return {markdown:lines.join('\n'),charts,report};
}

import { CARD_DECISION_SOURCES, CARD_COMMAND_ENTRANCES, CARD_COMMAND_CALLERS } from './card_decision_inventory.js';
import { setup, not, and } from 'xstate';
import { CARD_FACT_VALUES, type DecisionEvent } from './card_decision_facts.js';
import { decisionGuards, rejections } from './card_decision_guards.js';
import { effects, verdictExtras, COMMAND_LABELS, COMMAND_RULES } from './card_decision_effects.js';
const leaf=(id:string,description:string)=>({id,description});
const statusLeaf=(id:string,description:string)=>leaf(`s_${id}`,description);
const verdict:Record<string,any>={};
decisionGuards['noop.HUMAN_INPUT']=not('humanResumable');
decisionGuards['noop.ADD_COMMENT']=and([not('commentResumable'),({event}:{event:any})=>!(event.facts.hasItem&&!event.facts.reply)&&!(event.facts.reply&&event.facts.claim)]);
decisionGuards['noop.CLAIM']=({event}:{event:DecisionEvent})=>!event.facts.claim;
for(const c of Object.keys(CARD_FACT_VALUES))verdict[c]=[
 ...rejections[c]!.map(r=>({guard:r.guard,actions:{type:'reject',params:{failure:r.failure,guard:r.guard}},description:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],meta:{command:c,label:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],rule:COMMAND_RULES[c as keyof typeof COMMAND_RULES]??COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],callers:CARD_COMMAND_CALLERS[c as keyof typeof CARD_COMMAND_CALLERS],sources:CARD_DECISION_SOURCES[c as keyof typeof CARD_DECISION_SOURCES],entrances:CARD_COMMAND_ENTRANCES[c as keyof typeof CARD_COMMAND_ENTRANCES]}})),
 ...(decisionGuards[`noop.${c}`]?[{guard:`noop.${c}`,actions:{type:'noop'},description:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],meta:{command:c,label:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],rule:COMMAND_RULES[c as keyof typeof COMMAND_RULES]??COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],callers:CARD_COMMAND_CALLERS[c as keyof typeof CARD_COMMAND_CALLERS],sources:CARD_DECISION_SOURCES[c as keyof typeof CARD_DECISION_SOURCES],entrances:CARD_COMMAND_ENTRANCES[c as keyof typeof CARD_COMMAND_ENTRANCES]}}]:[]),
 {actions:[{type:'apply'},...verdictExtras[c]!],description:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],meta:{command:c,label:COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],rule:COMMAND_RULES[c as keyof typeof COMMAND_RULES]??COMMAND_LABELS[c as keyof typeof COMMAND_LABELS],callers:CARD_COMMAND_CALLERS[c as keyof typeof CARD_COMMAND_CALLERS],sources:CARD_DECISION_SOURCES[c as keyof typeof CARD_DECISION_SOURCES],entrances:CARD_COMMAND_ENTRANCES[c as keyof typeof CARD_COMMAND_ENTRANCES]}},
];
const actions=Object.fromEntries(['reject','noop','apply','write','writeStatus','writeAssignee','writeArchive','clearLimit','spreadControl','spreadCreateAssignment'].map(name=>[name,()=>{}]));
/** No actor is created. transition() returns symbolic actions without running them. */
export const cardDecisionMachine=setup({types:{events:{} as DecisionEvent},guards:decisionGuards,actions}).createMachine({
 id:'cardDecision',type:'parallel',description:'카드에 저장한 사실에서 명령 판정과 쓰기를 정한다',
 states:{
 status:{description:'카드 상태',initial:'uncreated',on:effects.status,states:{
 uncreated:statusLeaf('uncreated','아직 만들지 않음'),
 on:{id:'s_on',description:'판 위',initial:'ready',states:{
 ready:{description:'준비',initial:'todo',states:{todo:statusLeaf('todo','할 일'),queued:{description:'대기열',initial:'normal',states:{normal:statusLeaf('queued','대기열'),missing:statusLeaf('missing','담당 에이전트 없음 표시')}}}},
 running:statusLeaf('running','실행 중'),
 talk:{description:'말로 풀리는 기다림',initial:'other',states:{question:statusLeaf('question','질문으로 막힘'),noReport:statusLeaf('noReport','보고 없이 막힘'),other:statusLeaf('other','사유 없이 막힘'),verification:statusLeaf('verification','검증 대기')}},
 silent:{description:'말로 안 풀리는 기다림',initial:'review',states:{limit:statusLeaf('limit','한도로 막힘'),review:statusLeaf('review','검수 대기')}}}},
 off:{id:'s_off',description:'내려감',initial:'hold',states:{hold:statusLeaf('hold','보류'),done:statusLeaf('done','완료'),cancelled:statusLeaf('cancelled','취소')}}}},
 question:{description:'열린 질문',initial:'none',on:effects.question,states:{none:leaf('q_none','없음'),open:leaf('q_open','열린 질문이 있음')}},
 reservation:{description:'카드에 기록한 예약',initial:'none',on:effects.reservation,states:{none:leaf('r_none','예약 없음'),verify:leaf('r_verify','검증 예약'),limit:leaf('r_limit','시각 있는 한도 예약'),longLimit:leaf('r_longLimit','시각 없는 한도 예약')}},
 assignee:{description:'담당 종류',initial:'none',on:effects.assignee,states:Object.fromEntries(['none','agent','human','session'].map((v,i)=>[v,leaf(`a_${v}`,['담당 없음','에이전트','사람','세션'][i]!)]))},
 archive:{description:'보관',initial:'active',on:effects.archive,states:{active:leaf('arch_active','활성'),archived:leaf('arch_archived','보관됨')}},
 verdict:{description:'명령 판정',initial:'ready',states:{ready:{description:'판정 준비',on:verdict}}},
 },
});

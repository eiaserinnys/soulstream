import { transition } from 'xstate';
import { cardDecisionMachine } from './card_decision_machine.js';
import { deriveCardActor, deriveCardDecisionFacts, type CardCommand } from './card_decision_facts.js';
import { rowToStateValue, type CardStateValue } from './card_state_value.js';
export interface DecisionAction {type:string;params?:any}
export type CardDecision={kind:'apply'|'noop';next:CardStateValue;actions:DecisionAction[]}|{kind:'reject';next:CardStateValue;actions:DecisionAction[];failure:{id:string;guard:string}};
/** The only domain entry point: a locked row and SQL evidence enter one transition. */
export function decideCardTransition(row:Record<string,any>|null,questions:readonly Record<string,any>[],evidence:Record<string,any>,command:CardCommand,actor:Record<string,any>,checkedAt:number):CardDecision {
 const facts=deriveCardDecisionFacts(row,questions,evidence,command,actor,checkedAt);
 const snapshot=cardDecisionMachine.resolveState({value:rowToStateValue(row,questions),context:{}});
 const [next,actions]=transition(cardDecisionMachine,snapshot,{type:command.type,actor:deriveCardActor(row,questions,command,actor),facts});
 const selected=actions as DecisionAction[];
 const verdict=selected.find(a=>['apply','noop','reject'].includes(a.type))!;
 if(verdict.type==='reject')return {kind:'reject',next:next.value as CardStateValue,actions:selected,failure:{id:verdict.params.failure,guard:verdict.params.guard}};
 return {kind:verdict.type as 'apply'|'noop',next:next.value as CardStateValue,actions:selected};
}

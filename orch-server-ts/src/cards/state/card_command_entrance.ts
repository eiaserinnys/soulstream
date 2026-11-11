import { CARD_COMMAND_ENTRY_RULES } from './card_decision_inventory.js';
import { formatCardDecisionFailure } from './card_decision_errors.js';
import type { CardDecisionCommand } from './card_decision_facts.js';

export interface CardEntryInput {hasMode?:boolean;requestedSpoken?:boolean}
export interface CardEntryActor {kind?:string;sessionId?:string|null}
/** The service and finite verification world read the same ordered entry rules. */
export function cardCommandEntryFailure(command:CardDecisionCommand,input:CardEntryInput,actor:CardEntryActor) {
 for(const rule of CARD_COMMAND_ENTRY_RULES[command]??[]) {
  if(rule.when!=='always'&&!input[rule.when])continue;
  if(!rule.kinds.includes(actor.kind??'')||(rule.session&&!actor.sessionId))
   return {id:rule.failure,guard:`entry.${command}.${rule.failure}`};
 }
 return null;
}
export function assertCardCommandEntrance(command:CardDecisionCommand,input:CardEntryInput,actor:CardEntryActor):void {
 const failure=cardCommandEntryFailure(command,input,actor);
 if(!failure)return;
 const error=formatCardDecisionFailure(failure);
 throw Object.assign(new Error(error.message),{statusCode:error.statusCode,code:error.code});
}

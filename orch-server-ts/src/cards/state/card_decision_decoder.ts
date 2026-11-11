import { stateValueToColumns } from './card_state_value.js';
import { createCardBindingResolver, decodeCardWriteIntent, type CardBindingValues, type CardWriteStep } from './card_write_intent.js';
import type { CardDecision } from './card_decision.js';
export interface DecodedCardWrite {stage:string;kind:CardWriteStep['kind'];fields:Record<string,unknown>}
const STAGES=['claim','question','move','item','state','questions'] as const;
/** Field serialization and binding only. Region/command policy is selected by the machine. */
export function decodeCardDecision(decision:CardDecision,values:CardBindingValues):DecodedCardWrite[] {
 if(decision.kind!=='apply')return [];
 const columns=stateValueToColumns(decision.next);
 const resolve=createCardBindingResolver(values);
 const groups=new Map<string,DecodedCardWrite>();
 for(const action of decision.actions){
 const p=action.params;
 if(!p)continue;
 let fields:Record<string,unknown>|undefined;
 switch(action.type){
 case 'write':fields=decodeCardWriteIntent([{kind:p.kind!,fields:p.fields!}],values,resolve)[0];break;
 case 'writeStatus':fields={status:columns.status,blocked_kind:columns.blocked_kind};break;
 case 'writeAssignee':fields={assignee_kind:columns.assignee_kind};break;
 case 'writeArchive':fields={archived:columns.archived};break;
 case 'clearLimit':fields={limit_resume_session_id:null,limit_resume_at:null};break;
 case 'spreadControl':fields=resolve('command.control') as Record<string,unknown>;break;
 case 'spreadCreateAssignment':fields=resolve('command.assignment') as Record<string,unknown>;break;
 }
 if(!fields)continue;
 const stage=p.stage!,kind=p.kind??'card',key=`${stage}:${kind}`;
 const group=groups.get(key)??{stage,kind,fields:{}};
 Object.assign(group.fields,fields);groups.set(key,group);
 }
 return [...groups.values()].sort((a,b)=>STAGES.indexOf(a.stage as any)-STAGES.indexOf(b.stage as any));
}

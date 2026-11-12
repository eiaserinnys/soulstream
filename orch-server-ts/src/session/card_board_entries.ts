import type { PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
import {
  normalizeCardQuestionOptions,
  type CardQuestionAttachment,
  type CardQuestionKind,
  type CardQuestionOption,
  type CardQuestionThreadEntry,
} from "@soulstream/wire-schema/card-questions";
export interface BoardCard extends Record<string,unknown> {
  id:string;number:number|null;title:string;status:string;archived:boolean;
  blocked_kind:string|null;blocked_detail:string|null;status_changed_at:Date|string;updated_at:Date|string;
  now:{text?:string;turn?:string;ask?:string|null}|null;
}
export interface BoardQuestion extends Record<string,unknown> {
  id:string;card_id:string;text:string;options:string[]|null;answer:string|null;withdrawn_at:Date|string|null;asked_at:Date|string;
  title?:string|null;kind?:CardQuestionKind|null;attachments?:CardQuestionAttachment[]|null;
  option_details?:CardQuestionOption[]|null;selected_option?:string|null;
  revision?:number|null;revised_at?:Date|string|null;
}
export interface DismissedCard {card_id:string;status:string;blocked_kind:string|null;status_changed_at:string}
export const isServerBoardKey=(key:string)=>key.startsWith("card_")||key.startsWith("cq_");
export function clip(text:string,max:number){const chars=[...text];return chars.length>max?`${chars.slice(0,max-1).join("").trimEnd()}…`:text;}
export function cardSituationText(card:Pick<BoardCard,"now"|"blocked_detail">){
  return (card.now?.turn==="user"&&card.now.ask?card.now.ask:card.now?.text)||card.blocked_detail||"";
}
export function dismissalMatches(card:BoardCard,record:DismissedCard){
  return card.id===record.card_id&&card.status===record.status&&card.blocked_kind===record.blocked_kind
    &&new Date(card.status_changed_at).getTime()===new Date(record.status_changed_at).getTime();
}
/** The sole projection rule, shared by the persisted board and machine output. */
export function cardBoardEntries(card:BoardCard,questions:readonly BoardQuestion[],connected:boolean,
  dismissed:readonly DismissedCard[]=[],threads?:ReadonlyMap<string,readonly CardQuestionThreadEntry[]>):PersistentReportEntry[]{
  if(!connected||card.archived||["done","cancelled","on_hold"].includes(card.status))return [];
  const common={title:clip(card.title,24),card_numbers:card.number===null?[]:[card.number],action:"",state:"open" as const,answer:"",card_id:card.id,card_status:card.status};
  const open=questions.filter(q=>q.card_id===card.id&&q.answer===null&&q.withdrawn_at===null);
  if(open.length)return open.map(q=>{
    const title=typeof q.title==="string"&&q.title.trim()!==""?q.title:null;
    const revisedAt=q.revised_at===null||q.revised_at===undefined?null:new Date(q.revised_at).getTime();
    const thread=threads?.get(q.id)??[];
    const lastThreadAt=thread.length?new Date(thread[thread.length-1]!.created_at).getTime():0;
    return {...common,
      title:title===null?common.title:clip(title,40),
      key:`cq_${q.id}`,kind:"ask" as const,context:clip(q.text,120),options:q.options??[],question_id:q.id,
      ...(title===null?{}:{question_title:title}),
      question_text:q.text,
      question_kind:q.kind==="request"?"request":"choice",
      question_option_details:q.option_details??normalizeCardQuestionOptions(q.options),
      question_attachments:q.attachments??[],
      question_revision:typeof q.revision==="number"&&q.revision>=1?q.revision:1,
      question_revised_at:revisedAt===null?null:new Date(revisedAt).toISOString(),
      ...(thread.length?{question_thread:[...thread]}:{}),
      updated_at:new Date(Math.max(new Date(q.asked_at).getTime(),new Date(card.updated_at).getTime(),revisedAt??0,lastThreadAt)).toISOString()};
  });
  if(!["review","blocked"].includes(card.status)||dismissed.some(d=>dismissalMatches(card,d)))return [];
  return [{...common,key:`card_${card.id}`,kind:"see",context:clip(cardSituationText(card),120),options:[],updated_at:new Date(card.updated_at).toISOString()}];
}

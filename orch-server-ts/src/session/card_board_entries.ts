import type { PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
export interface BoardCard extends Record<string,unknown> {
  id:string;number:number|null;title:string;status:string;archived:boolean;
  blocked_kind:string|null;blocked_detail:string|null;status_changed_at:Date|string;updated_at:Date|string;
  now:{text?:string;turn?:string;ask?:string|null}|null;
}
export interface BoardQuestion extends Record<string,unknown> {id:string;card_id:string;text:string;options:string[]|null;answer:string|null;withdrawn_at:Date|string|null;asked_at:Date|string}
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
export function cardBoardEntries(card:BoardCard,questions:readonly BoardQuestion[],connected:boolean,dismissed:readonly DismissedCard[]=[]):PersistentReportEntry[]{
  if(!connected||card.archived||["done","cancelled","on_hold"].includes(card.status))return [];
  const common={title:clip(card.title,24),card_numbers:card.number===null?[]:[card.number],action:"",state:"open" as const,answer:"",card_id:card.id,card_status:card.status};
  const open=questions.filter(q=>q.card_id===card.id&&q.answer===null&&q.withdrawn_at===null);
  if(open.length)return open.map(q=>({...common,key:`cq_${q.id}`,kind:"ask" as const,context:clip(q.text,120),options:q.options??[],question_id:q.id,
    updated_at:new Date(Math.max(new Date(q.asked_at).getTime(),new Date(card.updated_at).getTime())).toISOString()}));
  if(!["review","blocked"].includes(card.status)||dismissed.some(d=>dismissalMatches(card,d)))return [];
  return [{...common,key:`card_${card.id}`,kind:"see",context:clip(cardSituationText(card),120),options:[],updated_at:new Date(card.updated_at).toISOString()}];
}

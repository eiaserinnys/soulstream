export interface WidgetCard {id:string;title:string;status:string;assignee:string;updatedAt:string|null;preview?:{kind:'instruction'|'report';text:string}}
export const cardGroups=[
 {id:'attention',label:'검수 대기',statuses:['review','blocked']},
 {id:'running',label:'실행 중',statuses:['running']},
 {id:'queued',label:'대기',statuses:['queued','unknown']},
 {id:'draft',label:'드래프트',statuses:['todo']},
 {id:'completed',label:'완료',statuses:['done','cancelled']},
] as const;
export function groupWidgetCards(cards:readonly WidgetCard[]){
 return cardGroups.map(group=>({...group,cards:cards.filter(card=>(group.statuses as readonly string[]).includes(card.status))})).filter(group=>group.cards.length);
}

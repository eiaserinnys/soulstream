import {cardActivityPreview} from '../../../packages/soul-ui/src/cards/card-activity-preview.ts';
/** Only the latest bounded text excerpt; never return original bodies or history. */
export type CardPreview={kind:'instruction'|'report';text:string};
function preview(row:Record<string,unknown>):CardPreview|undefined {
 const value=row.latestActivity??row.latest_activity;
 if(!value||typeof value!=='object')return undefined;
 const activity=value as Record<string,unknown>;
 if(typeof activity.kind!=='string'||typeof activity.body!=='string'||(activity.format!=='html'&&activity.format!=='markdown'))return undefined;
 const text=cardActivityPreview({body:activity.body,format:activity.format},true).slice(0,500);
 return text?{kind:activity.kind==='report'?'report':'instruction',text}:undefined;
}
export const cardStatuses=['todo','queued','blocked','running','review','done','cancelled'] as const;
export function projectCards(payload:unknown,limit=100){
 if(!payload||typeof payload!=='object'||!Array.isArray((payload as {cards?:unknown}).cards))throw new Error('Invalid cards response');
 const rows=(payload as {cards:unknown[]}).cards;
 const cards=rows.slice(0,limit).map(value=>{
  if(!value||typeof value!=='object')throw new Error('Invalid card');
  const row=value as Record<string,unknown>;
  if(typeof row.id!=='string'||typeof row.title!=='string')throw new Error('Invalid card');
  const updated=row.updatedAt??row.updated_at;
  const assignee=row.assigneeLabel??row.assignee_label??row.assigneeAgentId??row.assignee_agent_id??row.assigneeHumanName??row.assignee_human_name;
  const excerpt=preview(row);
  return {id:row.id,title:row.title,status:cardStatuses.includes(row.status as typeof cardStatuses[number])?String(row.status):'unknown',assignee:typeof assignee==='string'?assignee:'',updatedAt:typeof updated==='string'&&Number.isFinite(Date.parse(updated))?new Date(updated).toISOString():null,...(excerpt?{preview:excerpt}:{})};
 });return {cards,total:rows.length,truncated:rows.length>cards.length};
}

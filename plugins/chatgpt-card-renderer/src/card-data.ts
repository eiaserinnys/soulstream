/** Shared dependency-free projection. Never include requests, reports or session history. */
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
  return {id:row.id,title:row.title,status:cardStatuses.includes(row.status as typeof cardStatuses[number])?String(row.status):'unknown',assignee:typeof assignee==='string'?assignee:'',updatedAt:typeof updated==='string'&&Number.isFinite(Date.parse(updated))?new Date(updated).toISOString():null};
 });return {cards,total:rows.length,truncated:rows.length>cards.length};
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { widgetHtml } from './widget-html.ts';
export const RESOURCE_URI='ui://soulstream/cards-v1.html';
export const statuses=['todo','queued','blocked','running','review','done','cancelled'] as const;
const cardSchema=z.object({id:z.string().min(1).max(256),title:z.string().min(1).max(500),status:z.enum([...statuses,'unknown']),assignee:z.string().max(200).default(''),updatedAt:z.string().datetime({offset:true}).nullable().default(null)}).strict();
export function normalizeCards(payload:unknown,limit=24){
 const parsed=z.object({cards:z.array(z.record(z.string(),z.unknown()))}).parse(payload);
 const cards=parsed.cards.slice(0,limit).map(row=>{
  if(typeof row.id!=='string'||typeof row.title!=='string')throw new Error('Invalid card response');
  const updated=row.updatedAt??row.updated_at;
  const assignee=row.assigneeLabel??row.assignee_label??row.assigneeAgentId??row.assignee_agent_id??row.assigneeHumanName??row.assignee_human_name;
  return {id:row.id,title:row.title,status:statuses.includes(row.status as typeof statuses[number])?String(row.status):'unknown',assignee:typeof assignee==='string'?assignee:'',updatedAt:typeof updated==='string'&&Number.isFinite(Date.parse(updated))?updated:null};
 });return {cards,total:parsed.cards.length,truncated:parsed.cards.length>cards.length};
}
/** Stateless presentation only: no backend calls, storage, credentials, or identity overrides. */
export function registerCardView(server:McpServer){
 server.registerResource('soulstream-cards',RESOURCE_URI,{},async()=>({contents:[{uri:RESOURCE_URI,mimeType:'text/html;profile=mcp-app',text:widgetHtml,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]}));
 server.registerTool('render_soulstream_cards',{title:'Soulstream 업무 카드 표시',description:'Render a read-only snapshot of cards already retrieved from the connected Soulstream MCP. First use a currently available Soulstream read tool; then copy exact IDs, titles, statuses and optional assignees/update times into this tool. Never invent data or pass requests, reports, credentials or session history. This tool does not fetch, authenticate to, or modify Soulstream. The card fields are sent to this renderer endpoint. At most 100 cards; split larger sets into intentional batches.',inputSchema:{cards:z.array(cardSchema).max(100)},outputSchema:{cards:z.array(cardSchema),total:z.number(),truncated:z.boolean()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{ui:{resourceUri:RESOURCE_URI},'openai/outputTemplate':RESOURCE_URI}},async({cards})=>({content:[{type:'text',text:`전달받은 ${cards.length}개 카드의 읽기 전용 스냅샷입니다.`}],structuredContent:{cards,total:cards.length,truncated:false}}));
}

import {previewSchema} from '../../../packages/soul-ui/src/cards/card-preview-schema.ts';
import {projectCards} from './card-data.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { widgetHtml } from './widget-html.ts';
export const RESOURCE_URI='ui://soulstream/cards-v3.html';
export const statuses=['todo','queued','blocked','running','review','done','cancelled'] as const;
const cardSchema=z.object({id:z.string().min(1).max(256),title:z.string().min(1).max(500),status:z.enum([...statuses,'unknown']),assignee:z.string().max(200).default(''),updatedAt:z.string().datetime({offset:true}).nullable().default(null),preview:previewSchema.optional()}).strict();
export function normalizeCards(payload:unknown,limit=24){return projectCards(payload,limit)}
/** Stateless presentation only: no backend calls, storage, credentials, or identity overrides. */
export function registerCardView(server:McpServer){
 server.registerResource('soulstream-cards',RESOURCE_URI,{},async()=>({contents:[{uri:RESOURCE_URI,mimeType:'text/html;profile=mcp-app',text:widgetHtml,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]}));
 server.registerTool('render_soulstream_cards',{title:'Soulstream 업무 카드 표시',description:'Render a read-only snapshot of cards already retrieved from the connected Soulstream MCP. First use a currently available Soulstream read tool; then copy exact IDs, titles, statuses and optional assignees/update times into this tool. An optional preview contains only the latest instruction or report as plain text, at most 500 characters. Never invent data or pass full requests/reports, activity timestamps, credentials or session history. This tool does not fetch, authenticate to, or modify Soulstream. The card fields are sent to this renderer endpoint. At most 100 cards; split larger sets into intentional batches.',inputSchema:{cards:z.array(cardSchema).max(100)},outputSchema:{cards:z.array(cardSchema),total:z.number(),truncated:z.boolean()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{ui:{resourceUri:RESOURCE_URI},'openai/outputTemplate':RESOURCE_URI}},async({cards})=>({content:[{type:'text',text:`전달받은 ${cards.length}개 카드의 읽기 전용 스냅샷입니다.`}],structuredContent:{cards,total:cards.length,truncated:false}}));
}

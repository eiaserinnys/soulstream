import {describe,it,expect} from 'vitest';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerLiveCardView,LIVE_CARD_RESOURCE,type LiveCardQuery} from '../../src/mcp/tools/live_card_view.js';
it('live UI cache key advances to the bounded-scroll resource',()=>expect(LIVE_CARD_RESOURCE).toBe('ui://soulstream/live-cards-v4.html'));
async function harness(reader:(query:LiveCardQuery)=>Promise<unknown>){const server=new McpServer({name:'test',version:'1'});registerLiveCardView(server,reader);const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return {client,close:async()=>{await client.close();await server.close()}}}
describe('authenticated live card view adapter',()=>{
 it('fetches on open and each refresh, scopes folder, projects fields and registers versioned resource',async()=>{const seen:LiveCardQuery[]=[];const h=await harness(async query=>{seen.push(query);return {cards:[{id:'a',title:'version '+seen.length,status:'running',request:'private request',latestActivity:{kind:'instruction',format:'markdown',body:'**최신 지시**'}}]}});try{const list=await h.client.listTools();expect(list.tools.map(t=>t.name)).toEqual(['show_live_card_view','list_live_cards']);expect((list.tools[0]!._meta?.ui as any).resourceUri).toBe(LIVE_CARD_RESOURCE);expect((list.tools[1]!._meta?.ui as any).resourceUri).toBeUndefined();const resource=await h.client.readResource({uri:LIVE_CARD_RESOURCE});expect(resource.contents[0]!.mimeType).toBe('text/html;profile=mcp-app');for(const name of ['show_live_card_view','list_live_cards']){const result=await h.client.callTool({name,arguments:{folder_id:'allowed-folder'}});expect(result.isError).not.toBe(true);const data=result.structuredContent as any;expect(data.cards[0].title).toBe('version '+seen.length);expect(data.cards[0].request).toBeUndefined();expect(data.cards[0].preview).toEqual({kind:'instruction',text:'최신 지시'});expect(data.cards[0].latestActivity).toBeUndefined();expect(data.sync.folderId).toBe('allowed-folder')}expect(seen).toEqual([{folder_id:'allowed-folder',limit:100},{folder_id:'allowed-folder',limit:100}])}finally{await h.close()}});
 it('preserves backend denial as an error and never emits an empty-success array',async()=>{const h=await harness(async()=>{throw Object.assign(new Error('private internals'),{status:403})});try{const result=await h.client.callTool({name:'show_live_card_view',arguments:{}});expect(result.isError).toBe(true);expect(result.structuredContent).toEqual({syncError:{authorization:true}});expect(JSON.stringify(result)).not.toContain('private internals')}finally{await h.close()}});
 it('rejects invalid limits before reading; malformed backend result is an error',async()=>{let count=0;const h=await harness(async()=>{count++;return {wrong:[]}});try{const bad=await h.client.callTool({name:'list_live_cards',arguments:{limit:101}});expect(bad.isError).toBe(true);expect(count).toBe(0);const result=await h.client.callTool({name:'list_live_cards',arguments:{limit:10}});expect(result.isError).toBe(true);expect(count).toBe(1)}finally{await h.close()}});
 it('publishes a strict exclusive output schema and validates success and sync error results',async()=>{
  const h=await harness(async()=>({cards:[]}));
  try{
   const tools=await h.client.listTools();
   expect(tools.tools).toHaveLength(2);
   for(const tool of tools.tools){expect(tool.outputSchema).toMatchObject({type:'object',anyOf:[expect.any(Object),expect.any(Object)],properties:{syncError:expect.any(Object)},additionalProperties:false})}
   const result=await h.client.callTool({name:'show_live_card_view',arguments:{}});
   expect(result.isError).not.toBe(true);
   const {liveCardOutputSchema}=await import('../../src/mcp/tools/live_card_view.js');
   expect(liveCardOutputSchema.safeParse(result.structuredContent).success).toBe(true);
   const withPreview={...(result.structuredContent as any),cards:[{id:'1',title:'카드',status:'todo',assignee:'',updatedAt:null,preview:{kind:'report',text:'가'.repeat(500)}}]};
   expect(liveCardOutputSchema.safeParse(withPreview).success).toBe(true);
   expect(liveCardOutputSchema.safeParse({...withPreview,cards:[{...withPreview.cards[0],preview:{kind:'report',text:'가'.repeat(501)}}]}).success).toBe(false);
   expect(liveCardOutputSchema.safeParse({syncError:{authorization:true}}).success).toBe(true);
   expect(liveCardOutputSchema.safeParse({syncError:{authorization:false}}).success).toBe(true);
   expect(liveCardOutputSchema.safeParse({}).success).toBe(false);
   expect(liveCardOutputSchema.safeParse({cards:[]}).success).toBe(false);
   expect(liveCardOutputSchema.safeParse({cards:[],total:0,truncated:false,sync:{folderId:null,limit:100,refreshSeconds:30,fetchedAt:'2026-10-02T00:00:00.000Z'},syncError:{authorization:true}}).success).toBe(false);
  }finally{await h.close()}
 });
});

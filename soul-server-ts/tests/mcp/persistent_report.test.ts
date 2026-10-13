import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPersistentReportTools } from "../../src/mcp/tools/persistent_report.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { mcpTools } from "@soulstream/mcp-contract";

const opened: Array<Client | McpServer> = [];
async function client(host: Record<string,unknown>) {
  const server=new McpServer({name:'report-test',version:'1'});
  registerPersistentReportTools(server,{persistentReports:host} as unknown as McpRuntime);
  const [a,b]=InMemoryTransport.createLinkedPair();
  const c=new Client({name:'report-test',version:'1'});
  await server.connect(b); await c.connect(a); opened.push(c,server); return c;
}
afterEach(async()=>{while(opened.length) await opened.pop()!.close();});
const entry={key:'r1',kind:'ask',title:'결정',card_numbers:[],context:'맥락',action:'진행',options:['진행']};
describe('PAS report MCP tools',()=>{
  it('registers exactly two direct tools with factual short descriptions and own caller identity',async()=>{
    const put=vi.fn(async()=>({ok:true,changed:true,entries:[{key:'r1',title:'결정'}],persistent_report:[]}));
    const remove=vi.fn(async()=>({ok:true,changed:true,entries:[],persistent_report:[]}));
    const c=await client({put,remove});
    const inventory=await c.listTools();
    expect(inventory.tools.map(t=>t.name).sort()).toEqual(['put_report_entry','remove_report_entry']);
    for(const tool of inventory.tools) {expect(tool.description!.length).toBeLessThanOrEqual(2000);expect(tool.name in mcpTools).toBe(false);}
    expect((await c.callTool({name:'put_report_entry',arguments:entry})).isError).toBe(true);
    await withMcpRequestContext({callerSessionId:'own-pas'},()=>c.callTool({name:'put_report_entry',arguments:entry}));
    expect(put).toHaveBeenCalledWith('own-pas',entry);
    const result=await withMcpRequestContext({callerSessionId:'own-pas'},()=>c.callTool({name:'remove_report_entry',arguments:{key:'r1'}}));
    expect(remove).toHaveBeenCalledWith('own-pas','r1');
    expect(result.structuredContent).toEqual({ok:true,changed:true,entries:[]});
  });
  it('returns non-PAS and validation failures with paths and current entries',async()=>{
    const failure={ok:false,code:'NOT_PERSISTENT',errors:[{path:'session_id',reason:'영구 세션만'}],entries:[]};
    const c=await client({put:vi.fn(async()=>failure)});
    const result=await withMcpRequestContext({callerSessionId:'normal'},()=>c.callTool({name:'put_report_entry',arguments:entry}));
    expect(result.isError).toBe(true);expect(result.structuredContent).toEqual(failure);
  });
});

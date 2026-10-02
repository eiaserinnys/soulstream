import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {registerCardView} from './card-view.ts';
import {widgetHtml} from './widget-html.ts';
export const fixture={cards:[{id:'demo-1',title:'ChatGPT 카드 뷰 프로토타입',status:'running',assigneeAgentId:'Demo agent',updatedAt:'2026-10-02T00:00:00Z'},{id:'demo-2',title:'MCP UI 리소스 연결',status:'review',assigneeAgentId:'Demo agent'},{id:'demo-3',title:'모바일 카드 레이아웃 확인',status:'todo'},{id:'demo-4',title:'읽기 전용 데이터 계약',status:'done'}]};
export interface RequestPolicy { allowedHosts?:string[]; allowedOrigins?:string[] }
function csv(value:string|undefined){return value?.split(',').map(v=>v.trim()).filter(Boolean)}
/** Exact authority/origin allowlists; forwarded headers are deliberately not trusted. */
function allowedRequest(req:import('node:http').IncomingMessage,policy:RequestPolicy){
 const count=(name:string)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i]?.toLowerCase()===name).length;
 if(count('host')!==1||count('origin')>1)return false;
 const port=req.socket.localPort;
 const hosts=policy.allowedHosts??[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
 if(!req.headers.host||!hosts.some(host=>host.toLowerCase()===req.headers.host?.toLowerCase()))return false;
 const origin=req.headers.origin;
 if(origin===undefined)return true; // Non-browser MCP clients normally omit Origin.
 const origins=policy.allowedOrigins??[`http://127.0.0.1:${port}`,`http://localhost:${port}`,`http://[::1]:${port}`];
 return origin!=='null'&&origins.includes(origin);
}
export function createRendererHttpServer(policy:RequestPolicy={}){
 return createServer((req,res)=>{
  const sendError=(status:number,message:string)=>{
   if(!res.destroyed&&!res.writableEnded&&!res.headersSent)res.writeHead(status).end(message);
  };
  // Keep every asynchronous request operation, including interrupted body reads, contained.
  void (async()=>{
   if(!allowedRequest(req,policy)){sendError(403,'Untrusted Host or Origin');return}
   const path=new URL(req.url??'/', 'http://localhost').pathname;
 if(req.method==='GET'&&path==='/widget'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(widgetHtml);return}
 if(req.method==='GET'&&path==='/preview'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><html lang="ko"><title>Soulstream demo preview</title><p style="font:14px system-ui">로컬 미리보기 · 예시 데이터 · ChatGPT에 설치된 위젯이 아닙니다</p><iframe title="업무 카드" src="/widget" style="width:100%;height:600px;border:0"></iframe><script>const f=document.querySelector('iframe');window.addEventListener('message',e=>{if(e.source!==f.contentWindow)return;if(e.data.method==='ui/initialize'){f.contentWindow.postMessage({jsonrpc:'2.0',id:e.data.id,result:{}},'*')}if(e.data.method==='ui/notifications/initialized'){f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify({cards:fixture.cards.map(c=>({id:c.id,title:c.title,status:c.status,assignee:c.assigneeAgentId??'',updatedAt:c.updatedAt??null})),total:4})}}},'*')}})</script></html>`);return}

   if(path!=='/mcp'){sendError(404,'Use /preview or /mcp');return}
   let parsedBody:unknown;
   if(req.method==='POST'){
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){
     size+=chunk.length;
     if(size>128*1024){sendError(413,'Request too large');return}
     chunks.push(chunk);
    }
    if(req.aborted||res.destroyed)return;
    try{parsedBody=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
    catch{sendError(400,'Invalid JSON');return}
   }
   if(req.aborted||res.destroyed)return;
   const server=new McpServer({name:'soulstream-card-renderer',version:'0.2.0'});
   registerCardView(server);
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   const cleanup=()=>{void transport.close().catch(()=>{});void server.close().catch(()=>{})};
   res.once('close',cleanup);
   try{await server.connect(transport);await transport.handleRequest(req,res,parsedBody)}
   catch(error){cleanup();throw error}
  })().catch(()=>{if(!req.aborted)sendError(500,'MCP request failed')});
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const host=process.env.HOST??'127.0.0.1';const port=Number(process.env.PORT??8787);
 const policy={allowedHosts:csv(process.env.ALLOWED_HOSTS),allowedOrigins:csv(process.env.ALLOWED_ORIGINS)};
 createRendererHttpServer(policy).listen(port,host,()=>console.log(`Renderer listening on http://${host}:${port}/mcp; sample preview /preview`));
}

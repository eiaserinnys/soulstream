import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {registerCardView} from './card-view.ts';
import {widgetHtml} from './widget-html.ts';
export const fixture={cards:[{id:'demo-1',title:'ChatGPT 카드 뷰 프로토타입',status:'running',assigneeAgentId:'Demo agent',updatedAt:'2026-10-02T00:00:00Z'},{id:'demo-2',title:'MCP UI 리소스 연결',status:'review',assigneeAgentId:'Demo agent'},{id:'demo-3',title:'모바일 카드 레이아웃 확인',status:'todo'},{id:'demo-4',title:'읽기 전용 데이터 계약',status:'done'}]};
export function createRendererHttpServer(){return createServer(async(req,res)=>{
 const path=new URL(req.url??'/', 'http://localhost').pathname;
 if(req.method==='GET'&&path==='/widget'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(widgetHtml);return}
 if(req.method==='GET'&&path==='/preview'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><html lang="ko"><title>Soulstream demo preview</title><p style="font:14px system-ui">로컬 미리보기 · 예시 데이터 · ChatGPT에 설치된 위젯이 아닙니다</p><iframe title="업무 카드" src="/widget" style="width:100%;height:600px;border:0"></iframe><script>const f=document.querySelector('iframe');window.addEventListener('message',e=>{if(e.source!==f.contentWindow)return;if(e.data.method==='ui/initialize'){f.contentWindow.postMessage({jsonrpc:'2.0',id:e.data.id,result:{}},'*')}if(e.data.method==='ui/notifications/initialized'){f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify({cards:fixture.cards.map(c=>({id:c.id,title:c.title,status:c.status,assignee:c.assigneeAgentId??'',updatedAt:c.updatedAt??null})),total:4})}}},'*')}})</script></html>`);return}
 if(path!=='/mcp'){res.writeHead(404).end('Use /preview or /mcp');return}
 if(req.method==='POST'){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>128*1024){res.writeHead(413).end('Request too large');return}chunks.push(chunk)}
  try{(req as typeof req & {parsedBody?:unknown}).parsedBody=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{res.writeHead(400).end('Invalid JSON');return}
 }
 const server=new McpServer({name:'soulstream-card-renderer',version:'0.2.0'});registerCardView(server);
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 res.on('close',()=>{void transport.close();void server.close()});
 try{await server.connect(transport);await transport.handleRequest(req,res,(req as typeof req & {parsedBody?:unknown}).parsedBody)}catch{if(!res.headersSent)res.writeHead(500).end('MCP request failed')}
});}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const host=process.env.HOST??'127.0.0.1';const port=Number(process.env.PORT??8787);
 createRendererHttpServer().listen(port,host,()=>console.log(`Renderer listening on http://${host}:${port}/mcp; sample preview /preview`));
}

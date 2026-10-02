import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRendererHttpServer} from '../src/server.ts';
import {widgetHtml} from '../src/widget-html.ts';
// @ts-ignore test-only DOM
import {JSDOM} from 'jsdom';
const initialize=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});
async function withServer(policy:Parameters<typeof createRendererHttpServer>[0],run:(url:string)=>Promise<void>){const server=createRendererHttpServer(policy);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();assert(a&&typeof a==='object');try{await run(`http://127.0.0.1:${a.port}`)}finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}}
function post(url:string,headers:Record<string,string>={}):Promise<{status:number}>{return new Promise((resolve,reject)=>{const req=request(url+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode??0}))});req.on('error',reject);req.end(initialize)})}
test('HTTP rejects hostile Origin/Host before MCP, allows loopback and no Origin',async()=>{await withServer({},async url=>{assert.equal((await post(url)).status,200);assert.equal((await post(url,{origin:url})).status,200);for(const origin of ['https://evil.example','null',url+'.evil.example'])assert.equal((await post(url,{origin})).status,403);assert.equal((await post(url,{host:'evil.example'})).status,403);assert.equal((await post(url,{host:'evil.example','x-forwarded-host':new URL(url).host})).status,403)})});
test('configured allowlists are exact and independent of forwarded headers',async()=>{await withServer({allowedHosts:['renderer.example'],allowedOrigins:['https://trusted.example']},async url=>{assert.equal((await post(url,{host:'renderer.example',origin:'https://trusted.example'})).status,200);assert.equal((await post(url,{host:'renderer.example',origin:'https://trusted.example.evil.test'})).status,403);assert.equal((await post(url,{host:'renderer.example',origin:'https://trusted.example/'})).status,403);assert.equal((await post(url,{host:'renderer.example'})).status,200);assert.equal((await post(url,{origin:'https://trusted.example'})).status,403)})});
test('aborted partial upload does not crash a standalone server process',async()=>{
 const moduleUrl=new URL('../src/server.ts',import.meta.url).href;
 const code=`import {createRendererHttpServer} from ${JSON.stringify(moduleUrl)};import net from 'node:net';const server=createRendererHttpServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1',()=>{socket.write('POST /mcp HTTP/1.1\\r\\nHost: 127.0.0.1:'+port+'\\r\\nContent-Type: application/json\\r\\nContent-Length: 10000\\r\\n\\r\\n{');setTimeout(()=>socket.destroy(),50)});socket.on('error',()=>{});socket.on('close',resolve)});await new Promise(r=>setTimeout(r,100));const response=await fetch('http://127.0.0.1:'+port+'/preview');if(response.status!==200)throw new Error('Server did not survive');await new Promise(r=>server.close(r));console.log('survived');`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',code],{timeout:10000});assert.match(stdout,/survived/);
});
for(const id of [1,42,'host-teardown'])test(`teardown request ${id} is acknowledged and removes listeners/state`,()=>{
 const sent:any[]=[];const dom=new JSDOM(widgetHtml,{runScripts:'dangerously',beforeParse(w:any){w.postMessage=(m:unknown)=>sent.push(m)}});const w=dom.window;
 const send=(data:unknown)=>w.dispatchEvent(new w.MessageEvent('message',{source:w,data}));
 send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{cards:[{id:'a',title:'A',status:'todo',assignee:'',updatedAt:null}],total:1}}});assert.equal(w.document.querySelectorAll('article').length,1);
 send({jsonrpc:'2.0',id,method:'ui/resource-teardown',params:{}});assert.deepEqual(JSON.parse(JSON.stringify(sent)),[{jsonrpc:'2.0',id,result:{}}]);assert.equal(w.document.querySelectorAll('article').length,0);assert.equal(w.document.getElementById('filter').disabled,true);
 send({jsonrpc:'2.0',id:1,result:{}});send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{cards:[{id:'a',title:'A',status:'todo'}],total:1}}});assert.equal(sent.length,1);assert.equal(w.document.querySelectorAll('article').length,0);dom.window.close();
});
test('initialization only consumes response envelopes once, not requests',()=>{const sent:any[]=[];const dom=new JSDOM(widgetHtml,{runScripts:'dangerously',beforeParse(w:any){w.postMessage=(m:unknown)=>sent.push(m)}});const w=dom.window;const send=(data:unknown)=>w.dispatchEvent(new w.MessageEvent('message',{source:w,data}));send({jsonrpc:'2.0',id:1,method:'some/request'});assert.equal(sent.length,0);send({jsonrpc:'2.0',id:1,result:{}});send({jsonrpc:'2.0',id:1,result:{}});assert.equal(sent.length,1);assert.equal(sent[0].method,'ui/notifications/initialized');dom.window.close()});

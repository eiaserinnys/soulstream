/** Trusted bootstrap; the model receives neither the host token nor a host filesystem mount. */
export const CODEX_CONTAINER_PROGRAM = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const input = JSON.parse(fs.readFileSync('/input/request.json','utf8'));
fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
const proxy = http.createServer((request,response)=>{
  const upstream = http.request({socketPath:'/input/inference.sock',path:request.url,method:request.method,
    headers:{'content-type':'application/json'}},res=>{response.writeHead(res.statusCode,{'content-type':res.headers['content-type']||'text/event-stream'});res.pipe(response);});
  upstream.on('error',()=>{response.writeHead(502);response.end('inference_unavailable');});
  request.pipe(upstream);
});
proxy.listen(0,'127.0.0.1',()=>{
  const base='http://127.0.0.1:'+proxy.address().port;
  const args=['exec','--ephemeral','--json','--ignore-rules','--ignore-user-config',
    '--sandbox','read-only','--skip-git-repo-check','--cd','/home/decision',
    '--model',input.model,'--output-schema','/input/schema.json',
    '--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins','--disable','multi_agent',
    '--config','web_search="disabled"','--config','model_provider="decision"',
    '--config','model_providers.decision.name="decision"',
    '--config','model_providers.decision.base_url='+JSON.stringify(base),
    '--config','model_providers.decision.wire_api="responses"',
    '--config','model_providers.decision.env_key="DECISION_AUTH_DUMMY"',
    '--config','model_providers.decision.requires_openai_auth=false','-'];
  const child=spawn('/runtime/codex',args,{env:{HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,
    PATH:'/usr/local/bin:/usr/bin:/bin',DECISION_AUTH_DUMMY:'isolated-dummy'},stdio:['pipe','pipe','pipe']});
  child.stdin.end(input.prompt);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  child.on('error',()=>{process.exitCode=1;proxy.close();});
  child.on('close',code=>{process.exitCode=code||0;proxy.close();});
});
`;

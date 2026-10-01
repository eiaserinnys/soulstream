import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { loadNodeSqlite } from '../../src/runner/node_sqlite.js';
import { TaskExecutor } from '../../src/task/task_executor.js';
import { TaskRuntimeCommands } from '../../src/upstream/task_runtime_commands.js';
import { RunnerProcessDispatcher } from '../../src/runner/runner_process_dispatcher.js';
import { RunnerProcessSpawner } from '../../src/runner/runner_process_spawn.js';
import { EventTransitionPublisher } from '../../src/db/event_transition_publisher.js';
import { TaskTurnInputBuilder } from '../../src/task/task_turn_input_builder.js';
import { ExecutionContextBuilder } from '../../src/context/context_builder.js';

const destination = process.env.RUNNER_DIAGNOSTIC_DIR;
const secretValues = Object.entries(process.env).filter(([k,v]) => /token|password|secret|oauth|api.?key/i.test(k) && v && v.length >= 8).map(([,v]) => v!);
secretValues.push('full-slice-service-token', 'full-slice-jwt-secret', 'container_browse_test');
function cleanText(s: string): string {
  for (const secret of secretValues) s = s.split(secret).join('[redacted]');
  return s.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database-url-redacted]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}
export function sanitized(value: any): any {
  if (typeof value === 'string') {
    const v=cleanText(value);
    if (/^[\[{]/.test(v)) { try { return sanitized(JSON.parse(v)); } catch {} }
    return v;
  }
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') {
    const result: any={};
    for (const [k,v] of Object.entries(value)) {
      if (/token|password|secret|oauth|authorization|api.?key|headers|^env$|_env$/i.test(k)) {
        result[k]=v==null?v:{redacted:true,sha256:createHash('sha256').update(JSON.stringify(v)).digest('hex')};
      } else result[k]=sanitized(v);
    }
    return result;
  }
  return typeof value==='bigint'?String(value):value;
}
export function diagnosticStage(stage: string, data: any={}): void {
  if (!destination) return;
  try {
    mkdirSync(destination,{recursive:true});
    appendFileSync(join(destination,`stages-${process.pid}.jsonl`),JSON.stringify(sanitized({time:Date.now(),monotonicMs:performance.now(),pid:process.pid,stage,...data}))+'\n');
  } catch {} // Diagnostics never determine the product result.
}
let installed=false;
export function installDiagnosticHooks(): void {
  if (!destination || installed) return;
  installed=true;
  const specs: [any,string[]][]=[
    [TaskRuntimeCommands,['createSession']],
    [TaskExecutor,['startNewExecution','startRecordedExecution','takeOrCreateRunner','_consumeEventStream']],
    [RunnerProcessSpawner,['spawn','spawnLocked']],
    [RunnerProcessDispatcher,['initialize','prepareExecutionIdentity','prepareSession','rollbackExecutionIdentity','connect']],
    [EventTransitionPublisher,['recordExecutionRegistrationAndWaitForApplication']],
    [TaskTurnInputBuilder,['prepareInitialTurnInput']],
    [ExecutionContextBuilder,['build']],
  ];
  for (const [owner,methods] of specs) for (const name of methods) {
    const original=owner.prototype[name];
    if(typeof original!=='function') { diagnosticStage('hook_missing',{owner:owner.name,name});continue; }
    owner.prototype[name]=function(this:any,...args:any[]) {
      const stage=`${owner.name}.${name}`;
      const sessionId=args[0]?.agentSessionId ?? (typeof args[0]==='string'?args[0]:args[0]?.sessionId);
      diagnosticStage(stage+'.enter',{sessionId});
      try {
        const result=original.apply(this,args);
        const done=(value:any)=>diagnosticStage(stage+'.resolved',{sessionId,registrationId:value?.registrationId,executionCommandId:value?.executionCommandId,childPid:value?.pid,applied:value?.applied});
        if(!result || typeof result.then!=='function') done(result);
        // Async completion is inferred from the next awaited gate and receipt snapshot.
        // Do not attach handlers: preserve native unhandled-rejection semantics.
        return result; // Return the exact original object/Promise.
      } catch(error:any) { diagnosticStage(stage+'.threw',{sessionId,error:String(error),stack:error?.stack});throw error; }
    };
  }
  const originalSpawn=childProcess.spawn;
  (childProcess as any).spawn=function(...args:any[]) {
    const child=(originalSpawn as any)(...args);
    diagnosticStage('child.spawn',{childPid:child.pid,command:basename(String(args[0]))});
    child.once('exit',(code:number|null,signal:string|null)=>diagnosticStage('child.exit',{childPid:child.pid,code,signal}));
    child.once('error',(error:Error)=>diagnosticStage('child.error',{childPid:child.pid,error:String(error)}));
    for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]] as const) if(stream) {
      stream.on('data',(data:Buffer)=>{
        try {appendFileSync(join(destination!,`child-${child.pid}-${name}.log`),cleanText(data.toString()));}catch{}
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  diagnosticStage('hooks_installed',{methods:specs.flatMap(([owner,names])=>names.map(name=>`${owner.name}.${name}`))});
}

export async function captureDiagnosticSnapshot(root:string,sql:any,phase:string):Promise<void> {
  if(!destination) return;
  diagnosticStage('snapshot.enter',{phase});
  const result:any={time:Date.now(),phase,files:[],postgres:{},errors:[]};
  function walk(path:string):void {
    for(const item of readdirSync(path,{withFileTypes:true})) {
      const source=join(path,item.name),rel=relative(root,source);
      if(item.isDirectory()) { if(!rel.startsWith('runner-releases')&&!rel.startsWith('runner-artifact')) walk(source);continue; }
      const info:any={path:rel,kind:item.isFile()?'file':item.isSocket()?'socket':'other',bytes:statSync(source).size};
      result.files.push(info);
      if(!item.isFile())continue;
      try {
        if(item.name.endsWith('.sqlite')) {
          const { DatabaseSync } = loadNodeSqlite();
          const db=new DatabaseSync(source,{readOnly:true});
          try {
            info.sqlite={};
            const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            for(const table of tables) {
              const name=String(table.name);
              if(!/^[a-zA-Z0-9_]+$/.test(name))continue;
              info.sqlite[name]={count:db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get(),rows:db.prepare(`SELECT * FROM "${name}" LIMIT 200`).all()};
            }
          } finally {db.close();}
        } else if(/\.jsonl?$|\.log$|\.pid$|\.lock$|lease|registration/.test(item.name)) {
          const raw=readFileSync(source,'utf8');
          try { info.content=JSON.parse(raw); } catch { info.content=cleanText(raw); }
        }
      } catch(error:any) {info.error=cleanText(String(error));}
    }
  }
  try {walk(root);}catch(error){result.errors.push(String(error));}
  const pids=new Set<number>();
  for(const file of result.files) {
    if(typeof file.content?.pid==='number')pids.add(file.content.pid);
    if(file.path.endsWith('runner.pid') && /^\d+\s*$/.test(file.content??''))pids.add(Number(file.content));
  }
  try {
    for(const name of readdirSync(destination).filter(x=>/^stages-.*\.jsonl$/.test(x)))
      for(const line of readFileSync(join(destination,name),'utf8').trim().split('\n')) {
        try {const record=JSON.parse(line);if(record.childPid)pids.add(record.childPid);}catch{}
      }
  }catch{}
  result.processes=[...pids].map(pid=>{
    try {return {pid,stat:readFileSync(`/proc/${pid}/stat`,'utf8'),status:readFileSync(`/proc/${pid}/status`,'utf8')};}
    catch {return {pid,present:false};}
  });
  for(const table of ['sessions','events','event_ingress_receipts','session_deliveries','cards','card_orchestration_dispatches','system_settings']) {
    try {
      const query=sql.unsafe(`SELECT to_jsonb(r) AS row FROM ${table} r LIMIT 200`);
      let timer:any;
      try {result.postgres[table]=await Promise.race([query,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('diagnostic read timeout')),5000);})]);}
      finally {clearTimeout(timer);}
    }catch(error){result.postgres[table]={error:String(error)};}
  }
  try {writeFileSync(join(destination,`${phase}.json`),JSON.stringify(sanitized(result),null,2)+'\n');}
  catch(error){diagnosticStage('snapshot.write_failed',{phase,error:String(error)});}
  diagnosticStage('snapshot.resolved',{phase});
}

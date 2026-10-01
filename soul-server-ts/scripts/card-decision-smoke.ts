/** Operator-only inference smoke: no queue, session registration, policy mutation or admission. */
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pino from 'pino';
import {ModelCatalog} from '../src/model_catalog.js';
import {DecisionExecutor} from '../src/card-orchestration/decision_executor.js';
import {readDecisionCredential} from '../src/card-orchestration/runtime_composition.js';
import {resolveClaudeExecutableFromPath} from '../src/engine/claude_executable_path.js';
import {OrchestrationDecisionSchema,parseOrchestrationDecision} from '@soulstream/wire-schema/card-orchestration';
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('tsx scripts/card-decision-smoke.ts --live --catalog <worker model-catalog.yaml> --preset <claude-opus|codex-6-astra> [--instructions-file <trusted compiled atom text>]');
 console.log('Use the worker service environment. This command sends one empty-snapshot inference through the dedicated executor; it never activates or dispatches the queue.');
}else{
 if(!args.includes('--live'))throw new Error('Explicit --live is required for a real provider call');
 const option=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
 const catalogPath=option('--catalog'),presetId=option('--preset');
 if(!catalogPath||!presetId)throw new Error('Explicit --catalog and --preset are required');
 const preset=new ModelCatalog(catalogPath,pino({level:'silent'})).resolve(presetId);
 if(preset.backend!=='claude'&&preset.backend!=='codex')throw new Error('Only dedicated Claude/Codex executors are supported');
 const timeoutMs=Number(process.env.CARD_DECISION_TIMEOUT_MS??300000);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new Error('Invalid CARD_DECISION_TIMEOUT_MS');
 const executor=new DecisionExecutor({
  claudeExecutable:process.env.CARD_DECISION_CLAUDE_EXECUTABLE_PATH??resolveClaudeExecutableFromPath(),
  credential:backend=>readDecisionCredential(backend,process.env.CLAUDE_AUTH_TOKEN_PATH),
  codex:{image:process.env.CARD_DECISION_DOCKER_IMAGE,binaryPath:process.env.CARD_DECISION_CODEX_BINARY_PATH,timeoutMs},
 });
 const readiness=await executor.prepare(preset.backend);
 if(readiness.status!=='ready'){console.log(JSON.stringify(readiness));process.exitCode=1;}
 else{
  const path=option('--instructions-file'),instructions=path?await readFile(path,'utf8'):'';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const result=await executor.execute({sessionId:randomUUID(),runId:randomUUID(),backend:preset.backend,model:preset.model,
    prompt:`${instructions}\nReturn {"decisions":[]} for the following empty snapshot. Do not perform any action.\n${JSON.stringify({purpose:'card_orchestration_decision',candidates:[],context:{running:[],capacity:{}}})}`,
    outputSchema:OrchestrationDecisionSchema,signal:controller.signal});
   if(result.status==='ready'){const decision=parseOrchestrationDecision(result.output);if(decision.decisions.length)throw new Error('Empty snapshot produced decisions');console.log(JSON.stringify({status:'ready',preset:preset.id,backend:preset.backend,decisions:[]}));}
   else{console.log(JSON.stringify(result));process.exitCode=1;}
  }finally{clearTimeout(timer);}
 }
}

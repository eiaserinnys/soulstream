import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot=path.resolve(process.env.SOURCE_ROOT ?? path.join(import.meta.dirname,'../../..'));
const outputDir=path.resolve(process.env.VERIFICATION_OUTPUT ?? path.join(sourceRoot,'.state-verification/cards'));
await fs.mkdir(outputDir,{recursive:true});
const sourcePath=path.join(sourceRoot,'orch-server-ts/src/cards/card_orchestration_workers.ts');
const source=await fs.readFile(sourcePath,'utf8');
const statuses=['todo','queued','blocked','running','review','on_hold','done','cancelled'];
const findings=[];
const checks=[];
const variants=[
 {name:'baseline',source},
 {name:'mutant_remove_accepted_timeout_guard',source:source.replace('if (!d.launch_accepted)','if (true)')},
 {name:'mutant_ignore_claim_result',source:source.replace('if (!(await this.options.repository.claimWorker(d.session_id))) continue;','await this.options.repository.claimWorker(d.session_id);')},
];
for(const v of variants) {
 if(v.name!=='baseline'&&v.source===source)throw new Error('Mutant edit failed: '+v.name);
}
function fixture({cardStatus='queued',dispatchState='admitted',accepted=false,expired=false,transport='accepted'}={}) {
 const dispatch={run_id:'run-1',card_id:'card-1',session_id:'worker-1',node_id:'node-1',input:{},state:dispatchState,launch_token:'launch-1',launch_accepted:accepted,expired};
 const card={id:'card-1',status:cardStatus,version:7,assignee_session_id:null,assignee_kind:'agent'};
 const log=[];
 let launches=0;
 const repository={
   pendingWorkers:async()=>['admitted','launching'].includes(dispatch.state)?[structuredClone(dispatch)]:[],
   claimWorker:async()=>{if(dispatch.state!=='admitted')return false;dispatch.state='launching';log.push('atomic claim succeeds');return true;},
   workerObserved:async()=>dispatch.state==='running',
   workerState:async(_id,state,reason)=>{if(['admitted','launching'].includes(dispatch.state)){dispatch.state=state;log.push('dispatch -> '+state+': '+reason);}},
   note:async(state,reason)=>{log.push('orchestration '+state+': '+reason);}
 };
 const cards={getCard:async()=>({card:structuredClone(card)}),setCardStatus:async p=>{
   if(p.expectedVersion!==card.version)throw new Error('CAS conflict');
   card.status=p.status;card.version++;log.push('card -> '+p.status);
 }};
 const launch=async()=>{launches++;log.push('launch #'+launches);
   if(transport==='accepted')dispatch.launch_accepted=true;
   if(transport==='uncertain')throw new Error('transport timeout; acceptance unknown');
   if(transport==='rejected')throw Object.assign(new Error('node rejected'),{code:'NODE_REJECTED'});
 };
 return {dispatch,card,log,get launches(){return launches;},options:{repository,cards:async()=>cards,launchWorker:launch,sendMessage:launch,warn:m=>log.push('warning: '+m)}};
}
for(const variant of variants) {
 const local=path.join(outputDir,variant.name+'.ts');
 await fs.writeFile(local,variant.source);
 const {CardOrchestrationWorkers}=await import(pathToFileURL(local).href);
 let total=0;
 const violations=[];
 for(const status of statuses) {
   for(const expired of [false,true]) {
     total++;
     const f=fixture({cardStatus:status,dispatchState:'launching',accepted:true,expired});
     await new CardOrchestrationWorkers(f.options).reconcile();
     if(f.dispatch.state!=='launching'||f.card.status!==status||f.launches!==0)violations.push({property:'AcceptedUnobservedNotRejected',status,expired,after:{dispatch:f.dispatch.state,card:f.card.status,launches:f.launches},trace:f.log});
   }
 }
 for(const n of [1,2,3]) {
   for(const transport of ['accepted','uncertain','rejected']) {
     total++;
     const f=fixture({transport});
     // Each controller receives the same admitted snapshot before either has claimed it.
     const settlements=await Promise.allSettled(Array.from({length:n},()=>new CardOrchestrationWorkers(f.options).reconcile()));
     for(const result of settlements)if(result.status==='rejected')f.log.push('controller exception: '+result.reason.message);
     // Repeat reconciliation across reconstructed controller instances, simulating process restart.
     for(let i=0;i<3;i++)await new CardOrchestrationWorkers(f.options).reconcile();
     if(f.launches>1)violations.push({property:'AtMostOneLaunchFromAtomicClaim',controllers:n,transport,launches:f.launches,trace:f.log});
   }
 }
 checks.push({variant:variant.name,cases:total,pass:violations.length===0,violations:violations.slice(0,4),totalViolations:violations.length});
 if(variant.name==='baseline') {
   const f=fixture({cardStatus:'running',dispatchState:'launching',accepted:false,expired:true,transport:'uncertain'});
   await new CardOrchestrationWorkers(f.options).reconcile();
   findings.push({
     kind:'observed source behavior; full end-to-end reachability/policy not proven',
     scenario:'An older unaccepted expired dispatch is reconciled after a later direct status edit to running',
     outcome:{cardStatus:f.card.status,cardVersion:f.card.version,dispatchState:f.dispatch.state},
     trace:f.log,
     rationale:'reject() rereads the current card and uses its fresh version; it checks only running/queued, not dispatch identity, admittedCardVersion or intervening status changes. This harness cannot establish the production reachability or intended semantics of every reassignment path.'
   });
 }
}
const result={sourceCommit:'1f15e59e3747fc5de5e245babf16753cce8a7367',source:sourcePath,runtime:process.version,
 method:'Execute actual repository class through injected in-memory repository, card and transport ports; not PostgreSQL or real node integration.',
 bounds:{cards:1,dispatches:1,controllers:[1,2,3],reconciliationRepeats:3,cardStatuses:statuses,transportOutcomes:['accepted','uncertain','rejected']},
 checks,findings,
 scope:'SQL claim atomicity and snapshot semantics are port assumptions. Covers controller branch logic, not worker execution registration, DB isolation, authorization routes, leases or end-to-end exactly-once execution.'};
await fs.writeFile(path.join(outputDir,'results.json'),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!checks.find(c=>c.variant==='baseline').pass || checks.filter(c=>c.variant!=='baseline').some(c=>c.pass))process.exitCode=1;


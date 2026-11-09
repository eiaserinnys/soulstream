import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = import.meta.dirname;
const sourceRoot = resolve(process.env.SOURCE_ROOT ?? process.argv[2] ?? resolve(dir, '../../..'));
const outputDir = resolve(process.env.VERIFICATION_OUTPUT ?? join(sourceRoot, '.state-verification/outbox'));
await mkdir(outputDir, { recursive: true });
const relative = 'soul-server-ts/src/upstream/';
const source = await readFile(join(sourceRoot, relative, 'event_outbox_pump.ts'), 'utf8');
const protocol = await readFile(join(sourceRoot, relative, 'event_outbox_pump_protocol.ts'), 'utf8');
const generated = join(outputDir, 'generated');
await mkdir(generated, { recursive: true });
await writeFile(join(generated, 'event_outbox_pump_protocol.mjs'), stripTypeScriptTypes(protocol, { mode: 'transform' }));
const fence = 'if (sender !== this.sender || generation !== this.generation) return;';
const fenceIndex = source.lastIndexOf(fence);
if (fenceIndex < 0) throw new Error('Source mapping changed: publication fence not found');
const mutants = [
  {name:'baseline', text:source},
  {name:'remove_post_local_publication_fence',text:source.slice(0,fenceIndex)+'/* mutation: no post-await connection fence */'+source.slice(fenceIndex+fence.length)},
  {name:'remove_ack_stream_check',text:source.replace('if (ack.stream_id !== this.outbox.streamId) {','if (false) {')},
  {name:'remove_ack_sequence_mapping',text:source.replace('if (ack.events[index]!.source_seq !== batch.events[index]!.source_seq) {','if (false) {')},
];
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};};
const tick = () => new Promise(r=>setImmediate(r));
const batch = {type:'event_append_batch',stream_id:'stream-A',first_seq:1,events:[{stream_id:'stream-A',source_seq:1,session_id:'session-A',event_type:'message',payload:{},payload_hash:'hash'}]};
const validAck = () => ({type:'event_append_ack',stream_id:'stream-A',acked_through:1,events:[{source_seq:1,event_id:101}]});

function fixture(Pump, boundary) {
  const entered=deferred(), release=deferred();
  let reads=0, publishes=0, acked=0;
  const oldSent=[],newSent=[],errors=[];
  const store={streamId:'stream-A',get ackedSeq(){return acked;},onAppend(){return ()=>{};},
    async readBatch(){reads++;if(boundary==='read'&&reads===1){entered.resolve();await release.promise;}return acked?null:structuredClone(batch);},
    async acknowledge(stream,seq){acked=seq;}};
  const pump = new Pump(store,e=>errors.push(String(e)),{beforePublish:async()=>{publishes++;if(boundary==='local'&&publishes===1){entered.resolve();await release.promise;}}});
  return {pump,store,entered,release,oldSent,newSent,errors,old:async b=>oldSent.push(b),fresh:async b=>newSent.push(b)};
}

const checks=[];
for(const variant of mutants){
  if(variant.name!=='baseline'&&variant.text===source)throw new Error('Mutation failed: '+variant.name);
  const file=join(generated,variant.name+'.mjs');
  await writeFile(file,stripTypeScriptTypes(variant.text,{mode:'transform'}).replaceAll('./event_outbox_pump_protocol.js','./event_outbox_pump_protocol.mjs'));
  const {EventOutboxPump}=await import(pathToFileURL(file).href);
  const cases=[];
  for(const boundary of ['read','local']){
    const f=fixture(EventOutboxPump,boundary);
    const ready1=f.pump.connect(f.old);
    await f.entered.promise;
    f.pump.disconnect();
    const ready2=f.pump.connect(f.fresh);
    f.release.resolve();
    await tick();await tick();
    const pass=f.oldSent.length===0&&f.newSent.length===1&&f.errors.length===0;
    cases.push({property:'NeverPublishOnStaleConnection',boundary,pass,oldSends:f.oldSent.length,newSends:f.newSent.length,
      trace:['connect generation 1','pause at '+boundary,'disconnect','reconnect generation 3','old await resolves',`old sends=${f.oldSent.length}, new sends=${f.newSent.length}`]});
    f.pump.disconnect();await Promise.all([ready1,ready2]);
  }
  for(const kind of ['wrong-stream','wrong-sequence','wrong-range','valid']){
    const f=fixture(EventOutboxPump);const ready=f.pump.connect(f.old);await tick();
    const ack=validAck();
    if(kind==='wrong-stream')ack.stream_id='stream-B';
    if(kind==='wrong-sequence')ack.events[0].source_seq=2;
    if(kind==='wrong-range')ack.acked_through=2;
    let rejected=false;try{await f.pump.handleAck(ack);}catch{rejected=true;}
    cases.push({property:kind==='valid'?'MatchingAckAdvancesDurableCursor':'InvalidAckCannotAdvanceCursor',kind,
      pass:kind==='valid'?(!rejected&&f.store.ackedSeq===1):(rejected&&f.store.ackedSeq===0),rejected,acked:f.store.ackedSeq});
    f.pump.disconnect();await ready;
  }
  checks.push({variant:variant.name,pass:cases.every(c=>c.pass),cases});
}
const result={sourceCommit:'1f15e59e3747fc5de5e245babf16753cce8a7367',runtime:process.version,
  sourceSha256:createHash('sha256').update(source).digest('hex'),protocolSha256:createHash('sha256').update(protocol).digest('hex'),
  method:'Unchanged production EventOutboxPump class, built-in Node type erasure, deterministic asynchronous store and transport ports.',
  scope:'Six scheduled cases. Actual disk writes, PostgreSQL receipt transactions, batch sizes above one, packet reordering, OS failure and liveness excluded.',checks};
await writeFile(join(outputDir,'results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({baselineCases:checks[0].cases.length,baselinePass:checks[0].pass,mutants:checks.slice(1).map(c=>({name:c.variant,detected:!c.pass,failures:c.cases.filter(x=>!x.pass)}))},null,2));
if(!checks[0].pass||checks.slice(1).some(c=>c.pass))process.exitCode=1;

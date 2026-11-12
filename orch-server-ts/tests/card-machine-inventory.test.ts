import { readFile, readdir } from 'node:fs/promises';
import { expect,it } from 'vitest';
import { cardDecisionMachine } from '../src/cards/state/card_decision_machine.js';
import { CARD_FACT_VALUES } from '../src/cards/state/card_decision_facts.js';
import { CARD_DECISION_SOURCES, CARD_RUNTIME_SQL_WRITERS, CARD_COMMAND_ENTRANCES, CARD_COMMAND_CALLERS } from '../src/cards/state/card_decision_inventory.js';
import { CARD_RUNTIME_DECISION_CALLS, CARD_RUNTIME_DECISION_IMPORTERS } from '../src/cards/state/card_decision_inventory.js';
it('pins every command to an existing operational function',async()=>{
 expect(Object.keys(CARD_DECISION_SOURCES).sort()).toEqual(Object.keys(CARD_FACT_VALUES).sort());
 for(const [file,name] of Object.values(CARD_DECISION_SOURCES))expect(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8')).toMatch(new RegExp(`\\b${name}\\b`));
 expect(CARD_RUNTIME_SQL_WRITERS).toHaveLength(4);
 expect(CARD_COMMAND_CALLERS.CREATE).toContain('cards/card_control_plane_service.ts#createCardTx');
 expect(CARD_COMMAND_CALLERS.ADD_COMMENT).toContain('cards/card_control_plane_service.ts#addCommentTx');
 expect(CARD_COMMAND_CALLERS.ADD_COMMENT).toContain('cards/card_work_dispatch_service.ts#accept');
});
const decisionImport=/(?:from\s*|import\s*(?:\(\s*)?)["'][^"']*(?:cards\/)?state\/card_(?:decision|state_value|write_intent|machine|command_entrance|(?:human|server|remaining)_(?:command|evidence))/;
it('pins every runtime decision call to its final operational file',async()=>{
 const files:string[]=[];
 async function walk(directory:string){
 for(const entry of await readdir(new URL(`../${directory}`,import.meta.url),{withFileTypes:true})){
 const path=`${directory}/${entry.name}`;
 if(entry.isDirectory())await walk(path);else if(entry.isFile()&&entry.name.endsWith('.ts'))files.push(path);
 }
 }
 await walk('src');
 const writers:string[]=[];
 const importers:string[]=[];
 for(const file of files){
 if(file.startsWith('src/cards/state/'))continue;
 const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
 if(decisionImport.test(source))importers.push(file.slice(4));
 for(const match of source.matchAll(/\b(INSERT\s+INTO|UPDATE)\s+cards\b/g))writers.push(`${file.slice(4)}:${match[1]!.startsWith('INSERT')?'INSERT':'UPDATE'}`);
 }
 expect(writers.sort()).toEqual([...CARD_RUNTIME_SQL_WRITERS].sort());
 expect(importers.sort()).toEqual([...CARD_RUNTIME_DECISION_IMPORTERS].sort());
 expect(Object.keys(CARD_RUNTIME_DECISION_CALLS).sort()).toEqual(Object.keys(CARD_FACT_VALUES).sort());
 expect(Object.values(CARD_RUNTIME_DECISION_CALLS).flat()).toHaveLength(25);
 for(const [command,locators] of Object.entries(CARD_RUNTIME_DECISION_CALLS))for(const locator of locators){
 const [file,name]=locator.split('#');
 const source=await readFile(new URL(`../src/${file}`,import.meta.url),'utf8');
 expect(source,locator).toContain(name);
 expect(source.includes(`type:'${command}'`),locator).toBe(true);
 }

});

it('keeps world transition memoization valid for static symbolic actions',()=>{
 const visit=(node:typeof cardDecisionMachine.root)=>{
 expect(node.entry).toEqual([]);expect(node.exit).toEqual([]);
 expect(node.always??[]).toEqual([]);
 for(const transitions of Object.values(node.on))for(const t of transitions){
 expect(t.meta?.sources).toEqual(CARD_DECISION_SOURCES[t.eventType as keyof typeof CARD_DECISION_SOURCES]);
 for(const action of t.actions as any[])expect(typeof action.params).not.toBe('function');
 }
 Object.values(node.states).forEach(visit);
 };
 visit(cardDecisionMachine.root);
});

it('pins the actual forwarded actors for execution confirmation and replacement',async()=>{
 expect(CARD_COMMAND_ENTRANCES.CONFIRM_EXECUTION).toEqual(['human','agent','server']);
 expect(CARD_COMMAND_ENTRANCES.REGISTER_REPLACEMENT).toEqual(['agent']);
 for(const command of ['CONFIRM_EXECUTION','REGISTER_REPLACEMENT'] as const){
 const meta=cardDecisionMachine.getStateNodeById('cardDecision.verdict.ready').on[command]![0]!.meta!;
 expect(meta.entrances).toEqual(CARD_COMMAND_ENTRANCES[command]);
 expect(meta.callers).toEqual(CARD_COMMAND_CALLERS[command]);
 for(const locator of CARD_COMMAND_CALLERS[command]){const [file,name]=locator.split('#');expect(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8')).toContain(name);}
 }
 const execution=await readFile(new URL('../src/cards/card_execution_service.ts',import.meta.url),'utf8');
 expect(execution).toContain('recordExecution({...actor,');
 expect(execution).toContain('actorKind:actor.actorKind,actorSessionId:actor.actorSessionId,actorUserId:actor.actorUserId');
 const replacement=await readFile(new URL('../src/control_plane/repositories/session_card_replacement.ts',import.meta.url),'utf8');
 expect(replacement).toContain('actorKind:"agent",actorSessionId:row.actor_session_id');
});

it('detects static, side-effect and dynamic forbidden runtime imports',()=>{
 for(const source of ["import { decide } from './state/card_decision.js'", "import './state/card_decision.js'", "import('../cards/state/card_decision.js')", "import './state/card_command_entrance.js'", "import('./state/card_human_evidence.js')", "import './state/card_server_evidence.js'"])
 expect(source).toMatch(decisionImport);
});

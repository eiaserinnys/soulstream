import { readFile,readdir } from 'node:fs/promises';
import { expect,it } from 'vitest';
import {
 SESSION_DIRECT_WRITES,
 SESSION_SQL_WRITERS,
 SESSION_STATUS_LITERAL_ALLOWLIST,
 SESSION_STATUS_LITERAL_COMPARE_PATTERN,
 SESSION_STATUS_LITERAL_LIST_PATTERN,
 SESSION_STATUS_LITERAL_SQL_PATTERN,
} from '../src/session/state/session_state_writes.js';

const machineDirectory='src/session/state/';

async function sourceFiles(): Promise<string[]>{
 const files:string[]=[];
 async function walk(directory:string){
 for(const entry of await readdir(new URL(`../${directory}`,import.meta.url),{withFileTypes:true})){
 const path=`${directory}/${entry.name}`;
 if(entry.isDirectory())await walk(path);
 else if(entry.isFile()&&entry.name.endsWith('.ts')&&!path.startsWith(machineDirectory))files.push(path);
 }
 }
 await walk('src');
 return files.sort();
}

it('matches every SQL session writer call by file and count',async()=>{
 const schema=await readFile(new URL('../../packages/db-schema/sql/schema.sql',import.meta.url),'utf8');
 for(const writer of SESSION_SQL_WRITERS){
 const found:Array<{file:string;count:number}>=[];
 for(const file of await sourceFiles()){
 const lines=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).split('\n');
 const pattern=new RegExp(`(?<![A-Za-z0-9_])${writer.name}\\s*\\(`);
 const count=lines.filter(line=>pattern.test(line)).length;
 if(count)found.push({file,count});
 }
 const expected=[...writer.callSites].sort((a,b)=>a.file.localeCompare(b.file));
 expect(found.sort((a,b)=>a.file.localeCompare(b.file)),writer.name).toEqual(expected);
 const pattern=new RegExp(`CREATE OR REPLACE FUNCTION ${writer.name}\\s*\\(`);
 const start=schema.search(pattern);
 expect(start,writer.name).toBeGreaterThanOrEqual(0);
 const body=schema.slice(start,schema.indexOf('$$;',start)+3);
 if(writer.writesStatus){
 expect(body,writer.name).toMatch(/\bstatus\b/);
 }else{
 expect(body,writer.name).not.toMatch(/\bstatus\s*=/);
 }
 }
 const updateStart=schema.search(/CREATE OR REPLACE FUNCTION session_update\s*\(/);
 expect(schema.slice(updateStart,schema.indexOf('$$;',updateStart))).toContain("'status'");
});

it('matches every direct session write in file order and checks its status flag',async()=>{
 const found=new Map<string,{line:string;statement:string}[]>();
 for(const file of await sourceFiles()){
 const lines=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).split('\n');
 lines.forEach((line,index)=>{
 if(!/\b(INSERT\s+INTO|UPDATE)\s+sessions\b/.test(line))return;
 const remaining=lines.slice(index).join('\n');
 const statement=remaining.slice(0,remaining.indexOf(';')+1);
 const writes=found.get(file)??[];
 writes.push({line,statement});
 found.set(file,writes);
 });
 }
 const files=[...new Set(SESSION_DIRECT_WRITES.map(write=>write.file))].sort();
 expect([...found.keys()].sort()).toEqual(files);
 for(const file of files){
 const writes=SESSION_DIRECT_WRITES.filter(write=>write.file===file);
 const actual=found.get(file)!;
 expect(actual.length,file).toBe(writes.length);
 for(let index=0;index<writes.length;index+=1){
 const write=writes[index]!;
 expect(actual[index]!.line,`${file} #${index+1}`).toContain(write.statement);
 expect(/\bstatus\s*=/.test(actual[index]!.statement),`${file} #${index+1}`).toBe(write.writesStatus);
 }
 }
});

it('pins every session status literal to the allowlist with its meaning',async()=>{
 const compare=new RegExp(SESSION_STATUS_LITERAL_COMPARE_PATTERN);
 const list=new RegExp(SESSION_STATUS_LITERAL_LIST_PATTERN);
 const sql=new RegExp(SESSION_STATUS_LITERAL_SQL_PATTERN,'i');
 const counts=new Map<string,{comparisons:number;lists:number;sql:number}>();
 for(const file of await sourceFiles()){
 const lines=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).split('\n');
 for(const line of lines){
 const row=counts.get(file)??{comparisons:0,lists:0,sql:0};
 if(compare.test(line))row.comparisons+=1;
 if(list.test(line))row.lists+=1;
 if(sql.test(line))row.sql+=1;
 if(row.comparisons+row.lists+row.sql>0)counts.set(file,row);
 }
 }
 const declared=new Map(SESSION_STATUS_LITERAL_ALLOWLIST.map(entry=>[entry.file,{comparisons:entry.comparisons,lists:entry.lists,sql:entry.sql}]));
 expect([...counts.keys()].sort()).toEqual([...declared.keys()].sort());
 for(const [file,row] of counts)expect(row,file).toEqual(declared.get(file));
 for(const entry of SESSION_STATUS_LITERAL_ALLOWLIST){
 expect(entry.note.length,entry.file).toBeGreaterThan(0);
 expect(entry.comparisons+entry.lists+entry.sql,entry.file).toBeGreaterThan(0);
 }
});

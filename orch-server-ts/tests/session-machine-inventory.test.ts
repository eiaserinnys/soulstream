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

it('pins every SQL session writer call to its line',async()=>{
 for(const writer of SESSION_SQL_WRITERS){
 const found:string[]=[];
 for(const file of await sourceFiles()){
 const lines=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).split('\n');
 const pattern=new RegExp(`(?<![A-Za-z0-9_])${writer.name}\\s*\\(`);
 lines.forEach((line,index)=>{if(pattern.test(line))found.push(`${file}:${index+1}`);});
 }
 const expected=writer.callSites.map(site=>`${site.file}:${site.line}`).sort();
 expect(found,writer.name).toEqual(expected);
 const schema=(await readFile(new URL('../../packages/db-schema/sql/schema.sql',import.meta.url),'utf8')).split('\n');
 expect(schema[Number(writer.definition.split(':').at(-1))-1],writer.name).toContain(writer.name);
 }
 const schema=(await readFile(new URL('../../packages/db-schema/sql/schema.sql',import.meta.url),'utf8'));
 for(const writer of SESSION_SQL_WRITERS){
 const start=schema.indexOf(`CREATE OR REPLACE FUNCTION ${writer.name}`);
 const body=schema.slice(start,schema.indexOf('$$;',start)+3);
 if(writer.writesStatus){
 expect(body,writer.name).toMatch(/\bstatus\b/);
 }else{
 expect(body,writer.name).not.toMatch(/\bstatus\s*=/);
 }
 }
 expect(schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION session_update'),schema.indexOf('$$;',schema.indexOf('CREATE OR REPLACE FUNCTION session_update')))).toContain("'status'");
});

it('pins every direct session write to its line and status flag',async()=>{
 const found:string[]=[];
 for(const file of await sourceFiles()){
 const lines=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).split('\n');
 lines.forEach((line,index)=>{
 if(/\b(INSERT\s+INTO|UPDATE)\s+sessions\b/.test(line))found.push(`${file}:${index+1}`);
 });
 }
 expect(found.sort()).toEqual(SESSION_DIRECT_WRITES.map(write=>`${write.file}:${write.line}`).sort());
 for(const write of SESSION_DIRECT_WRITES){
 const lines=(await readFile(new URL(`../${write.file}`,import.meta.url),'utf8')).split('\n');
 let statement='';
 for(let index=write.line-1;index<lines.length&&index<write.line+10;index+=1){
 statement+=`${lines[index]}\n`;
 if(lines[index]!.includes(';'))break;
 }
 expect(/\bstatus\s*=/.test(statement),`${write.file}:${write.line}`).toBe(write.writesStatus);
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
 const totals=SESSION_STATUS_LITERAL_ALLOWLIST.reduce((sum,entry)=>({
 comparisons:sum.comparisons+entry.comparisons,
 lists:sum.lists+entry.lists,
 sql:sum.sql+entry.sql,
 }),{comparisons:0,lists:0,sql:0});
 expect(SESSION_STATUS_LITERAL_ALLOWLIST).toHaveLength(80);
 expect(totals).toEqual({comparisons:82,lists:29,sql:57});
 for(const entry of SESSION_STATUS_LITERAL_ALLOWLIST){
 expect(entry.note.length,entry.file).toBeGreaterThan(0);
 expect(entry.comparisons+entry.lists+entry.sql,entry.file).toBeGreaterThan(0);
 }
});

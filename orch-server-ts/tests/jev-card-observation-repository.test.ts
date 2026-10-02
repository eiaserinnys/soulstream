import { expect,it } from 'vitest';
import { JevCardObservationDbRepository } from '../src/cards/jev_card_observation_repository.js';
import type { LiveDbSqlResolver,LivePostgresSql } from '../src/runtime/live_db_sql.js';
const complete={nodeId:'n',sessionId:'owner',completeEventId:100};
function harness(owned=14) {
  const calls:Array<{text:string;values:unknown[]}>=[];
  const sql=Object.assign(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const text=strings.join('?').replace(/\s+/g,' '); calls.push({text,values});
    if(text.includes('AS previous_id')) return [{id:100,created_at:'2026-10-02T00:00:00Z',previous_id:50,final_id:99}];
    if(text.includes('WITH assigned')) return Array.from({length:Math.min(owned,12)},(_,i)=>({id:`card-${String(i).padStart(2,'0')}`,title:'작업',status:'running',version:2,instruction:'지시',report:'보고',total:owned}));
    if(text.includes('SELECT id,event_type,payload')) return [{id:96,event_type:'folder_operation',payload:{target_kind:'card',target_id:'completed-owned'}}];
    if(text.includes('FROM cards c WHERE')) {
      const ids=values.find(Array.isArray) as string[];
      expect(ids).toHaveLength(Math.min(12,owned+1));
      expect(text).toContain('c.assignee_session_id=');
      expect(text).not.toContain('folder_operations');
      return ids.map(id=>({id,title:'작업',status:'running',version:2,request:'지시',brief:'',instruction:'',report:'',updated_at:'2026-10-01T23:59:00Z'}));
    }
    if(text.includes('COUNT(*) OVER ()::int AS total')) return [{id:99,event_type:'assistant_message',text:'다른 작업을 기다립니다.',total:205}];
    return [];
  },{json:(v:unknown)=>v}) as unknown as LivePostgresSql;
  return {calls,repo:new JevCardObservationDbRepository({resolveSql:async()=>sql} as LiveDbSqlResolver)};
}
it('caps deterministic union before one bounded detail query and preserves omitted source counts',async()=>{
  const {repo,calls}=harness();
  const result=await repo.load(complete);
  expect(result?.input.cards).toHaveLength(12);
  expect(result?.input.scope.cardCounts).toMatchObject({endTotal:14,totalIsLowerBound:true});
  expect(result?.input.scope.omittedCards).toBe(2);
  expect(result?.input.scope.omittedHistoryEvents).toBe(204);
  expect(result?.input.scope.actualStartSnapshot).toBe('unavailable');
  expect(result?.input.scope.endSnapshot).toBe('after_completion_read');
  expect(calls.filter(c=>c.text.includes('FROM cards c WHERE'))).toHaveLength(1);
  expect(calls.every(c=>!c.text.includes('UPDATE ')&&!c.text.includes('INSERT '))).toBe(true);
});
it('can observe done-in-this-turn cards through own operation IDs without resending old done cards',async()=>{
  const {repo,calls}=harness(0);
  const result=await repo.load(complete);
  expect(result?.input.cards.map(c=>c.id)).toEqual(['completed-owned']);
  const query=calls.find(c=>c.text.includes('SELECT id,event_type,payload'))!;
  expect(query.values).toEqual(['owner',50,100]);
});

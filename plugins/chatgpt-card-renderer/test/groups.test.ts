import test from 'node:test';
import assert from 'node:assert/strict';
import {groupWidgetCards} from '../src/card-groups.ts';
test('every supported state belongs to one ordered group and source order is preserved',()=>{
 const cards=['done','blocked','review','unknown','running','cancelled','todo','queued'].map((status,index)=>({id:String(index),title:status,status,assignee:'',updatedAt:null}));
 const groups=groupWidgetCards(cards);
 assert.deepEqual(groups.map(g=>[g.id,g.cards.map(c=>c.id)]),[['attention',['1','2']],['running',['4']],['queued',['3','7']],['draft',['6']],['completed',['0','5']]]);
 assert.equal(new Set(groups.flatMap(g=>g.cards.map(c=>c.id))).size,cards.length);
 assert.deepEqual(groupWidgetCards([]),[]);
});

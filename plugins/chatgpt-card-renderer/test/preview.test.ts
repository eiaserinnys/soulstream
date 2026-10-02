import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCards} from '../src/card-data.ts';

test('projects only a bounded text preview from latest activity, not source history',()=>{
 const result=projectCards({cards:[{id:'a',title:'A',status:'review',latestActivity:{kind:'report',format:'html',body:'<p>첫 &amp; 보고</p><script>secret()</script><p>'+ '한'.repeat(600)+'</p>',createdAt:'private time'},request:'private request',reports:['private history']}]});
 const card=result.cards[0] as any;
 assert.equal(card.preview.kind,'report');assert.equal(card.preview.text.length,500);
 assert.match(card.preview.text,/^첫 & 보고\n/);assert.doesNotMatch(card.preview.text,/secret|<p>/);
 assert.deepEqual(Object.keys(card).sort(),['assignee','id','preview','status','title','updatedAt'].sort());
});
test('markdown is plain text, user instructions stay instructions, and missing activity stays absent',()=>{
 const result=projectCards({cards:[{id:'a',title:'A',status:'blocked',latest_activity:{kind:'user_comment',format:'markdown',body:'# 제목\n\n**실제 지시** [문서](https://example.test)'}},{id:'b',title:'B',status:'todo',latestActivity:null}]});
 assert.deepEqual((result.cards[0] as any).preview,{kind:'instruction',text:'제목\n\n실제 지시 문서'});
 assert.equal('preview' in result.cards[1]!,false);
});

import { placeTurnSummaries } from '../turnSummaryProjection';
import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem } from '../groupChatEvents';
const observation = (id: string, complete: number, anchor: number): SessionEvent => ({ id, type:'debug', data:{kind:'jev_card_observation',complete_event_id:complete,final_response_event_id:anchor,phase:'result',content:'Jev · 위임 대기',details:['고정 분류 설명입니다.']} });
const base: ChatRenderItem[] = [9,19].map(id=>({kind:'event',event:{id:String(id),type:'assistant_message',data:{content:'응답'}},key:`answer${id}`}));
it('attaches late results to their own answer and coexists with summary on iPhone/iPad renderer',()=>{
 const result=placeTurnSummaries(base,[observation('40',10,9),{id:'30',type:'turn_summary',data:{content:'요약',final_response_event_id:9}},observation('35',20,19)]);
 expect(result).toHaveLength(2);
 expect((result[0] as any).summaries.map((s:any)=>s.content)).toEqual(['요약','Jev · 위임 대기']);
 expect((result[1] as any).summaries).toHaveLength(1);
});
it('hides snapshots and superseded reservations, and restores the same anchors after reload',()=>{
 const events=[observation('25',10,9),observation('40',10,9),{id:'24',type:'debug',data:{kind:'assigned_card_context_snapshot'}} as SessionEvent];
 const before=placeTurnSummaries(base,events);
 const reload=placeTurnSummaries(JSON.parse(JSON.stringify(base)),JSON.parse(JSON.stringify(events)));
 expect(before).toEqual(reload);
 expect((before[0] as any).summaries.map((s:any)=>s.event.id)).toEqual(['40']);
});

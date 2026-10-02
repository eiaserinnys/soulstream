import { formatAssignedCardContextSnapshot, placeTurnSummaries } from '../turnSummaryProjection';
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
it('anchors the latest prepared card snapshot to its exact input after late arrival and reload',()=>{
 const input: SessionEvent={id:'5',type:'user_message',data:{text:'시작',input_id:'initial-input'}};
 const snapshot=(id:string,inputId:unknown):SessionEvent=>({id,type:'debug',data:{kind:'assigned_card_context_snapshot',content:'담당 카드 입력 준비\n지시: 저장된 장황한 본문',capture:{source:'prepared_model_input',registrationId:'r',executionCommandId:'e',inputId,identityMissing:false,snapshot:{capturedAt:'2026-10-02T01:00:00Z',cards:[{id:'old',title:'과거 카드',status:'queued',version:7,instruction:'저장된 장황한 본문',report:'저장된 장황한 보고'}]}}}});
 const inputBase: ChatRenderItem[]=[{kind:'event',event:input,key:'input5'},...base];
 const events=[input,observation('25',10,9),observation('40',10,9),snapshot('41','initial-input'),snapshot('42','initial-input'),snapshot('43',null),snapshot('44','unloaded')];
 const before=placeTurnSummaries(inputBase,events);
 const reload=placeTurnSummaries(JSON.parse(JSON.stringify(inputBase)),JSON.parse(JSON.stringify(events)));
 expect(before).toEqual(reload);
 expect((before[0] as any).summaries.map((s:any)=>s.event.id)).toEqual(['42']);
 expect((before[0] as any).summaries[0].content).toBe('old · 과거 카드 · 대기 · 마지막 보고 시각 확인 불가');
 expect((before[1] as any).summaries.map((s:any)=>s.event.id)).toEqual(['40']);
});
it('projects compact and legacy card snapshots with captured-time-relative report labels',()=>{
 expect(formatAssignedCardContextSnapshot({capturedAt:'2026-10-02T01:00:00Z',cards:[
  {id:'a',title:'첫 카드',status:'running',latestCommentAt:'2026-10-02T00:30:00Z',latestReportAt:'2026-10-02T00:20:00Z'},
  {id:'b',title:'둘째 카드',status:'review',latestCommentAt:null,latestReportAt:null},
 ]})).toBe('a · 첫 카드 · 실행 중 · 마지막 보고 40분 전 · 최근 커멘트 이후 보고 없음\nb · 둘째 카드 · 검수 대기 · 보고 없음');
 expect(formatAssignedCardContextSnapshot({capturedAt:'2026-10-02T01:00:00Z',cards:[
  {id:'old',title:'과거 카드',status:'queued',version:7,instruction:'긴 지시',report:'긴 보고'},
 ]})).toBe('old · 과거 카드 · 대기 · 마지막 보고 시각 확인 불가');
});

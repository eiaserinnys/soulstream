import { formatAssignedCardContextSnapshot, placeTurnSummaries } from '../turnSummaryProjection';
import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem } from '../groupChatEvents';
const base: ChatRenderItem[] = [9,19].map(id=>({kind:'event',event:{id:String(id),type:'assistant_message',data:{content:'응답'}},key:`answer${id}`}));
it('anchors the latest prepared card snapshot to its exact input after late arrival and reload',()=>{
 const input: SessionEvent={id:'5',type:'user_message',data:{text:'시작',input_id:'initial-input'}};
 const snapshot=(id:string,inputId:unknown):SessionEvent=>({id,type:'debug',data:{kind:'assigned_card_context_snapshot',content:'담당 카드 입력 준비\n지시: 저장된 장황한 본문',capture:{source:'prepared_model_input',registrationId:'r',executionCommandId:'e',inputId,identityMissing:false,snapshot:{capturedAt:'2026-10-02T01:00:00Z',cards:[{id:'old',title:'과거 카드',status:'queued',version:7,instruction:'저장된 장황한 본문',report:'저장된 장황한 보고'}]}}}});
 const inputBase: ChatRenderItem[]=[{kind:'event',event:input,key:'input5'},...base];
 const events=[input,snapshot('41','initial-input'),snapshot('42','initial-input'),snapshot('43',null),snapshot('44','unloaded')];
 const before=placeTurnSummaries(inputBase,events);
 const reload=placeTurnSummaries(JSON.parse(JSON.stringify(inputBase)),JSON.parse(JSON.stringify(events)));
 expect(before).toEqual(reload);
 expect(before.map(item=>item.kind)).toEqual(['event','turn-summary','event','event']);
 expect(before[1]).toMatchObject({
  kind:'turn-summary',
  key:'turn-summary-42',
  content:'과거 카드 · 대기 · 마지막 보고 시각 확인 불가',
 });
 expect((before[0] as any).summaries).toBeUndefined();
 expect((before[2] as any).summaries).toBeUndefined();
});
it('projects compact and legacy card snapshots with captured-time-relative report labels',()=>{
 expect(formatAssignedCardContextSnapshot({capturedAt:'2026-10-02T01:00:00Z',cards:[
  {id:'a',title:'첫 카드',status:'running',latestCommentAt:'2026-10-02T00:30:00Z',latestReportAt:'2026-10-02T00:20:00Z'},
  {id:'b',title:'둘째 카드',status:'review',latestCommentAt:null,latestReportAt:null},
 ]})).toBe('첫 카드 · 실행 중 · 마지막 보고 40분 전 · 최근 커멘트 이후 보고 없음\n둘째 카드 · 검수 대기 · 보고 없음');
 expect(formatAssignedCardContextSnapshot({capturedAt:'2026-10-02T01:00:00Z',cards:[
  {id:'old',title:'과거 카드',status:'queued',version:7,instruction:'긴 지시',report:'긴 보고'},
 ]})).toBe('과거 카드 · 대기 · 마지막 보고 시각 확인 불가');
});

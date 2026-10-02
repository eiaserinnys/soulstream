import { describe, expect, it } from 'vitest';
import { placeTurnSummariesAtResponseAnchors } from './turn-summary-projection';
import { createNodeFromEvent } from '../stores/node-factory';
import { buildLlmHistory } from '../components/chat/buildLlmHistory';
import type { SoulSSEEvent, EventTreeNode } from '../shared/types';
const observation = { type:'debug',kind:'jev_card_observation',complete_event_id:10,final_response_event_id:9,phase:'result',content:'Jev · 위임 대기 — 다른 작업 결과를 기다리는 상태로 분류',details:['고정 분류 설명입니다.'],timestamp:1 };
it('turn observation and ordinary summary coexist at the old response, even after another turn', () => {
 const items = [ {treeNodeId:'answer9',treeNodeType:'assistant_message',eventId:9}, {treeNodeId:'answer19',treeNodeType:'assistant_message',eventId:19},
 {treeNodeId:'summary',treeNodeType:'turn_summary',eventId:30,summaryFinalResponseEventId:9},
 {treeNodeId:'observation',treeNodeType:'card_observation',eventId:40,summaryFinalResponseEventId:9} ];
 expect(placeTurnSummariesAtResponseAnchors(items).map(i=>i.treeNodeId)).toEqual(['answer9','summary','observation','answer19']);
});
it('durable debug observations become typed chat nodes without entering model history', () => {
 const node = createNodeFromEvent(observation as SoulSSEEvent,40);
 expect(node?.type).toBe('card_observation');
 const input = createNodeFromEvent({type:'user_message',text:'외부 카드 알림',input_id:'input-1'} as SoulSSEEvent,39);
 const snapshot = createNodeFromEvent({type:'debug',kind:'assigned_card_context_snapshot',content:'담당 카드 입력 준비\n지시: 저장된 장황한 본문',timestamp:1,capture:{source:'prepared_model_input',sessionId:'s',registrationId:'r',executionCommandId:'e',inputId:'input-1',identityMissing:false,snapshot:{total:1,omitted:0,capturedAt:'2026-10-02T00:00:00Z',cards:[{id:'old',title:'과거 카드',status:'queued',version:7,instruction:'저장된 장황한 본문',report:'저장된 장황한 보고'}]}}} as unknown as SoulSSEEvent,41);
 expect(snapshot?.type).toBe('assigned_card_context');
 expect(snapshot?.content).toBe('과거 카드 · 대기 · 마지막 보고 시각 확인 불가');
 const invalid = createNodeFromEvent({type:'debug',kind:'assigned_card_context_snapshot',content:'숨김',timestamp:1,capture:{source:'prepared_model_input',sessionId:'s',registrationId:null,executionCommandId:'e',inputId:null,identityMissing:true,snapshot:{total:0,omitted:0,capturedAt:'2026-10-02T00:00:00Z',cards:[]}}} as unknown as SoulSSEEvent,42);
 expect(invalid).toBeNull();
 const root={id:'root',type:'session',children:[input!,node!,snapshot!],content:'',completed:false} as EventTreeNode;
 expect(buildLlmHistory(root)).toEqual([{role:'user',content:'외부 카드 알림'}]);
});

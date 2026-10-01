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
it('durable debug observation becomes a separate node; hidden snapshots do not become chat', () => {
 const node = createNodeFromEvent(observation as SoulSSEEvent,40);
 expect(node?.type).toBe('card_observation');
 const hidden = createNodeFromEvent({type:'debug',kind:'assigned_card_context_snapshot'} as unknown as SoulSSEEvent,41);
 expect(hidden).toBeNull();
 const root={id:'root',type:'session',children:[node!],content:'',completed:false} as EventTreeNode;
 expect(buildLlmHistory(root)).toEqual([]);
});

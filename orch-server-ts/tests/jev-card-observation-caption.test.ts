import { expect,it } from 'vitest';
import { observationPayload } from '../src/cards/jev_card_observation_caption.js';
import { buildObservationInput } from '../src/cards/jev_card_observation.js';
const input=buildObservationInput({completeEventId:10,cards:[],history:[],summaries:[],startObservations:[],totalCards:0});
const job={nodeId:'n',sessionId:'s',completeEventId:10,previousCompleteEventId:1,finalResponseEventId:9,capturedAt:'now'};
it('shows the provider completion choice with scope limit, confidence only in stored details',()=>{
  const result=observationPayload(job,input,{status:'evaluated',calls:1,latencyMs:5,inputBytes:20,cards:[{cardId:'a',title:'작업',storedStatus:'blocked',version:3,classification:'unknown',providerChoice:'ready_for_review',completionWithheld:true,confidence:0.9}]});
  expect(result.content).toBe('Jev · 완료 가능 · 관측 범위 제한');
  expect(result.content).not.toContain('0.9');
  expect(result.details.join('\n')).toContain('provider confidence 0.9 (정확도 아님)');
  expect(result.details.join('\n')).toContain('저장 상태 blocked');
});
it('separates provider unknown from missing or invalid output',()=>{
  const failed=observationPayload(job,input,{status:'not_evaluated',reason:'invalid_response',calls:1,latencyMs:1,inputBytes:4,cards:[]});
  expect(failed.content).toBe('Jev · 미평가 — 유효한 분류 결과가 없음');
  const unknown=observationPayload(job,input,{status:'evaluated',calls:1,latencyMs:1,inputBytes:4,cards:[{cardId:'a',title:'작업',storedStatus:'running',version:1,classification:'unknown',providerChoice:'unknown'}]});
  expect(unknown.content).toContain('판단 불가');
  expect(unknown.content).not.toContain('미평가');
});

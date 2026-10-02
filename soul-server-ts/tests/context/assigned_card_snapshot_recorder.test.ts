import { expect,it,vi } from 'vitest';
import { createAssignedCardSnapshotRecorder } from '../../src/context/assigned_card_snapshot_recorder.js';
import type { AssignedCardContextCapture } from '../../src/context/assigned_card_context.js';
const capture=():AssignedCardContextCapture=>({source:'prepared_model_input',sessionId:'s',registrationId:'r',executionCommandId:'e',inputId:'i',snapshot:{total:14,omitted:2,capturedAt:'2026-10-02T00:00:00Z',cards:Array.from({length:14},(_,i)=>({id:String(i),title:'제목',status:'running',version:2,instruction:'지시',report:'보고'}))}});
it('owns a bounded immutable copy, preserves identity and returns without ACK',async()=>{
  const enqueueEvent=vi.fn((..._args:unknown[])=>new Promise<never>(()=>{}));
  const record=createAssignedCardSnapshotRecorder({enqueueEvent} as any,{warn:vi.fn()});
  const raw=capture();
  await record(raw);
  raw.snapshot.cards[0]!.title='나중 변경';
  const event=enqueueEvent.mock.calls[0]![1] as any;
  expect(event.capture.snapshot.cards).toHaveLength(12);
  expect(event.capture.snapshot.cards[0].title).toBe('제목');
  expect(event.capture.snapshot.omitted).toBe(2);
  expect(event._dedupe_key).toBe('assigned_card_context_snapshot:r:i');
  expect(event.capture.source).toBe('prepared_model_input');
});
it('contains storage failure without retries or input wakeups and marks missing identity',async()=>{
  const enqueueEvent=vi.fn(async(..._args:unknown[])=>{throw new Error('storage failure');});
  const warn=vi.fn();
  const raw=capture(); raw.inputId=null;
  await createAssignedCardSnapshotRecorder({enqueueEvent} as any,{warn})(raw);
  await Promise.resolve();
  expect(enqueueEvent).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect((enqueueEvent.mock.calls[0]![1] as any).capture.identityMissing).toBe(true);
});

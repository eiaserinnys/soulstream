/** @vitest-environment jsdom */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PersistentReportProvider, usePersistentReport } from './PersistentReportProvider';
import { useDashboardStore } from '../../stores/dashboard-store';
import { reportMessageContext, selectReportKey } from '../../shared/persistent-report';
import type { PersistentReportEntry } from '../../shared/session-types';
import type { PendingChatSend } from '../../stores/dashboard-store-types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const one: PersistentReportEntry = { key: 'one', kind: 'ask', title: '확인', card_numbers: [270], context: '맥락', action: '진행할까?', options: ['응'], state: 'open', answer: '', updated_at: 'first' };
const two = { ...one, key: 'two', title: '둘째' };
const three = { ...one, key: 'three', kind: 'see' as const, options: [] };
let root: Root; let host: HTMLDivElement;
let controller: NonNullable<ReturnType<typeof usePersistentReport>>;
let mounts = 0;
function Probe() { controller = usePersistentReport()!; useEffect(() => { mounts++; }, []); return <input defaultValue="초안" />; }
const render = (entries: PersistentReportEntry[], sessionId = 'a') => act(async () => root.render(<PersistentReportProvider sessionId={sessionId} entries={entries}><Probe /></PersistentReportProvider>));
beforeEach(() => { useDashboardStore.getState().reset(); mounts = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('keeps selection when sheets before it leave or new sheets enter, choosing the next then previous when it leaves', () => {
  expect(selectReportKey([one, two, three], [two, three], 'two')).toBe('two');
  expect(selectReportKey([one, two], [one, two, three], 'two')).toBe('two');
  expect(selectReportKey([one, two, three], [one, three], 'two')).toBe('three');
  expect(selectReportKey([one, two], [one], 'two')).toBe('one');
  expect(selectReportKey([one], [], 'one')).toBeNull();
});
it('keeps the input mounted while selection, entries and session scope reset', async () => {
  await render([one, two]); const input = host.querySelector('input');
  await act(async () => controller.view('two'));
  await render([two]); expect(controller.visibleKey).toBe('two');
  await render([one], 'b'); expect(controller.visibleKey).toBe('one');
  expect(host.querySelector('input')).toBe(input); expect(mounts).toBe(1);
});
it('binds only the exact whole message; undo, editing and a session change release it', async () => {
  const entries = [one, two]; await render(entries);
  await act(async () => controller.bindReply(one, '응'));
  expect(controller.getMessageContext('  확인: 응\n').contextItems?.[0]).toEqual({ key: 'persistent_report_reply', content: { key: 'one', option: '응' } });
  for (const text of ['확인: 응 대신 보류합니다', '초안\n\n확인: 응', '확인: 응\n추가 글']) {
    expect(controller.getMessageContext(text).contextItems?.[0]?.key).toBe('persistent_report_visible');
  }
  await act(async () => controller.draftChanged('확인: 응 추가'));
  expect(controller.getMessageContext('확인: 응').contextItems?.[0]?.key).toBe('persistent_report_visible');
  await act(async () => controller.bindReply(one, '응'));
  await act(async () => controller.draftChanged('확인: 수정'));
  expect(controller.getMessageContext('확인: 응').contextItems?.[0]?.key).toBe('persistent_report_visible');
  await act(async () => { controller.bindReply(one, '응'); });
  await act(async () => controller.clearReply());
  expect(controller.getMessageContext('확인: 응').contextItems?.[0]?.key).toBe('persistent_report_visible');
  await act(async () => controller.bindReply(one, '응'));
  await render(entries, 'b');
  expect(controller.getMessageContext('확인: 응').contextItems?.[0]?.key).toBe('persistent_report_visible');
});
it('projects only the visible sheet for a freely written message and nothing for an empty board', () => {
  expect(reportMessageContext([one, two], 'two', null, '직접 쓴 답')).toEqual({ contextItems: [{ key: 'persistent_report_visible', content: { key: 'two', title: '둘째' } }] });
  expect(reportMessageContext([], null, null, '직접 쓴 답')).toEqual({});
});
it('answers immediately, rolls back on failure, retries, retains a delivered answer until the server replaces it', async () => {
  const entries = [one, two]; await render(entries);
  const pending: PendingChatSend = { id: 'send-a', status: 'sending', text: '확인: 응', messageText: '확인: 응', attachmentPaths: [], attachments: [], mode: 'intervention', ...reportMessageContext(entries, 'one', { key: 'one', option: '응', line: '확인: 응' }, '확인: 응') };
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', pending));
  expect(controller.answer(one)).toBe('응'); expect(controller.answer(two)).toBeUndefined();
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { ...pending, status: 'failed' }));
  expect(controller.answer(one)).toBeUndefined();
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { ...pending }));
  expect(controller.answer(one)).toBe('응');
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', null));
  expect(controller.answer(one)).toBe('응');
  const reopened = { ...one, updated_at: 'new', title: '다시 연 장' };
  await render([reopened, two]); expect(controller.answer(reopened)).toBeUndefined();
  const confirmed = { ...one, state: 'answered' as const, answer: '서버 답', updated_at: 'confirmed' };
  await render([confirmed, two]); expect(controller.answer(confirmed)).toBe('서버 답');
});

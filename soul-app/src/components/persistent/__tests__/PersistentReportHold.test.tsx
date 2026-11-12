import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PersistentReportEntry } from '../../../api/types';
import { usePersistentReport } from '../usePersistentReport';
import { usePersistentReportSend } from '../usePersistentReportSend';
import { CARD_QUESTION_ANSWERED_REASON } from '../../chat/useChatSendFlow';
import { useChatStore } from '../../../store/chatStore';
import { useSessionStore } from '../../../store/sessionStore';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'question-operation-id') }));

const question = (): PersistentReportEntry => ({
  key: 'cq_q1', question_id: 'q1', kind: 'ask', title: '비밀값을 옮길까요', card_numbers: [1197],
  context: '실행 명령에 비밀값이 그대로 적힙니다.', action: '', options: ['파일로 옮기기', '그대로 두기'],
  state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z', card_id: 'card-1', card_status: 'blocked',
});
const sibling = (): PersistentReportEntry => ({
  key: 'result', kind: 'see', title: '결과 보기', card_numbers: [], context: '구현을 마쳤습니다.',
  action: '', options: [], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z',
});
const newSameCard = (): PersistentReportEntry => ({
  key: 'card_card-1', kind: 'see', title: '같은 카드의 새 장', card_numbers: [1197], context: '카드 상태가 바뀌었습니다.',
  action: '', options: [], state: 'open', answer: '', updated_at: '2026-10-13T00:05:00Z',
  card_id: 'card-1', card_status: 'blocked',
});

function acknowledgementApi() {
  return {
    intervene: jest.fn(async () => ({ delivered: true, outcome: 'delivered', reason: CARD_QUESTION_ANSWERED_REASON })),
  } as unknown as ApiClient;
}
function useStack(api: ApiClient, sessionId = 'pas') {
  const report = usePersistentReport(sessionId, true, api, undefined, undefined);
  const send = usePersistentReportSend(sessionId, api, report.entries, report.server, 'completed', jest.fn(),
    (entry, option) => report.holdAnswered(entry, option));
  return { report, send };
}
async function answer(hook: { result: { current: ReturnType<typeof useStack> } }) {
  const entry = hook.result.current.report.entries.find(item => item.key === 'cq_q1')!;
  await act(async () => { await hook.result.current.send.sendOption(entry, '파일로 옮기기'); });
}
beforeEach(() => {
  useSessionStore.setState({ persistentReportsBySession: {} });
  useChatStore.setState({ pendingOptimisticBySession: {}, eventsBySession: {} });
});

test('판 교체로 cq_ 장이 빠져도 보낸 답은 같은 자리에 답 받음으로 남는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const api = acknowledgementApi();
  const hook = renderHook(() => useStack(api));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['cq_q1', 'result']);

  await answer(hook);
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));

  const entries = hook.result.current.report.entries;
  expect(entries.map(entry => entry.key)).toEqual(['cq_q1', 'result']);
  expect(entries[0]).toMatchObject({ state: 'answered', answer: '파일로 옮기기' });
});

test('다른 장으로 넘기면 붙든 장을 놓는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(() => useStack(acknowledgementApi()));
  await answer(hook);
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['cq_q1', 'result']);

  act(() => hook.result.current.report.select(1));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['result']);
});

test('같은 카드의 새 장이 판에 올라오면 붙든 장을 놓는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(() => useStack(acknowledgementApi()));
  await answer(hook);
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['cq_q1', 'result']);

  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling(), newSameCard()]));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['result', 'card_card-1']);
});

test('세션을 바꾸면 붙든 장을 놓는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(({ sessionId }: { sessionId: string }) => useStack(acknowledgementApi(), sessionId),
    { initialProps: { sessionId: 'pas' } });
  await answer(hook);
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['cq_q1', 'result']);

  hook.rerender({ sessionId: 'pas-2' });
  expect(hook.result.current.report.entries).toEqual([]);
});

test('답을 보내지 못하면 붙들지 않는다', async () => {
  const api = { intervene: jest.fn(async () => { throw Error('전달 실패'); }) } as unknown as ApiClient;
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(() => useStack(api));
  await answer(hook);
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(entry => entry.key)).toEqual(['result']);
});

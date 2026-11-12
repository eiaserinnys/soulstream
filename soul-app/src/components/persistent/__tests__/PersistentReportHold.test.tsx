import React from 'react';
import { Text, View } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PersistentReportEntry } from '../../../api/types';
import { usePersistentReport } from '../usePersistentReport';
import { usePersistentReportSend } from '../usePersistentReportSend';
import { CARD_QUESTION_ANSWERED_REASON } from '../../chat/useChatSendFlow';
import { answerCardQuestionChoice, cardQuestionTargetText, setCardQuestionTarget,
  useCardQuestionTarget, useCardQuestionTargetLifetime } from '../../planner/CardQuestionBlock';
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
  const send = usePersistentReportSend(sessionId, api, report.entries, report.server, 'completed', jest.fn(), {
    begin: report.beginAnsweredHold, confirm: report.holdAnswered, release: report.releaseAnsweredHold });
  return { report, send };
}
async function answer(hook: { result: { current: ReturnType<typeof useStack> } }) {
  const entry = hook.result.current.report.entries.find(item => item.key === 'cq_q1')!;
  await act(async () => { await hook.result.current.send.sendOption(entry, '파일로 옮기기'); });
}
/** 펼친 장과 같은 조건: 판에 그 장이 있는 동안만 펼친 영역(대상 수명)이 산다. */
function QuestionTargetProbe({ targetKey }: { targetKey: string }) {
  useCardQuestionTargetLifetime(targetKey);
  const { target } = useCardQuestionTarget(targetKey);
  return <Text testID="question-target">{target ? cardQuestionTargetText(target) : ''}</Text>;
}
function ExpandedFrame({ api, stack }: { api: ApiClient; stack: { current: ReturnType<typeof useStack> | null } }) {
  const current = useStack(api);
  stack.current = current;
  const expansion = current.report.entries.some(entry => entry.key === 'cq_q1');
  return <View>
    <Text testID="shown-keys">{current.report.entries.map(entry => entry.key).join(',')}</Text>
    {expansion ? <QuestionTargetProbe targetKey="card-1" /> : null}
  </View>;
}
beforeEach(() => {
  useSessionStore.setState({ persistentReportsBySession: {} });
  useChatStore.setState({ pendingOptimisticBySession: {}, eventsBySession: {} });
  setCardQuestionTarget('card-1', null);
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

test('펼친 장의 선택 저장이 성공하면 판 교체로 cq_ 장이 빠져도 같은 자리에 답 받음으로 남는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(() => useStack(acknowledgementApi()));
  const entry = hook.result.current.report.entries.find(item => item.key === 'cq_q1')!;
  act(() => hook.result.current.report.beginAnsweredHold(entry, '파일로 옮기기'));
  let saved!: Promise<boolean>;
  act(() => { saved = answerCardQuestionChoice('card-1', 'q1', '파일로 옮기기', async () => true); });
  await act(async () => { expect(await saved).toBe(true); });
  act(() => hook.result.current.report.holdAnswered(entry, '파일로 옮기기'));
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  const entries = hook.result.current.report.entries;
  expect(entries.map(item => item.key)).toEqual(['cq_q1', 'result']);
  expect(entries[0]).toMatchObject({ state: 'answered', answer: '파일로 옮기기' });
});

test('운영 순서: 접힌 장 판 답, 판 갱신이 ACK보다 먼저 와도 보던 장이 그 자리에 남는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  let finish!: (value: unknown) => void;
  const gate = new Promise(resolve => { finish = resolve; });
  const api = { intervene: jest.fn(() => gate) } as unknown as ApiClient;
  const hook = renderHook(() => useStack(api));
  const entry = hook.result.current.report.entries[0];
  let request!: Promise<void>;
  act(() => { request = hook.result.current.send.sendOption(entry, '파일로 옮기기') as unknown as Promise<void>; });
  // 서버 afterCommit의 syncCard 방송이 판 답 ACK 응답보다 먼저 클라이언트에 닿는다.
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(item => item.key)).toEqual(['cq_q1', 'result']);
  expect(hook.result.current.report.index).toBe(0);
  expect(hook.result.current.report.entries[0]).toMatchObject({ state: 'answered', answer: '파일로 옮기기' });

  await act(async () => { finish({ delivered: true, outcome: 'delivered', reason: CARD_QUESTION_ANSWERED_REASON }); await request; });
  expect(hook.result.current.report.entries.map(item => item.key)).toEqual(['cq_q1', 'result']);
  expect(hook.result.current.report.index).toBe(0);
  expect(hook.result.current.report.entries[0]).toMatchObject({ state: 'answered', answer: '파일로 옮기기' });
});

test('운영 순서: 펼친 장 REST 선택, 판 갱신이 응답보다 먼저 와도 펼친 영역이 내려가지 않고 덧붙이기 대상이 선다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const stack: { current: ReturnType<typeof useStack> | null } = { current: null };
  const screen = render(<ExpandedFrame api={{} as ApiClient} stack={stack} />);
  const entry = stack.current!.report.entries[0];
  let finish!: (saved: boolean) => void;
  const saving = new Promise<boolean>(resolve => { finish = resolve; });
  act(() => stack.current!.report.beginAnsweredHold(entry, '파일로 옮기기'));
  // 서버 판 재계산 SSE가 REST 선택 응답보다 먼저 닿는다.
  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(screen.getByTestId('shown-keys').props.children).toBe('cq_q1,result');
  // 펼친 영역(대상 수명)이 내려가지 않았다.
  expect(screen.queryByTestId('question-target')).not.toBeNull();

  let saved!: Promise<boolean>;
  act(() => { saved = answerCardQuestionChoice('card-1', 'q1', '파일로 옮기기', () => saving); });
  await act(async () => { finish(true); expect(await saved).toBe(true); });
  act(() => stack.current!.report.holdAnswered(entry, '파일로 옮기기'));

  expect(screen.getByTestId('question-target').props.children).toBe('덧붙이기: 파일로 옮기기');
  expect(screen.getByTestId('shown-keys').props.children).toBe('cq_q1,result');
  expect(stack.current!.report.entries[0]).toMatchObject({ state: 'answered', answer: '파일로 옮기기' });
});

test('갱신이 먼저 오지 않은 채 저장이 실패하면 잠정 붙들기를 놓고 장은 판 재계산대로 남는다', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
  const hook = renderHook(() => useStack({} as ApiClient));
  const entry = hook.result.current.report.entries.find(item => item.key === 'cq_q1')!;
  act(() => hook.result.current.report.beginAnsweredHold(entry, '파일로 옮기기'));
  expect(await answerCardQuestionChoice('card-1', 'q1', '파일로 옮기기', async () => false)).toBe(false);
  act(() => hook.result.current.report.releaseAnsweredHold(entry));
  expect(hook.result.current.report.entries.map(item => item.key)).toEqual(['cq_q1', 'result']);

  act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
  expect(hook.result.current.report.entries.map(item => item.key)).toEqual(['result']);
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

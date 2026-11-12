import React from 'react';
import { TextInput } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';
import { CardCommentComposer } from '../CardCommentComposer';
import {
  answerCardQuestionChoice, consumeCardQuestionFocus, setCardQuestionTarget,
  useCardQuestionTarget, useCardQuestionTargetLifetime,
} from '../CardQuestionBlock';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useDraftStore } from '../../../store/draftStore';

beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useDraftStore.setState({ drafts: {} });
});

afterEach(() => jest.restoreAllMocks());

function renderComposer(props: { questionTargetKey?: string; focusRequest?: number } = {}) {
  return render(
    <CardCommentComposer api={null} cardId="card-composer" cardLoaded locked={false} sending={false}
      onBusyChange={jest.fn()} sendComment={async () => true}
      runMutation={async () => true} {...props} />,
  );
}

test('선택 저장이 실패하면 덧붙이기 대상이 서지 않는다', async () => {
  const target = renderHook(() => useCardQuestionTarget('card-fail'));
  let saved!: boolean;
  await act(async () => {
    saved = await answerCardQuestionChoice('card-fail', 'q1', '파일로 옮기기', async () => false);
  });
  expect(saved).toBe(false);
  expect(target.result.current).toEqual({ target: null, focus: 0 });
});

test('선택 저장이 성공한 뒤에만 덧붙이기 대상이 선다', async () => {
  const target = renderHook(() => useCardQuestionTarget('card-ok'));
  let finish!: (saved: boolean) => void;
  const gate = new Promise<boolean>(resolve => { finish = resolve; });
  let request!: Promise<boolean>;
  act(() => { request = answerCardQuestionChoice('card-ok', 'q1', '파일로 옮기기', () => gate); });
  expect(target.result.current.target).toBeNull();
  await act(async () => { finish(true); expect(await request).toBe(true); });
  expect(target.result.current.target).toEqual({ kind: 'append', questionId: 'q1', label: '파일로 옮기기' });
});

test('저장을 기다리는 동안 화면이 내려가면 늦은 성공이 대상을 되살리지 않는다', async () => {
  const target = renderHook(() => useCardQuestionTarget('card-late'));
  const lifetime = renderHook(() => useCardQuestionTargetLifetime('card-late'));
  let finish!: (saved: boolean) => void;
  const gate = new Promise<boolean>(resolve => { finish = resolve; });
  let request!: Promise<boolean>;
  act(() => { request = answerCardQuestionChoice('card-late', 'q1', '파일로 옮기기', () => gate); });
  act(() => lifetime.unmount());
  await act(async () => { finish(true); expect(await request).toBe(true); });
  expect(target.result.current).toEqual({ target: null, focus: 0 });
});

test('카드를 바꾸거나 화면이 내려가면 대상과 초점 요청이 지워진다', () => {
  const a = renderHook(() => useCardQuestionTarget('card-a'));
  const lifetime = renderHook(({ id }: { id: string }) => useCardQuestionTargetLifetime(id),
    { initialProps: { id: 'card-a' } });
  act(() => setCardQuestionTarget('card-a', { kind: 'ask', questionId: 'q1' }, true));
  expect(a.result.current).toEqual({ target: { kind: 'ask', questionId: 'q1' }, focus: 1 });

  lifetime.rerender({ id: 'card-b' });
  expect(a.result.current).toEqual({ target: null, focus: 0 });

  act(() => setCardQuestionTarget('card-b', { kind: 'ask', questionId: 'q2' }, true));
  const b = renderHook(() => useCardQuestionTarget('card-b'));
  expect(b.result.current.focus).toBe(1);
  lifetime.unmount();
  expect(b.result.current).toEqual({ target: null, focus: 0 });
});

test('초점 요청은 한 번 따르면 사라지고 대상은 남는다', () => {
  const target = renderHook(() => useCardQuestionTarget('card-focus'));
  act(() => setCardQuestionTarget('card-focus', { kind: 'ask', questionId: 'q1' }, true));
  let consumed = false;
  act(() => { consumed = consumeCardQuestionFocus('card-focus'); });
  expect(consumed).toBe(true);
  expect(target.result.current).toEqual({ target: { kind: 'ask', questionId: 'q1' }, focus: 0 });
  expect(consumeCardQuestionFocus('card-focus')).toBe(false);
});

test('되묻기 뒤 다시 마운트한 입력창은 이미 따른 초점 요청을 잡지 않는다', () => {
  const focus = jest.spyOn(TextInput.prototype as unknown as { focus: () => void }, 'focus');
  focus.mockClear();
  const target = renderHook(() => useCardQuestionTarget('card-remount'));
  act(() => setCardQuestionTarget('card-remount', { kind: 'ask', questionId: 'q1' }, true));

  const first = renderComposer({ questionTargetKey: 'card-remount', focusRequest: 1 });
  expect(focus).toHaveBeenCalledTimes(1);
  expect(target.result.current.focus).toBe(0);
  first.unmount();

  // A remount that still sees the old counter value must not follow it again.
  const second = renderComposer({ questionTargetKey: 'card-remount', focusRequest: 1 });
  expect(focus).toHaveBeenCalledTimes(1);
  second.unmount();

  const fresh = renderComposer({ questionTargetKey: 'card-remount', focusRequest: 0 });
  expect(focus).toHaveBeenCalledTimes(1);
  fresh.unmount();
});

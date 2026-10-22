import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { act, render, renderHook } from '@testing-library/react-native';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useDraftStore } from '../../store/draftStore';
import { LayoutContinuityProvider } from '../../navigation/LayoutContinuityContext';
import { usePersistentDraft } from '../usePersistentDraft';

const jwt = (email: string, exp = 9999999999) => `header.${Buffer.from(JSON.stringify({ email, sub: email, exp })).toString('base64url')}.signature`;
beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: jwt('one@example.com') });
  useSettingsStore.setState({ serverUrl: 'https://one.example' });
  useDraftStore.setState({ drafts: {} });
});

test('app restart restores edited draft and token refresh keeps the stable user key', async () => {
  const first = renderHook(() => usePersistentDraft('card-comment', ['card-1'], ''));
  act(() => first.result.current.setValue('작성 중'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = await AsyncStorage.getItem('soul-app-drafts');
  first.unmount();
  useDraftStore.setState({ drafts: {} });
  await AsyncStorage.setItem('soul-app-drafts', saved!);
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: jwt('one@example.com', 9999999998) });
  const next = renderHook(() => usePersistentDraft('card-comment', ['card-1'], ''));
  expect(next.result.current.value).toBe('작성 중');
  expect(saved).not.toContain('signature');
  expect(saved).not.toContain('auth-scope');
});

test('server, user, role and target isolate long text drafts', () => {
  const view = renderHook(({ target }: { target: string }) => usePersistentDraft('card-request', [target], ''), { initialProps: { target: 'all' } });
  act(() => view.result.current.setValue('요청 본문'));
  view.rerender({ target: 'folder' });
  expect(view.result.current.value).toBe('');
  view.rerender({ target: 'all' });
  expect(view.result.current.value).toBe('요청 본문');
  act(() => { useSettingsStore.setState({ serverUrl: 'https://two.example' }); });
  expect(view.result.current.value).toBe('');
  act(() => { useSettingsStore.setState({ serverUrl: 'https://one.example' }); });
  act(() => { useAuthStore.setState({ jwt: jwt('two@example.com') }); });
  expect(view.result.current.value).toBe('');
  act(() => { useAuthStore.setState({ jwt: jwt('one@example.com') }); });
  expect(view.result.current.value).toBe('요청 본문');
  const other = renderHook(() => usePersistentDraft('card-comment', ['all'], ''));
  expect(other.result.current.value).toBe('');
});

test('successful submitted value clears only its own unchanged draft; failure and close keep it', () => {
  const first = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  act(() => first.result.current.setValue('전송 원문'));
  const confirmed = first.result.current.clearIfMatches;
  act(() => first.result.current.setValue('다음 메시지'));
  act(() => confirmed('전송 원문'));
  expect(first.result.current.value).toBe('다음 메시지');
  first.unmount();
  const reopened = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  expect(reopened.result.current.value).toBe('다음 메시지');
  act(() => reopened.result.current.clearIfMatches('다음 메시지'));
  expect(reopened.result.current.hasDraft).toBe(false);
});

test('hydration gate prevents empty defaults from replacing a saved draft', async () => {
  const key = JSON.stringify(['https://one.example', 'one@example.com', 'chat', ['node', 'session']]);
  await AsyncStorage.setItem('soul-app-drafts', JSON.stringify({ state: { drafts: { [key]: '복원할 원문' } }, version: 0 }));
  let resolveRead!: (value: string | null) => void;
  const stored = await AsyncStorage.getItem('soul-app-drafts');
  const read = jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  let hydration!: Promise<void>;
  act(() => { hydration = useDraftStore.persist.rehydrate() as Promise<void>; });
  const view = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  expect(view.result.current.ready).toBe(false);
  act(() => view.result.current.setValue(''));
  await act(async () => { resolveRead(stored); await hydration; });
  expect(view.result.current.value).toBe('복원할 원문');
  read.mockRestore();
});

test('unidentified user keeps input in memory without loading or persisting drafts', () => {
  useAuthStore.setState({ jwt: null });
  const view = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  act(() => view.result.current.setValue('메모리 입력'));
  expect(view.result.current.value).toBe('메모리 입력');
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
  view.unmount();
  const reopened = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  expect(reopened.result.current.value).toBe('');
});

test('clearing server text is a real edit; discarding restores the server value', () => {
  const view = renderHook(() => usePersistentDraft('project-context', ['project'], '서버 지침'));
  act(() => view.result.current.setValue(''));
  expect(view.result.current.value).toBe('');
  expect(view.result.current.hasDraft).toBe(true);
  act(() => view.result.current.clear());
  expect(view.result.current.value).toBe('서버 지침');
});

const probe = {
  value: '',
  hasDraft: false,
  setValue: (_: string) => {},
  clear: () => {},
  clearIfMatches: (_: string) => {},
};

function DraftProbe({ role, target, initialValue = '' }: { role: string; target: string; initialValue?: string }) {
  const draft = usePersistentDraft(role, [target], initialValue);
  probe.value = draft.value;
  probe.hasDraft = draft.hasDraft;
  probe.setValue = draft.setValue as (value: string) => void;
  probe.clear = draft.clear;
  probe.clearIfMatches = draft.clearIfMatches;
  return null;
}

function DraftHarness({ epoch, role = 'chat', target = 'session', initialValue = '' }: {
  epoch: number;
  role?: string;
  target?: string;
  initialValue?: string;
}) {
  return (
    <LayoutContinuityProvider>
      <DraftProbe key={epoch} role={role} target={target} initialValue={initialValue} />
    </LayoutContinuityProvider>
  );
}

test('unidentified user draft is restored after a layout remount through the continuity memory map', () => {
  useAuthStore.setState({ jwt: null });
  const view = render(<DraftHarness epoch={0} />);
  act(() => probe.setValue('메모리 초안'));
  expect(probe.value).toBe('메모리 초안');
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);

  act(() => { view.rerender(<DraftHarness epoch={1} />); });
  expect(probe.value).toBe('메모리 초안');
  expect(probe.hasDraft).toBe(true);
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
});

test('memory drafts stay isolated by role, target and auth scope generation', () => {
  useAuthStore.setState({ jwt: null });
  const view = render(<DraftHarness epoch={0} />);
  act(() => probe.setValue('메모리 초안'));

  act(() => { view.rerender(<DraftHarness epoch={1} role="card-comment" />); });
  expect(probe.value).toBe('');
  act(() => { view.rerender(<DraftHarness epoch={2} role="chat" target="other" />); });
  expect(probe.value).toBe('');
  act(() => { view.rerender(<DraftHarness epoch={3} />); });
  expect(probe.value).toBe('메모리 초안');

  act(() => { useSettingsStore.setState({ serverUrl: 'https://two.example' }); });
  act(() => { view.rerender(<DraftHarness epoch={4} />); });
  expect(probe.value).toBe('');
});

test('submitted or discarded memory draft is cleared without touching the persisted store', () => {
  useAuthStore.setState({ jwt: null });
  const view = render(<DraftHarness epoch={0} />);
  act(() => probe.setValue('전송 원문'));
  act(() => probe.clearIfMatches('다른 값'));
  act(() => { view.rerender(<DraftHarness epoch={1} />); });
  expect(probe.value).toBe('전송 원문');

  act(() => probe.clearIfMatches('전송 원문'));
  expect(probe.value).toBe('');
  act(() => { view.rerender(<DraftHarness epoch={2} />); });
  expect(probe.value).toBe('');

  act(() => probe.setValue('버릴 초안'));
  act(() => probe.clear());
  act(() => { view.rerender(<DraftHarness epoch={3} />); });
  expect(probe.value).toBe('');
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
});

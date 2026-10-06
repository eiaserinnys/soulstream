import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { StoreApi } from 'zustand';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useAppNoticeStore } from '../../store/appNoticeStore';
const mockList = jest.fn();
jest.mock('../../api/client', () => ({ createApiClient: () => ({ listPersistentSessions: mockList }) }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: jest.fn(() => null) }));
jest.mock('../../components/AppModalSurface', () => ({ AppModalSurface: ({ children }: any) => children }));
import { SettingsScreen } from '../../screens/SettingsScreen';
let host: ReturnType<typeof usePersistentSessionHost>;
let store: StoreApi<PersistentSessionScene>;
function Probe() { host = usePersistentSessionHost(); store = host.store; return null; }
const pas = (id: string) => ({ session_id: id, persistent: true, display_name: id, agent_id: 'roselin', node_id: 'test' });
const defaults = { node_id: 'test', preferred_agent_id: 'roselin' };
beforeEach(() => {
  mockList.mockReset();
  jest.mocked(SettingsScreen).mockClear();
  useAuthStore.setState({ jwt: 'public.' + Buffer.from(JSON.stringify({email: 'review@public.invalid'})).toString('base64url') + '.fixture' });
  useSettingsStore.setState({ serverUrl: 'https://public.invalid', persistentSessionDevicePrefs: {} });
  useAppNoticeStore.getState().dismissNotice();
});
test.each([
  [[], null, null, false],
  [[pas('one')], null, 'one', false],
  [[pas('one'), pas('two')], 'two', 'two', false],
  [[pas('one'), pas('two')], 'gone', null, true],
])('시작 개수/마지막 id 규칙: %j, %s', async (sessions, last, expected, choose) => {
  useSettingsStore.getState().setPersistentSessionLastSessionId('https://public.invalid', 'review@public.invalid', last);
  mockList.mockResolvedValue({ sessions, create_defaults: defaults });
  const open = jest.fn();
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  await act(async () => { await host.initialize(open, true); });
  expect(store.getState().session?.session_id ?? null).toBe(expected);
  expect(open).toHaveBeenCalledTimes(expected ? 1 : 0);
  expect(Boolean(view.queryByTestId('persistent-entry-one'))).toBe(choose);
  expect(SettingsScreen).not.toHaveBeenCalled();
  if (choose) {
    fireEvent.press(view.getByTestId('persistent-entry-two'));
    expect(store.getState().session?.session_id).toBe('two');
    expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://public.invalid', 'review@public.invalid').lastSessionId).toBe('two');
  }
});
test('시작 토글 끔은 초상만 읽고, 0개의 수동 입구는 기존 추가 화면을 연다', async () => {
  mockList.mockResolvedValue({ sessions: [], create_defaults: defaults });
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  const open = jest.fn();
  await act(async () => { await host.initialize(open, false); });
  expect(host.portrait).toMatchObject({ agent_id: 'roselin' });
  expect(open).not.toHaveBeenCalled();
  expect(view.queryByTestId('persistent-entry-loading')).toBeNull();
  await act(async () => { await host.requestEntry(open); });
  expect(jest.mocked(SettingsScreen).mock.calls.at(-1)![0]).toMatchObject({ category: 'persistent', initialPersistentDestination: { kind: 'editor' } });
});
test('시작 조회 중 도착한 세션 intent는 늦은 PAS 응답보다 우선하고 loading sheet는 없다', async () => {
  let finish!: (result: unknown) => void;
  mockList.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const open = jest.fn();
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  let pending!: Promise<void>;
  act(() => { pending = host.initialize(open, true); });
  expect(view.queryByText('영구 세션')).toBeNull();
  view.rerender(<PersistentSessionProvider sessionIntent><Probe /></PersistentSessionProvider>);
  expect(view.queryByTestId('persistent-entry-loading')).toBeNull();
  await act(async () => { finish({ sessions: [pas('one')], create_defaults: defaults }); await pending; });
  expect(open).not.toHaveBeenCalled();
  expect(store.getState().session).toBeNull();
});

test('이미 선택 sheet가 열린 뒤 새 session intent가 오면 선택 sheet를 닫는다', async () => {
  mockList.mockResolvedValue({ sessions: [pas('one'), pas('two')], create_defaults: defaults });
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  await act(async () => { await host.requestEntry(jest.fn()); });
  expect(view.getByTestId('persistent-entry-one')).toBeTruthy();
  view.rerender(<PersistentSessionProvider sessionIntent><Probe /></PersistentSessionProvider>);
  expect(view.queryByTestId('persistent-entry-one')).toBeNull();
});
test('시작 실패는 홈 안내, 수동 실패는 오류와 같은 입구 재시도이며 0개로 처리하지 않는다', async () => {
  mockList.mockRejectedValue(new Error('offline'));
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  const open = jest.fn();
  await act(async () => { await host.initialize(open, true); });
  expect(useAppNoticeStore.getState().notice).toMatchObject({ tone: 'error', title: '영구 세션을 불러오지 못했습니다.' });
  expect(view.queryByTestId('persistent-entry-error')).toBeNull();
  await act(async () => { await host.requestEntry(open); });
  expect(view.getByTestId('persistent-entry-error')).toBeTruthy();
  mockList.mockResolvedValue({ sessions: [pas('one')], create_defaults: defaults });
  await act(async () => { fireEvent.press(view.getByLabelText('영구 세션 다시 조회')); });
  expect(open).toHaveBeenCalledTimes(1);
  expect(store.getState().session?.session_id).toBe('one');
});

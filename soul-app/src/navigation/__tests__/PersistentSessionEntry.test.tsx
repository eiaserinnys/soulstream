import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Image } from 'react-native';
import type { StoreApi } from 'zustand';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';
import { PersistentSessionPortrait, PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { ReviewPersistentEntry } from '../../component-review/ReviewPersistentEntry';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useAppNoticeStore } from '../../store/appNoticeStore';
const mockList = jest.fn();
const mockSideBandWidth = jest.fn();
jest.mock('../../api/client', () => ({ createApiClient: () => ({ listPersistentSessions: mockList }) }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: jest.fn((props: any) => {
  const { useDuoSideBand } = require('../duoSideBand');
  const { useRegisterDuoRailOverride } = require('../phoneRailActions');
  useRegisterDuoRailOverride('entry-settings', useDuoSideBand(), [{ id: 'close', label: '설정 닫기', icon: 'close', onPress: props.onClose }]);
  return null;
}) }));
jest.mock('../../components/AppModalSurface', () => ({ AppModalSurface: ({ children, sideBand, sideBandWidth }: any) => {
  mockSideBandWidth(sideBandWidth);
  return <>{children}{sideBand}</>;
} }));
import { SettingsScreen } from '../../screens/SettingsScreen';
import { DuoSideBandContext } from '../tabContract';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
let host: ReturnType<typeof usePersistentSessionHost>;
let store: StoreApi<PersistentSessionScene>;
function Probe() { host = usePersistentSessionHost(); store = host.store; return null; }
const pas = (id: string) => ({ session_id: id, persistent: true, display_name: id, agent_id: 'roselin', node_id: 'test' });
const defaults = { node_id: 'test', preferred_agent_id: 'roselin' };
beforeEach(() => {
  mockList.mockReset();
  mockSideBandWidth.mockClear();
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
test('듀오 영구 세션 추가 화면의 모달 안에 레일 호스트가 있다', async () => {
  mockList.mockResolvedValue({ sessions: [], create_defaults: defaults });
  const view = render(<SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 24, left: 0, right: 84 }}>
    <DuoSideBandContext.Provider value={true}><PersistentSessionProvider><Probe /></PersistentSessionProvider></DuoSideBandContext.Provider>
  </SafeAreaInsetsContext.Provider>);
  await act(async () => { await host.requestEntry(jest.fn()); });
  fireEvent.press(view.getByTestId('duo-rail-action-close'));
  expect(view.queryByTestId('duo-rail-action-close')).toBeNull();
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
  await act(async () => { await host.requestEntry(jest.fn(), false, true); });
  expect(view.getByTestId('persistent-entry-one')).toBeTruthy();
  view.rerender(<PersistentSessionProvider sessionIntent><Probe /></PersistentSessionProvider>);
  expect(view.queryByTestId('persistent-entry-one')).toBeNull();
});

test('다른 화면에서는 활성 PAS를 바로 열고 재선택 요청은 세로 가운데에서 고른다', async () => {
  const sessions = [pas('one'), pas('two')];
  mockList.mockResolvedValue({ sessions, create_defaults: defaults });
  const open = jest.fn();
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  act(() => store.getState().open(sessions[1] as any));

  await act(async () => { await host.requestEntry(open); });
  expect(store.getState().session?.session_id).toBe('two');
  expect(store.getState().sessions).toEqual(sessions);
  expect(view.queryByTestId('persistent-entry-one')).toBeNull();

  await act(async () => { await host.requestEntry(open, false, true); });
  const dialog = view.getByTestId('persistent-entry-dialog');
  expect(StyleSheet.flatten(dialog.props.style).justifyContent).toBe('center');
  expect(StyleSheet.flatten(view.getByTestId('persistent-entry-choose-scroll').props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  const closeStyle = StyleSheet.flatten(view.getByLabelText('영구 세션 선택 닫기').props.style);
  expect(closeStyle.minWidth).toBeGreaterThanOrEqual(44);
  expect(closeStyle.minHeight).toBeGreaterThanOrEqual(44);
  expect(closeStyle.alignItems).toBe('flex-end');
  expect(view.getByTestId('persistent-entry-two').props.accessibilityState.selected).toBe(true);
  fireEvent.press(view.getByTestId('persistent-entry-one'));
  expect(store.getState().session?.session_id).toBe('one');
});

test('검수용 PAS 선택은 기본으로 고르고 명시적으로는 바로 연다', async () => {
  const sessions = [pas('one'), pas('two')];
  mockList.mockResolvedValue({ sessions, create_defaults: defaults });
  const onOpenChoose = jest.fn();
  const chooseView = render(<ReviewPersistentEntry onOpen={onOpenChoose} />);
  await waitFor(() => expect(chooseView.getByTestId('persistent-entry-one')).toBeTruthy());
  expect(onOpenChoose).not.toHaveBeenCalled();
  chooseView.unmount();

  const onOpenDirect = jest.fn();
  const directView = render(<ReviewPersistentEntry onOpen={onOpenDirect} choose={false} />);
  await waitFor(() => expect(onOpenDirect).toHaveBeenCalledTimes(1));
  expect(directView.queryByTestId('persistent-entry-one')).toBeNull();
});

test('선택 진입 실패 뒤 재시도도 선택 상태를 유지한다', async () => {
  mockList.mockRejectedValueOnce(new Error('offline'));
  const view = render(<PersistentSessionProvider><Probe /></PersistentSessionProvider>);
  await act(async () => { await host.requestEntry(jest.fn(), false, true); });
  expect(view.getByTestId('persistent-entry-error')).toBeTruthy();

  mockList.mockResolvedValue({ sessions: [pas('one'), pas('two')], create_defaults: defaults });
  await act(async () => { fireEvent.press(view.getByLabelText('영구 세션 다시 조회')); });
  expect(view.getByTestId('persistent-entry-one')).toBeTruthy();
  expect(view.getByTestId('persistent-entry-two')).toBeTruthy();
});

test.each(['choose', 'error'] as const)('듀오 PAS 선택 %s 시트는 84pt 시스템 밴드 폭을 예약한다', async (kind) => {
  mockList.mockResolvedValue({ sessions: [pas('one'), pas('two')], create_defaults: defaults });
  if (kind === 'error') mockList.mockRejectedValueOnce(new Error('offline'));
  const view = render(<SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 24, left: 0, right: 84 }}>
    <DuoSideBandContext.Provider value={true}><PersistentSessionProvider><Probe /></PersistentSessionProvider></DuoSideBandContext.Provider>
  </SafeAreaInsetsContext.Provider>);

  await act(async () => { await host.requestEntry(jest.fn(), false, true); });

  expect(view.getByTestId(kind === 'choose' ? 'persistent-entry-one' : 'persistent-entry-error')).toBeTruthy();
  expect(mockSideBandWidth).toHaveBeenLastCalledWith(84);
});

test('초상화 이미지 로드 실패 시 세션 이니셜 원형을 표시한다', () => {
  const view = render(<PersistentSessionPortrait session={{ ...pas('one'), agent_name: '로젤린' } as any} size={32} />);
  const image = view.UNSAFE_getByType(Image);

  fireEvent(image, 'error');

  expect(view.UNSAFE_queryByType(Image)).toBeNull();
  expect(view.getByText('로')).toBeTruthy();
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

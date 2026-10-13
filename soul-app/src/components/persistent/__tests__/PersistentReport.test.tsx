import React from 'react';
import { AccessibilityInfo, Keyboard, Platform } from 'react-native';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { PersistentReportPager } from '../PersistentReportPager';
import { usePersistentReport } from '../usePersistentReport';
import { reportReviewEntries } from '../../../component-review/persistent-report-fixtures';
import { useSessionStore } from '../../../store/sessionStore';
import { reportSendContext } from '../../../lib/persistent-report';
import { usePersistentChatDisplaySettings } from '../../chat/usePersistentChatDisplaySettings';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDevice = 'phone';
jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => mockDevice }));
const mockOpen = jest.fn(() => Promise.resolve());
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => mockOpen }));
beforeEach(() => {
  mockDevice = 'phone'; jest.clearAllMocks();
  useSessionStore.setState({ persistentReportsBySession: {} });
});
afterEach(() => jest.restoreAllMocks());

function pager(entries = reportReviewEntries) {
  const onSelect = jest.fn(), onDismiss = jest.fn().mockResolvedValue(undefined), onAppend = jest.fn(() => ({ ok: true as const }));
  const api = { listCards: jest.fn().mockResolvedValue({ cards: [{ id: 'public-card', number: 270 }] }) } as any;
  function Harness() {
    const [index, setIndex] = React.useState(0);
    return <PersistentReportPager entries={entries} index={index} api={api}
      onSelect={i => { onSelect(i); setIndex(i); }} onDismiss={onDismiss} onAppend={onAppend} onFocusComposer={jest.fn()} />;
  }
  const screen = render(<Harness />);
  if (entries.length) fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  return { ...screen, onSelect, onDismiss, onAppend, api };
}

test('zero sheets renders nothing; one sheet has no page or arrows and see always has dismiss', () => {
  expect(pager([]).queryByTestId('report-deck')).toBeNull();
  const screen = pager([reportReviewEntries[2]]);
  expect(screen.queryByTestId('report-page')).toBeNull();
  expect(screen.queryByTestId('report-nav')).toBeNull();
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.onDismiss).toHaveBeenCalledWith('result');
});

test('phone swipes and adjustable page select one accessible sheet; tablet arrows and keyboard also page', () => {
  const screen = pager();
  expect(screen.queryByTestId('report-nav')).toBeNull();
  expect(screen.getAllByTestId('report-kind')).toHaveLength(1);
  fireEvent.scroll(screen.getByTestId('report-track'), { nativeEvent: { contentOffset: { x: 390 } } });
  expect(screen.getByTestId('report-page').props.accessibilityValue.text).toBe('2 / 3');
  if (Platform.OS !== 'web') expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('2 / 3');
  fireEvent(screen.getByTestId('report-page'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(screen.getByText('보실 것')).toBeTruthy();
  screen.unmount();
  mockDevice = 'tablet';
  const tablet = pager();
  fireEvent.press(tablet.getByLabelText('다음 장'));
  expect(tablet.getByTestId('report-count').props.children).toBe('2 / 3');
  fireEvent(tablet.getByTestId('report-deck'), 'keyDown', { nativeEvent: { key: 'ArrowLeft' }, preventDefault: jest.fn() });
  expect(tablet.getByTestId('report-count').props.children).toBe('1 / 3');
});

test('phone keyboard collapses context/buttons, keeps two-line action, and restores without swallowing links', async () => {
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
    listeners[name] = listener as () => void; return { remove: jest.fn() } as any;
  });
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const screen = pager();
  act(() => listeners[Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow']());
  expect(screen.queryByTestId('report-context')).toBeNull();
  expect(screen.queryByTestId('report-actions')).toBeNull();
  expect(screen.getByTestId('report-todo').props.numberOfLines).toBe(2);
  expect(screen.getByTestId('report-title').props.accessibilityHint).toBe('누르면 펼칩니다');
  const stop = jest.fn();
  fireEvent.press(screen.getByLabelText('카드 270번 열기'), { stopPropagation: stop });
  await act(async () => {});
  expect(stop).toHaveBeenCalled();
  expect(mockOpen).toHaveBeenCalledWith('/?card=public-card');
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.scroll(screen.getByTestId('report-track'), { nativeEvent: { contentOffset: { x: 780 } } });
  fireEvent.press(screen.getByTestId('report-link'), { stopPropagation: stop });
  expect(mockOpen).toHaveBeenCalledWith('https://example.com/report');
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('report-sheet-result'));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('report-context')).toBeTruthy();
});

test('current key survives additions and removals; current removal selects the next slot, then previous', () => {
  const store = useSessionStore.getState();
  act(() => store.applyPersistentReport('pas', reportReviewEntries));
  const hook = renderHook(() => usePersistentReport('pas', true, null, undefined, undefined));
  act(() => hook.result.current.select(1));
  const extra = { ...reportReviewEntries[0], key: 'extra' };
  act(() => store.applyPersistentReport('pas', [...reportReviewEntries, extra]));
  expect(hook.result.current.entries[hook.result.current.index].key).toBe('cleanup');
  act(() => store.applyPersistentReport('pas', [...reportReviewEntries.slice(1), extra]));
  expect(hook.result.current.index).toBe(0);
  expect(hook.result.current.entries[0].key).toBe('cleanup');
  act(() => store.applyPersistentReport('pas', [reportReviewEntries[2], extra]));
  expect(hook.result.current.entries[hook.result.current.index].key).toBe('result');
  act(() => hook.result.current.select(1));
  act(() => store.applyPersistentReport('pas', [reportReviewEntries[2]]));
  expect(hook.result.current.entries[hook.result.current.index].key).toBe('result');
});

test('snapshot completion cannot replace newer live, including live empty; fresh baseline can replace it', () => {
  const start = useSessionStore.getState();
  const baseline = { generation: start.scopeGeneration, snapshot: start.persistentReportsBySession.pas };
  start.applyPersistentReport('pas', []);
  start.applyPersistentReport('pas', reportReviewEntries, baseline);
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toEqual([]);
  const fresh = useSessionStore.getState();
  fresh.applyPersistentReport('pas', reportReviewEntries, { generation: fresh.scopeGeneration, snapshot: fresh.persistentReportsBySession.pas });
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toBe(reportReviewEntries);
});

test('actual PAS detail reader cannot overwrite a live report arriving after its request began', async () => {
  let resolve!: (value: any) => void;
  const api = { getPersistentSession: jest.fn(() => new Promise(done => { resolve = done; })) } as any;
  renderHook(() => usePersistentChatDisplaySettings(api, true, 'pas'));
  act(() => useSessionStore.getState().applyPersistentReport('pas', []));
  await act(async () => resolve({ session: { persistent: false, persistent_report: reportReviewEntries } }));
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toEqual([]);
});

test('dismiss removes immediately and moves to the composer when the last report disappears', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [reportReviewEntries[2]]));
  let finish!: (value: any) => void;
  const api = { dismissPersistentReport: jest.fn(() => new Promise(done => { finish = done; })) } as any;
  const focus = jest.fn();
  function Harness() {
    const report = usePersistentReport('pas', true, api, undefined, undefined);
    return <PersistentReportPager {...report} api={api} onSelect={report.select} onDismiss={report.dismiss}
      onAppend={() => ({ ok: true })} onFocusComposer={focus} />;
  }
  const screen = render(<Harness />);
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.queryByTestId('report-deck')).toBeNull();
  if (Platform.OS !== 'web') expect(focus).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, persistent_report: [] }));
  expect(api.dismissPersistentReport).toHaveBeenCalledWith('pas', 'result');
});

test('reply line must remain intact; ordinary text describes the visible sheet and absent report has no context', () => {
  const reply = { key: 'cleanup', option: '응', text: '블로그 저장소 브랜치 정리: 응' };
  expect(reportSendContext(reportReviewEntries, 'app', `쓰던 글\n\n${reply.text}`, reply).contextItems)
    .toEqual([{ key: 'persistent_report_reply', content: { key: 'cleanup', option: '응' } }]);
  expect(reportSendContext(reportReviewEntries, 'app', '다른 답', reply).contextItems)
    .toEqual([{ key: 'persistent_report_visible', content: { key: 'app', title: '앱 보고 확인' } }]);
  expect(reportSendContext([], undefined, '일반 글', null)).toEqual({});
});

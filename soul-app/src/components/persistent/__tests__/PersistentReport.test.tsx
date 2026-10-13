import React from 'react';
import { AccessibilityInfo, Keyboard, Platform, StyleSheet } from 'react-native';
import * as ReactNative from 'react-native';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { PersistentReportPager } from '../PersistentReportPager';
import { usePersistentReport } from '../usePersistentReport';
import { reportReviewEntries } from '../../../component-review/persistent-report-fixtures';
import { useSessionStore } from '../../../store/sessionStore';
import { reportSendContext, type ReportReplyDraft } from '../../../lib/persistent-report';
import { usePersistentChatDisplaySettings } from '../../chat/usePersistentChatDisplaySettings';
import { ChatUiControllerProvider } from '../../chat-ui/ChatUiControllerProvider';

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
  const onSelect = jest.fn(), onDismiss = jest.fn().mockResolvedValue(undefined), onAppend = jest.fn((_text: string, _reply?: ReportReplyDraft) => ({ ok: true as const }));
  const api = { listCards: jest.fn().mockResolvedValue({ cards: [{ id: 'public-card', number: 270 }] }) } as any;
  function Harness() {
    const [index, setIndex] = React.useState(0);
    return <ChatUiControllerProvider sessionId="pas" appendGeneratedText={(_id, text, reply) => onAppend(text, reply)}>
      <PersistentReportPager entries={entries} index={index} api={api}
        onSelect={i => { onSelect(i); setIndex(i); }} onDismiss={onDismiss} onFocusComposer={jest.fn()} />
    </ChatUiControllerProvider>;
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
  expect(screen.queryByLabelText('앞 장')).toBeNull();
  expect(screen.queryByTestId('report-kind')).toBeNull();
  expect(screen.getByTestId('report-sheet-app').props.accessibilityLabel).toContain('답하실 것');
  fireEvent.scroll(screen.getByTestId('report-track'), { nativeEvent: { contentOffset: { x: 390 } } });
  expect(screen.getByTestId('report-page').props.accessibilityValue.text).toBe('2 / 3');
  if (Platform.OS !== 'web') expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('2 / 3');
  fireEvent(screen.getByTestId('report-page'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(screen.getByTestId('report-sheet-result').props.accessibilityLabel).toContain('보실 것');
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
    return <ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
      <PersistentReportPager {...report} api={api} onSelect={report.select} onDismiss={report.dismiss} onFocusComposer={focus} />
    </ChatUiControllerProvider>;
  }
  const screen = render(<Harness />);
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.queryByTestId('report-deck')).toBeNull();
  if (Platform.OS !== 'web') expect(focus).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, persistent_report: [] }));
  expect(api.dismissPersistentReport).toHaveBeenCalledWith('pas', 'result');
});

test('the whole report touch frame uses the minimum tokens without changing its content padding or width', () => {
  const screen = pager();
  const style = StyleSheet.flatten(screen.getByTestId('report-sheet-app').props.style);
  expect(style.minWidth).toBeGreaterThanOrEqual(44);
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
  expect(style.width).toBe(390);
  const chip = screen.getByLabelText('카드 270번 열기');
  expect(StyleSheet.flatten(chip.props.style).minHeight).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(screen.getByTestId('report-card-pill').props.style).minHeight).toBe(24);
  expect(screen.queryByTestId('report-kind')).toBeNull();
});

test('failed dismiss returns to the same visible key when another sheet filled its slot', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', reportReviewEntries));
  const api = { dismissPersistentReport: jest.fn().mockRejectedValue(Error('public failure')) } as any;
  const hook = renderHook(() => usePersistentReport('pas', true, api, undefined, undefined));
  act(() => hook.result.current.select(2));
  let ok: boolean | undefined;
  await act(async () => { ok = await hook.result.current.dismiss('result'); });
  expect(ok).toBe(false);
  expect(hook.result.current.entries[hook.result.current.index].key).toBe('result');
  expect(hook.result.current.entries).toEqual(reportReviewEntries);
});

test('only the complete trimmed message matching the button reply carries reply context', () => {
  const reply = { key: 'cleanup', option: '응', text: '블로그 저장소 브랜치 정리: 응' };
  expect(reportSendContext(reportReviewEntries, 'app', ` \n${reply.text}\n `, reply).contextItems)
    .toEqual([{ key: 'persistent_report_reply', content: { key: 'cleanup', option: '응' } }]);
  for (const text of [`쓰던 글\n\n${reply.text}`, `${reply.text} 대신 보류합니다`, `${reply.text}!`]) {
    expect(reportSendContext(reportReviewEntries, 'app', text, reply).contextItems)
      .toEqual([{ key: 'persistent_report_visible', content: { key: 'app', title: '앱 보고 확인' } }]);
  }
  expect(reportSendContext(reportReviewEntries, 'app', '다른 답', reply).contextItems)
    .toEqual([{ key: 'persistent_report_visible', content: { key: 'app', title: '앱 보고 확인' } }]);
  expect(reportSendContext([], undefined, '일반 글', null)).toEqual({});
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const seeA = { ...reportReviewEntries[2], key: 'a', title: '첫째 보고' };
const seeB = { ...reportReviewEntries[2], key: 'b', title: '둘째 보고' };

test('a cloned publication stays hidden when the full report arrives with a new sheet', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA, seeB]));
  const response = deferred<any>();
  const api = { dismissPersistentReport: jest.fn(() => response.promise) } as any;
  const hook = renderHook(() => usePersistentReport('pas', true, api, undefined, undefined));
  let request!: Promise<boolean>;
  act(() => { request = hook.result.current.dismiss('a'); });
  const cloneA = { ...seeA }, c = { ...seeB, key: 'c', title: '새 보고' };
  act(() => useSessionStore.getState().applyPersistentReport('pas', [cloneA, { ...seeB }, c]));
  expect(cloneA).not.toBe(seeA);
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['b', 'c']);
  await act(async () => { response.resolve({ ok: true, persistent_report: [seeB] }); await request; });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['b', 'c']);
});

test.each(['success', 'failure'] as const)('a revised publication is visible while its old dismissal waits and survives %s', async outcome => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA, seeB]));
  const response = deferred<any>();
  const api = { dismissPersistentReport: jest.fn(() => response.promise) } as any;
  const hook = renderHook(() => usePersistentReport('pas', true, api, undefined, undefined));
  let request!: Promise<boolean>;
  act(() => { request = hook.result.current.dismiss('a'); });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['b']);
  const revisedA = { ...seeA, title: '고쳐진 첫째 보고', updated_at: '2026-10-13T00:02:00Z' };
  act(() => useSessionStore.getState().applyPersistentReport('pas', [revisedA, { ...seeB }]));
  expect(hook.result.current.entries).toContainEqual(revisedA);
  await act(async () => {
    if (outcome === 'success') response.resolve({ ok: true, persistent_report: [seeB] });
    else response.reject(Error('old dismissal failed'));
    expect(await request).toBe(outcome === 'success');
  });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['a', 'b']);
  expect(hook.result.current.entries).toContainEqual(revisedA);
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toContainEqual(revisedA);
});

test('old success does not delete the revised publication from the latest server report', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA]));
  const response = deferred<any>();
  const api = { dismissPersistentReport: jest.fn(() => response.promise) } as any;
  const hook = renderHook(() => usePersistentReport('pas', true, api, undefined, undefined));
  let request!: Promise<boolean>;
  act(() => { request = hook.result.current.dismiss('a'); });
  const revisedA = { ...seeA, updated_at: '2026-10-13T00:02:00Z' };
  act(() => useSessionStore.getState().applyPersistentReport('pas', [revisedA]));
  await act(async () => { response.resolve({ ok: true, persistent_report: [] }); await request; });
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toEqual([revisedA]);
  expect(hook.result.current.entries).toEqual([revisedA]);
});

test('two dismissals stay hidden when responses arrive in reverse order', async () => {
  const tail = { ...reportReviewEntries[0], key: 'tail' };
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA, seeB, tail]));
  const a = deferred<any>(), b = deferred<any>();
  const api = { dismissPersistentReport: jest.fn((_id, key) => key === 'a' ? a.promise : b.promise) } as any;
  const seen: string[][] = [];
  const hook = renderHook(() => {
    const report = usePersistentReport('pas', true, api, undefined, undefined);
    seen.push(report.entries.map(entry => entry.key));
    return report;
  });
  let requestA!: Promise<boolean>, requestB!: Promise<boolean>;
  act(() => { requestA = hook.result.current.dismiss('a'); });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['b', 'tail']);
  act(() => { requestB = hook.result.current.dismiss('b'); });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['tail']);
  seen.length = 0;
  await act(async () => { b.resolve({ ok: true, persistent_report: [seeA, tail] }); await requestB; });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['tail']);
  await act(async () => { a.resolve({ ok: true, persistent_report: [seeB, tail] }); await requestA; });
  expect(hook.result.current.entries.map(entry => entry.key)).toEqual(['tail']);
  expect(seen.every(keys => keys.join(',') === 'tail')).toBe(true);
  expect(useSessionStore.getState().persistentReportsBySession.pas.entries).toEqual([tail]);
});

test('two presses on the same pending key share exactly one request', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA]));
  const response = deferred<any>();
  const api = { dismissPersistentReport: jest.fn(() => response.promise) } as any;
  const hook = renderHook(() => usePersistentReport('pas', true, api, undefined, undefined));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => { first = hook.result.current.dismiss('a'); second = hook.result.current.dismiss('a'); });
  expect(first).toBe(second);
  expect(api.dismissPersistentReport).toHaveBeenCalledTimes(1);
  await act(async () => { response.resolve({ ok: true, persistent_report: [] }); await first; });
  expect(hook.result.current.entries).toEqual([]);
});

test('removing the focused sheet focuses the accessible replacement title, not its outer Pressable', async () => {
  act(() => useSessionStore.getState().applyPersistentReport('pas', [seeA, seeB]));
  const response = deferred<any>();
  const api = { dismissPersistentReport: jest.fn(() => response.promise) } as any;
  // Spy on the module used by named imports, not Babel's namespace copy.
  const find = jest.spyOn(require('react-native') as typeof ReactNative, 'findNodeHandle').mockImplementation(node => {
    const props = (node as { props?: { children?: string } } | null)?.props;
    return props?.children === seeB.title ? 22 : 11;
  });
  const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus');
  function Harness() {
    const report = usePersistentReport('pas', true, api, undefined, undefined);
    return <ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
      <PersistentReportPager {...report} api={api} onSelect={report.select} onDismiss={report.dismiss} onFocusComposer={jest.fn()} />
    </ChatUiControllerProvider>;
  }
  const screen = render(<Harness />, { createNodeMock: element => ({ props: element.props }) });
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  AccessibilityInfo.setAccessibilityFocus(11);
  focus.mockClear();
  fireEvent.press(screen.getByLabelText('봤다'));
  expect(screen.getByTestId('report-title').props.accessible).toBe(true);
  expect(screen.getByTestId('report-sheet-b').props.accessible).toBe(false);
  expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
    testID: 'report-title', accessible: true, accessibilityRole: 'header', children: seeB.title,
  }) }));
  expect(focus).toHaveBeenLastCalledWith(22);
  await act(async () => { response.resolve({ ok: true, persistent_report: [seeB] }); });
});


test('bubble scrolls only its reading block and keeps the footer fixed; compact has no empty strip', () => {
  const api = { listCards: jest.fn().mockResolvedValue({ cards: [] }) } as any;
  const screen = render(<ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
    <PersistentReportPager entries={[reportReviewEntries[1]]} index={0} api={api} bubble maxHeight={300}
      onSelect={jest.fn()} onDismiss={jest.fn().mockResolvedValue(true)} onFocusComposer={jest.fn()} />
  </ChatUiControllerProvider>);
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 318 } } });
  const scrolling = screen.getByTestId('report-scroll');
  expect(scrolling.findAllByProps({ testID: 'report-footer' })).toHaveLength(0);
  expect(screen.getByTestId('report-footer')).toBeTruthy();
  fireEvent(scrolling, 'layout', { nativeEvent: { layout: { height: 100 } } });
  fireEvent(scrolling, 'contentSizeChange', 318, 400);
  expect(screen.getByTestId('report-more-below')).toBeTruthy();
  fireEvent.scroll(scrolling, { nativeEvent: { contentOffset: { y: 300 } } });
  expect(screen.queryByTestId('report-more-below')).toBeNull();
});

test('measured height updates are deferred during a report press and applied on release', () => {
  const screen = pager();
  const sheet = screen.getByTestId('report-sheet-app');
  const reading = screen.getByTestId('report-reading');
  fireEvent(reading, 'layout', { nativeEvent: { layout: { height: 100 } } });
  const before = StyleSheet.flatten(screen.getByTestId('report-track').props.style).height;
  fireEvent(sheet, 'touchStart');
  fireEvent(reading, 'layout', { nativeEvent: { layout: { height: 200 } } });
  expect(StyleSheet.flatten(screen.getByTestId('report-track').props.style).height).toBe(before);
  fireEvent(sheet, 'touchEnd');
  expect(StyleSheet.flatten(screen.getByTestId('report-track').props.style).height).toBeGreaterThan(before);
});

test('bubble surface and every page share the explicit capped height after all intrinsic measurements', () => {
  const screen = render(<ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
    <PersistentReportPager entries={[reportReviewEntries[1], reportReviewEntries[2]]} index={0} api={null} bubble maxHeight={440}
      onSelect={jest.fn()} onDismiss={jest.fn().mockResolvedValue(true)} onFocusComposer={jest.fn()} />
  </ChatUiControllerProvider>);
  expect(StyleSheet.flatten(screen.getByTestId('report-deck').props.style).height).toBe(440);
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 318 } } });
  const a = screen.getByTestId('report-sheet-cleanup');
  const b = screen.getByTestId('report-sheet-result', { includeHiddenElements: true });
  fireEvent(a.findByProps({ testID: 'report-scroll' }), 'contentSizeChange', 318, 294);
  expect(StyleSheet.flatten(a.props.style).height).toBe(440);
  fireEvent(a.findByProps({ testID: 'report-footer' }), 'layout', { nativeEvent: { layout: { height: 242 } } });
  expect(StyleSheet.flatten(a.props.style).height).toBe(440);
  fireEvent(b.findByProps({ testID: 'report-scroll' }), 'contentSizeChange', 318, 100);
  fireEvent(b.findByProps({ testID: 'report-footer' }), 'layout', { nativeEvent: { layout: { height: 80 } } });
  expect(StyleSheet.flatten(screen.getByTestId('report-deck').props.style).height).toBe(440);
  expect(StyleSheet.flatten(a.props.style).height).toBe(440);
  expect(StyleSheet.flatten(b.props.style).height).toBe(440);
  fireEvent(a.findByProps({ testID: 'report-scroll' }), 'contentSizeChange', 318, 100);
  fireEvent(a.findByProps({ testID: 'report-footer' }), 'layout', { nativeEvent: { layout: { height: 80 } } });
  expect(StyleSheet.flatten(screen.getByTestId('report-deck').props.style).height).toBe(180);
  expect(StyleSheet.flatten(a.props.style).height).toBe(180);
  expect(StyleSheet.flatten(b.props.style).height).toBe(180);
});

import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import * as ReactNative from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PersistentReportEntry } from '../../../api/types';
import { PersistentReportPager } from '../PersistentReportPager';
import { usePersistentReport } from '../usePersistentReport';
import { usePersistentReportSend } from '../usePersistentReportSend';
import { ChatUiControllerProvider } from '../../chat-ui/ChatUiControllerProvider';
import { CARD_QUESTION_ANSWERED_REASON } from '../../chat/useChatSendFlow';
import { useChatStore } from '../../../store/chatStore';
import { useSessionStore } from '../../../store/sessionStore';
import { measurePersistentReports } from '../../../test-utils/persistent-report-layout';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'hold-expiry-operation-id') }));
// Forward View refs to the host so createNodeMock supplies the actual native
// measurement boundary rather than the preset's inert class method.
jest.mock('react-native/Libraries/Components/View/View', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: ReactModule.forwardRef<ReactNative.View, ReactNative.ViewProps>(
    (props, ref) => ReactModule.createElement('View', { ...props, ref })) };
});
jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => 'phone' }));
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => jest.fn() }));

const question = (): PersistentReportEntry => ({
  key: 'cq_q1', question_id: 'q1', kind: 'ask', title: '비밀값을 옮길까요', card_numbers: [1197],
  context: '실행 명령에 비밀값이 그대로 적힙니다.', action: '', options: ['파일로 옮기기', '그대로 두기'],
  state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z', card_id: 'card-1', card_status: 'blocked',
});
const sibling = (): PersistentReportEntry => ({
  key: 'result', kind: 'see', title: '결과 보기', card_numbers: [], context: '구현을 마쳤습니다.',
  action: '', options: [], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z',
});
const acknowledged = () => ({ intervene: jest.fn(async () => ({ delivered: true, outcome: 'delivered', reason: CARD_QUESTION_ANSWERED_REASON })) } as unknown as ApiClient);

function Harness({ api }: { api: ApiClient }) {
  const report = usePersistentReport('pas', true, api, undefined, undefined);
  const send = usePersistentReportSend('pas', api, report.entries, report.server, 'completed', jest.fn(), {
    begin: report.beginAnsweredHold, confirm: report.holdAnswered, release: report.releaseAnsweredHold });
  return <ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true as const })}>
    <PersistentReportPager entries={send.entries} index={report.index} api={api} send={send}
      answeredHoldKey={report.answeredHoldKey} onAnsweredHoldExpire={report.expireAnsweredHold}
      renderCardDetails={() => <Text testID="card-details">카드 상세</Text>}
      onSelect={report.select} onDismiss={report.dismiss} onFocusComposer={jest.fn()} />
  </ChatUiControllerProvider>;
}

const answer = async (screen: ReturnType<typeof render>) => {
  await act(async () => {
    fireEvent.press(within(screen.getByTestId('report-sheet-cq_q1')).getByLabelText('파일로 옮기기'));
  });
};
const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

beforeEach(() => {
  useSessionStore.setState({ persistentReportsBySession: {} });
  useChatStore.setState({ pendingOptimisticBySession: {}, eventsBySession: {} });
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockReturnValue(new Promise(() => {}));
});
afterEach(() => jest.restoreAllMocks());

test('답을 확정한 접힌 장은 기한 직전까지 남고 기한에 빠진다', async () => {
  jest.useFakeTimers();
  try {
    act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
    const screen = render(<Harness api={acknowledged()} />);
    measurePersistentReports(screen);
    await answer(screen);
    act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
    measurePersistentReports(screen);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();

    advance(10_000 - 100);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();
    advance(100);
    expect(screen.queryByTestId('report-sheet-cq_q1')).toBeNull();
    expect(screen.getByTestId('report-sheet-result')).toBeTruthy();
    screen.unmount();
  } finally {
    jest.useRealTimers();
  }
});

test('펼친 장은 기한이 지나도 남고, 접은 때부터 다시 기한을 센다', async () => {
  jest.useFakeTimers();
  try {
    act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
    const screen = render(<Harness api={acknowledged()} />);
    measurePersistentReports(screen);
    fireEvent.press(within(screen.getByTestId('report-sheet-cq_q1')).getByTestId('report-window-toggle'));
    expect(screen.getByTestId('card-details')).toBeTruthy();
    await answer(screen);
    act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
    measurePersistentReports(screen);

    advance(10_000);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('report-sheet-cq_q1')).getByTestId('report-window-toggle'));
    expect(screen.queryByTestId('card-details')).toBeNull();
    advance(10_000 - 100);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();
    advance(100);
    expect(screen.queryByTestId('report-sheet-cq_q1')).toBeNull();
    screen.unmount();
  } finally {
    jest.useRealTimers();
  }
});

test('응답 전 잠정 붙들기는 기한이 지나도 놓지 않는다', async () => {
  jest.useFakeTimers();
  try {
    const gate: { resolve?: (value: unknown) => void } = {};
    const api = { intervene: jest.fn(() => new Promise(resolve => { gate.resolve = resolve; })) } as unknown as ApiClient;
    act(() => useSessionStore.getState().applyPersistentReport('pas', [question(), sibling()]));
    const screen = render(<Harness api={api} />);
    measurePersistentReports(screen);
    await answer(screen);
    act(() => useSessionStore.getState().applyPersistentReport('pas', [sibling()]));
    measurePersistentReports(screen);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();

    advance(10_000);
    expect(screen.getByTestId('report-sheet-cq_q1')).toBeTruthy();
    await act(async () => {
      gate.resolve?.({ delivered: true, outcome: 'delivered', reason: CARD_QUESTION_ANSWERED_REASON });
      await Promise.resolve();
    });
    screen.unmount();
  } finally {
    jest.useRealTimers();
  }
});

jest.mock('expo-crypto', () => { let n = 0; return { randomUUID: jest.fn(() => `op-${++n}`) }; });
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('react-native-webview', () => ({ WebView: (props: unknown) => require('react').createElement(require('react-native').View, props) }));
jest.mock('../../planner/PlannerMarkdownText', () => ({
  PlannerMarkdownText: ({ markdown }: { markdown: string }) => require('react').createElement(require('react-native').Text, null, markdown),
}));
jest.mock('../../events/CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: () => null }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true, default: () => require('../../../test-support/pas-report-window-harness').windowDims,
}));

import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { at, checkItem, comment, fakeServer, reviewCard } from '../../../test-support/pas-report';
import { completionStub, labels, resetCards, mount, reviewEntry, settle } from '../../../test-support/pas-report-window-harness';
import { useCardStore } from '../../../store/cardStore';

beforeEach(resetCards);

describe('완료, 보류, 미루기와 되돌리기', () => {
  it('답변 미루기는 선택지를 펼치고 고른 시각을 PATCH로 보낸 뒤 되돌리기 줄을 둔다', async () => {
    const { screen, server } = mount({ cards: [reviewCard('a', 1), reviewCard('b', 2)], entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a' });
    await waitFor(() => expect(screen.getByTestId('pas-report-snooze-trigger')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    const options = screen.getByTestId('pas-report-snooze-options');
    expect(labels(within(options)).slice(-2)).toEqual(['내일 아침', '사흘 뒤']);
    expect(labels(within(options))[0]).toBe('1시간 뒤');
    fireEvent.press(screen.getByTestId('pas-report-snooze-tomorrow'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'updateCard')).toBe(true));
    const [id, patch, version] = server.calls.find(call => call.name === 'updateCard')!.args as [string, { snoozedUntil: string }, number];
    expect(id).toBe('a');
    expect(typeof version).toBe('number');
    const when = new Date(patch.snoozedUntil);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    expect([when.getFullYear(), when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()])
      .toEqual([tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9, 0]);
    await waitFor(() => expect(screen.getByLabelText('되돌리기')).toBeTruthy());
    expect(screen.getByTestId('report-undo-label').props.children).toBe('#1 미뤄 둠');
    // 다음 결재 대기 안건으로 넘어간다.
    expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드');
    fireEvent.press(screen.getByLabelText('되돌리기'));
    await waitFor(() => expect(server.calls.filter(call => call.name === 'updateCard')).toHaveLength(2));
    expect(server.calls.filter(call => call.name === 'updateCard')[1].args[1]).toEqual({ snoozedUntil: null });
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('1번 카드'));
    expect(screen.queryByLabelText('되돌리기')).toBeNull();
  });

  it('미루기 실패는 결재 상자 안에 알리고 안건과 단추를 그대로 둔다', async () => {
    const server = fakeServer([reviewCard('a', 1)]);
    const { screen } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server });
    await waitFor(() => expect(screen.getByTestId('pas-report-snooze-trigger')).toBeTruthy());
    server.failNext('updateCard', '미루기를 서버가 거절했어');
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    fireEvent.press(screen.getByTestId('pas-report-snooze-hour'));
    await waitFor(() => expect(within(screen.getByTestId('pas-report-decide')).getByTestId('pas-report-action-error')).toBeTruthy());
    expect(screen.getByTestId('pas-report-action-error').props.children).toBe('미루기를 서버가 거절했어');
    expect(screen.getByTestId('pas-report-title').props.children).toBe('1번 카드');
    expect(screen.getByTestId('pas-report-complete')).toBeTruthy();
    expect(screen.queryByLabelText('되돌리기')).toBeNull();
  });

  it('완료와 보류는 기존 완료 훅으로 처리하고, 처리하면 처리됨으로 옮겨 다음 안건으로 넘어간다', async () => {
    const completion = completionStub();
    const { screen } = mount({ cards: [reviewCard('a', 1), reviewCard('b', 2)], entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', completion, width: 820 });
    await waitFor(() => expect(screen.getByTestId('pas-report-complete')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-hold'));
    await waitFor(() => expect(completion.complete).toHaveBeenCalledTimes(1));
    expect(completion.complete.mock.calls[0][0].key).toBe('card_a');
    expect(completion.complete.mock.calls[0][2]).toBe('on_hold');
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드'));
    expect(within(screen.getByTestId('pas-report-rail-처리됨')).queryByTestId('pas-report-row-a')).toBeTruthy();
  });

  it('완료 실패는 결재 상자 안에 알리고 안건과 단추를 그대로 둔다', async () => {
    const completion = completionStub({ complete: jest.fn(async () => false) as never });
    const { screen } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', completion });
    await waitFor(() => expect(screen.getByTestId('pas-report-complete')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-complete'));
    await waitFor(() => expect(screen.getByTestId('pas-report-action-error').props.children).toBe('카드를 완료하지 못했어.'));
    expect(screen.getByTestId('pas-report-title').props.children).toBe('1번 카드');
    expect(screen.getByTestId('pas-report-complete')).toBeTruthy();
    expect(screen.queryByTestId('pas-report-rail-처리됨')).toBeNull();
  });

  it('되돌리기 실패는 처리됨에서 지우지 않고 알린다. 성공하면 지우고 그 안건으로 돌린다', async () => {
    const recent = { cardId: 'a', number: 1, target: 'done' as const, label: '#1 완료됨', expiresAt: Date.now() + 5000 };
    const undo = jest.fn(async () => false);
    const completion = completionStub({ recent, undo: undo as never });
    const first = mount({ cards: [reviewCard('a', 1), reviewCard('b', 2)], entries: [reviewEntry('b', 2)], startCardId: 'b', completion, width: 820 });
    await waitFor(() => expect(first.screen.getByLabelText('되돌리기')).toBeTruthy());
    fireEvent.press(first.screen.getByLabelText('되돌리기'));
    await waitFor(() => expect(first.screen.getByTestId('pas-report-action-error').props.children).toBe('되돌리지 못했어.'));
    expect(first.screen.getByTestId('pas-report-title').props.children).toBe('2번 카드');
    expect(first.screen.getByLabelText('되돌리기')).toBeTruthy();
  });

  it('마지막 안건을 처분해 판이 비어도 보고 창은 남고 처리됨이 남는다', async () => {
    const completion = completionStub();
    const { screen, rerender } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', completion, width: 820 });
    await waitFor(() => expect(screen.getByTestId('pas-report-complete')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-complete'));
    await waitFor(() => expect(completion.complete).toHaveBeenCalled());
    await waitFor(() => expect(within(screen.getByTestId('pas-report-rail-처리됨')).queryByTestId('pas-report-row-a')).toBeTruthy());
    rerender([]);
    await settle();
    expect(screen.getByTestId('pas-report-window')).toBeTruthy();
    expect(within(screen.getByTestId('pas-report-rail-처리됨')).queryByTestId('pas-report-row-a')).toBeTruthy();
    expect(screen.getByTestId('pas-report-title').props.children).toBe('1번 카드');
    // 처리된 안건은 결재 단추 대신 처리 결과를 보인다.
    expect(screen.queryByTestId('pas-report-complete')).toBeNull();
    expect(within(screen.getByTestId('pas-report-decide')).getByText('완료')).toBeTruthy();
  });

  it('확인했어는 보고 판의 내리기를 그대로 부르고, 실패하면 알린다', async () => {
    const dismissReport = jest.fn(async () => false);
    const card = cardFixture({ id: 'b', number: 2, status: 'blocked', assigneeKind: 'session', assigneeSessionId: 's-main', title: '2번 카드' });
    const { screen } = mount({ cards: [card], entries: [reviewEntry('b', 2, { card_status: 'blocked' })], startCardId: 'b', dismissReport, width: 820 });
    await waitFor(() => expect(screen.getByTestId('pas-report-acknowledge')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-acknowledge'));
    await waitFor(() => expect(dismissReport).toHaveBeenCalledWith('card_b'));
    await waitFor(() => expect(screen.getByTestId('pas-report-action-error').props.children).toBe('보고를 내리지 못했어.'));
    dismissReport.mockResolvedValueOnce(true);
    fireEvent.press(screen.getByTestId('pas-report-acknowledge'));
    await waitFor(() => expect(within(screen.getByTestId('pas-report-rail-처리됨')).queryByTestId('pas-report-row-b')).toBeTruthy());
  });
});

describe('스레드', () => {
  const detail = {
    comments: [comment({ id: 'c1', cardId: 'a', body: '사용자 글', createdAt: at(12) }),
      comment({ id: 'n1', cardId: 'a', body: '노트 하나 abc123', kind: 'note', authorKind: 'agent', createdAt: at(14) }),
      comment({ id: 'n2', cardId: 'a', body: '노트 둘', kind: 'note', authorKind: 'agent', createdAt: at(15) })],
    nowHistory: [{ text: '조사 중', turn: 'agent' as const, ask: null, at: at(8) }],
    statusHistory: [{ status: 'review' as const, at: at(9), actorKind: 'agent', sessionId: 's-main' }],
  };

  it('원 요청, 이정표, 커멘트를 시간순으로 보이고 이정표 글은 선택할 수 있다. 노트는 한 줄로 접는다', async () => {
    const { screen } = mount({ cards: [reviewCard('a', 1)], details: { a: detail }, entries: [reviewEntry('a', 1)], startCardId: 'a' });
    await waitFor(() => expect(screen.getByTestId('pas-report-timeline')).toBeTruthy());
    expect(screen.getByTestId('pas-report-request')).toBeTruthy();
    const milestone = screen.getByText('조사 중', { exact: false });
    expect(milestone.props.selectable).toBe(true);
    expect(screen.getByText('상태: 검수 대기', { exact: false }).props.selectable).toBe(true);
    expect(screen.getByText('사용자 글')).toBeTruthy();
    expect(screen.getByLabelText('기술 기록 2건')).toBeTruthy();
    expect(screen.queryByText('노트 하나 abc123', { exact: false })).toBeNull();
    fireEvent.press(screen.getByLabelText('기술 기록 2건'));
    expect(screen.getByText('노트 하나 abc123', { exact: false })).toBeTruthy();
  });

  it('로딩 중에는 스레드 자리에 로딩 표시, 실패하면 그 자리에 실패 안내와 다시 시도', async () => {
    const server = fakeServer([reviewCard('a', 1)], { a: detail });
    server.hang('getCard');
    const loading = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server });
    expect(loading.screen.getByTestId('pas-report-thread-loading')).toBeTruthy();
    loading.screen.unmount();
    useCardStore.setState({ details: {} });
    const failing = fakeServer([reviewCard('a', 1)], { a: detail });
    failing.failNext('getCard');
    const failed = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server: failing });
    await waitFor(() => expect(failed.screen.getByTestId('pas-report-thread-error')).toBeTruthy());
    fireEvent.press(failed.screen.getByLabelText('카드 다시 시도'));
    await waitFor(() => expect(failed.screen.getByTestId('pas-report-timeline')).toBeTruthy());
    expect(failing.calls.filter(call => call.name === 'getCard').length).toBeGreaterThanOrEqual(2);
  });

  it('위로 올리면 알약이 겹쳐 뜨고, 알약을 누르거나 맨 아래까지 내리면 다시 꺼진다. 알약 글은 늘 같다', async () => {
    const { screen } = mount({ cards: [reviewCard('a', 1)], details: { a: detail }, entries: [reviewEntry('a', 1)], startCardId: 'a' });
    const scroll = await screen.findByTestId('pas-report-thread-scroll');
    const event = (y: number) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 2000 }, layoutMeasurement: { height: 600 } } });
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
    fireEvent.scroll(scroll, event(1400));
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
    fireEvent.scroll(scroll, event(300));
    const pill = screen.getByTestId('pas-report-latest-pill');
    expect(within(pill).getByText('최신 경과로 ↓')).toBeTruthy();
    fireEvent.press(pill);
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
    fireEvent.scroll(scroll, event(1000));
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
    fireEvent.scroll(scroll, event(200));
    expect(screen.getByTestId('pas-report-latest-pill')).toBeTruthy();
    fireEvent.scroll(scroll, event(1400));
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
  });

  it('새 경과가 와서 내용이 늘면 따라 내려가고, 위로 올린 뒤에는 따라가지 않는다', async () => {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => undefined);
    const { screen } = mount({ cards: [reviewCard('a', 1)], details: { a: detail }, entries: [reviewEntry('a', 1)], startCardId: 'a' });
    const scroll = await screen.findByTestId('pas-report-thread-scroll');
    const event = (y: number) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 2000 }, layoutMeasurement: { height: 600 } } });
    // 맨 아래에서 켜진 채 열리므로 내용이 늘면 따라 내려간다.
    toEnd.mockClear();
    fireEvent(scroll, 'contentSizeChange', 390, 2400);
    await waitFor(() => expect(toEnd).toHaveBeenCalled());
    // 위로 올리면 꺼져서 내용이 늘어도 읽던 줄이 밀리지 않는다.
    fireEvent.scroll(scroll, event(1400));
    fireEvent.scroll(scroll, event(200));
    toEnd.mockClear();
    fireEvent(scroll, 'contentSizeChange', 390, 2600);
    await settle();
    expect(toEnd).not.toHaveBeenCalled();
    // 알약을 누르면 다시 켜져서 맨 아래로 간다.
    fireEvent.press(screen.getByTestId('pas-report-latest-pill'));
    await waitFor(() => expect(toEnd).toHaveBeenCalledWith({ animated: true }));
    toEnd.mockRestore();
  });

  it('안건을 바꾸면 알약이 꺼지고 새 안건도 맨 아래에서 시작한다', async () => {
    const { screen } = mount({ cards: [reviewCard('a', 1), reviewCard('b', 2)], details: { a: detail, b: detail }, entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', width: 820 });
    const scroll = await screen.findByTestId('pas-report-thread-scroll');
    const event = (y: number) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 2000 }, layoutMeasurement: { height: 600 } } });
    fireEvent.scroll(scroll, event(1400));
    fireEvent.scroll(scroll, event(100));
    expect(screen.getByTestId('pas-report-latest-pill')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pas-report-row-b'));
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드'));
    expect(screen.queryByTestId('pas-report-latest-pill')).toBeNull();
  });
});

describe('카드 패널 열기와 뒤로 가기', () => {
  it('카드 패널 열기는 지금 안건의 카드를 열고, 돌아와도 같은 안건이다', async () => {
    const { screen, props, rerender } = mount({ cards: [reviewCard('a', 1), reviewCard('b', 2)], entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', width: 820 });
    fireEvent.press(screen.getByTestId('pas-report-row-b'));
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드'));
    fireEvent.press(screen.getByLabelText('카드 패널 열기'));
    expect(props.onOpenCard).toHaveBeenCalledWith('b');
    // 카드 패널이 닫히고 돌아오는 동안에도 창은 그대로 마운트되어 같은 안건을 가리킨다.
    rerender([reviewEntry('a', 1), reviewEntry('b', 2)]);
    expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드');
  });

  it('뒤로 가기는 서랍, 답변 미루기 펼침 순으로 열린 것 하나씩 닫고 마지막엔 false를 돌려준다', async () => {
    const { screen, ref } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 390 });
    await waitFor(() => expect(screen.getByTestId('pas-report-snooze-trigger')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-open-rail'));
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    expect(screen.getByTestId('pas-report-drawer')).toBeTruthy();
    expect(screen.getByTestId('pas-report-snooze-options')).toBeTruthy();
    act(() => { expect(ref.current!.back()).toBe(true); });
    expect(screen.queryByTestId('pas-report-drawer')).toBeNull();
    expect(screen.getByTestId('pas-report-snooze-options')).toBeTruthy();
    act(() => { expect(ref.current!.back()).toBe(true); });
    expect(screen.queryByTestId('pas-report-snooze-options')).toBeNull();
    act(() => { expect(ref.current!.back()).toBe(false); });
  });

  it('뒤로 가기는 서랍 다음에 입력창을 닫고, 항목 대상도 함께 푼다', async () => {
    const card = reviewCard('a', 1, { items: [checkItem({ id: 2, title: '증거를 붙였나' })] });
    const { screen, ref } = mount({ cards: [card], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 390 });
    fireEvent.press(await screen.findByLabelText('2 증거를 붙였나 고칠 점 남기기'));
    await waitFor(() => expect(screen.getByTestId('card-comment-target')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-open-rail'));
    act(() => { expect(ref.current!.back()).toBe(true); });
    expect(screen.queryByTestId('pas-report-drawer')).toBeNull();
    expect(screen.getByTestId('pas-report-composer')).toBeTruthy();
    act(() => { expect(ref.current!.back()).toBe(true); });
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(screen.queryByTestId('card-comment-target')).toBeNull();
    act(() => { expect(ref.current!.back()).toBe(false); });
  });
});

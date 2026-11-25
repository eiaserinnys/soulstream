// 카드 #1871 세라피엘 1차 검수와 감수에서 나온 결함의 되풀이 방지. 결함 번호는 판정문(selaphiel-r1/judgment.md)을 따른다.
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
const mockRestoreFocus = jest.fn();
jest.mock('../../../lib/attachment-focus', () => ({ restoreAttachmentFocus: (target: unknown) => mockRestoreFocus(target) }));

import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { CardDto } from '../../../api/cardTypes';
import { cardFixture } from '../../../test-support/cards';
import { checkItem, fakeServer, openQuestion, reviewCard } from '../../../test-support/pas-report';
import { completionStub, mount, questionEntry, resetCards, reviewEntry } from '../../../test-support/pas-report-window-harness';
import { refreshCard, useCardStore } from '../../../store/cardStore';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';

beforeEach(() => { resetCards(); mockRestoreFocus.mockClear(); useAuthStore.setState({ jwt: null }); useSettingsStore.setState({ serverUrl: '' }); });

const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;
const triggerId = () => (mockRestoreFocus.mock.calls[0]?.[0] as { props?: { testID?: string } } | undefined)?.props?.testID;

describe('결함 1: 완료 되돌리기가 성공하면 그 안건이 결재 대기에 다시 선다', () => {
  it.each([390, 1180])('%dpt: 되돌리기 훅이 완료 상태를 저장소에 남겨도 카드를 다시 읽어 결재 대기의 활성 안건으로 선다', async width => {
    const a = reviewCard('a', 1);
    const cards = [a, reviewCard('b', 2)];
    const server = fakeServer(cards);
    const done: CardDto = { ...a, status: 'done', version: a.version + 1 };
    // 실제 훅처럼: 완료하면 저장소와 서버가 done, 되돌리면 서버는 검수로 돌아가지만 저장소에는 되돌리기 전에 읽은 done 행이 들어간다.
    const completion = completionStub({
      recent: { cardId: 'a', number: 1, target: 'done', label: '#1 완료됨', expiresAt: Date.now() + 60_000 },
      complete: jest.fn(async () => { server.cards.set('a', done); useCardStore.getState().putCard(done); return true; }),
      undo: jest.fn(async () => { server.cards.set('a', { ...a, version: done.version + 1 }); useCardStore.getState().putCard(done); return true; }),
    });
    const { screen } = mount({ cards, entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', completion, server, width });
    await waitFor(() => expect(screen.getByTestId('pas-report-complete')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-complete'));
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드'));
    fireEvent.press(screen.getByLabelText('되돌리기'));
    await waitFor(() => expect(completion.undo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('1번 카드'));
    expect(screen.getByTestId('pas-report-complete')).toBeTruthy();
    if (width >= 820) {
      const pending = within(screen.getByTestId('pas-report-rail-결재 대기'));
      expect(pending.getAllByTestId(/pas-report-row-/).map(row => row.props.testID)).toEqual(expect.arrayContaining(['pas-report-row-a', 'pas-report-row-b']));
      expect(within(screen.getByTestId('pas-report-row-a')).getByTestId('pas-report-row-bar')).toBeTruthy();
      expect(screen.queryByTestId('pas-report-rail-처리됨')).toBeNull();
    }
    expect(useCardStore.getState().rows.a?.status).toBe('review');
  });
});

describe('결함 2: 입력창 알림줄, 해제, 닫은 뒤 초점', () => {
  const cardWithItem = (patch: Partial<CardDto> = {}) => reviewCard('a', 1, { items: [checkItem({ id: 2, title: '증거를 붙였나' })], ...patch });

  it('지시 적기: 알림줄 「커멘트」와 해제가 서고, 해제는 입력창만 닫고 적던 글을 남기며 초점을 지시 적기 단추로 돌린다', async () => {
    // 로그인한 사용자의 글은 저장소에 남는다(시험용 가짜 토큰, 서버에 보내지 않는다).
    useSettingsStore.setState({ serverUrl: 'https://soulstream.test' });
    useAuthStore.setState({ jwt: `h.${Buffer.from(JSON.stringify({ sub: 'u@test', email: 'u@test', name: '', picture: '', exp: 4102444800 })).toString('base64')}.s` });
    const { screen } = mount({ cards: [cardWithItem()], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    await waitFor(() => expect(screen.getByTestId('pas-report-open-composer')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    const notice = screen.getByTestId('pas-report-composer-notice');
    expect(within(notice).getByText('커멘트')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '적다 만 글');
    fireEvent.press(within(notice).getByLabelText('대상 해제'));
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(triggerId()).toBe('pas-report-open-composer');
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    expect(screen.getByPlaceholderText('커멘트').props.value).toBe('적다 만 글');
  });

  it('다르게 답하기와 되묻기도 알림줄과 해제가 있고, 닫으면 각자 연 단추로 초점이 돌아간다', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const { screen } = mount({ cards: [card], details: { q: { questions: [openQuestion({ id: 'q1', cardId: 'q' })] } }, entries: [questionEntry('q', 7)], startCardId: 'q' });
    await waitFor(() => expect(screen.getByTestId('pas-report-answer-freely')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-answer-freely'));
    expect(within(screen.getByTestId('pas-report-composer-notice')).getByText('다르게 답하기')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('pas-report-composer-notice')).getByLabelText('대상 해제'));
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(triggerId()).toBe('pas-report-answer-freely');
    mockRestoreFocus.mockClear();
    fireEvent.press(screen.getByTestId('pas-report-ask-back'));
    expect(within(screen.getByTestId('card-question-target')).getByText('되묻기')).toBeTruthy();
    fireEvent.press(within(screen.getByTestId('card-question-target')).getByLabelText('대상 해제'));
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(triggerId()).toBe('pas-report-ask-back');
  });

  it('항목 지시: 알림줄 해제로 닫으면 초점이 「고칠 점 남기기」 단추로 돌아간다', async () => {
    const { screen } = mount({ cards: [cardWithItem()], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    fireEvent.press(await screen.findByLabelText('2 증거를 붙였나 고칠 점 남기기'));
    const notice = await screen.findByTestId('card-comment-target');
    fireEvent.press(within(notice).getByLabelText('대상 해제'));
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(screen.queryByTestId('card-comment-target')).toBeNull();
    expect(triggerId()).toBe('card-check-item-2-fix');
  });

  it('알림줄은 네 입력창에서 같은 모양(같은 부품)이다', async () => {
    const { screen } = mount({ cards: [cardWithItem()], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    await waitFor(() => expect(screen.getByTestId('pas-report-open-composer')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    const plain = flat(screen.getByTestId('pas-report-composer-notice'));
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    fireEvent.press(await screen.findByLabelText('2 증거를 붙였나 고칠 점 남기기'));
    const item = flat(await screen.findByTestId('card-comment-target'));
    expect(plain).toEqual(item);
    expect(plain.minHeight).toBeGreaterThanOrEqual(44);
  });
});

describe('결함 3: 열린 것이 있는지 폰 화면에 알린다(usePreventRemove가 쓴다)', () => {
  it('서랍, 답변 미루기 펼침, 입력창 가운데 하나라도 열려 있는 동안만 true', async () => {
    const { screen, props, ref } = mount({ cards: [cardFixture({ id: 'a', number: 1, status: 'review', title: '1번 카드', assigneeKind: 'session', assigneeSessionId: 's-main' })],
      entries: [reviewEntry('a', 1)], startCardId: 'a' });
    const last = () => props.onLayersChange.mock.calls[props.onLayersChange.mock.calls.length - 1][0];
    await waitFor(() => expect(screen.getByTestId('pas-report-snooze-trigger')).toBeTruthy());
    expect(last()).toBe(false);
    fireEvent.press(screen.getByTestId('pas-report-open-rail'));
    expect(last()).toBe(true);
    act(() => { ref.current!.back(); });
    expect(last()).toBe(false);
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    expect(last()).toBe(true);
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    expect(last()).toBe(false);
    await waitFor(() => expect(screen.getByTestId('pas-report-open-composer').props.accessibilityState.busy).toBeFalsy());
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    expect(last()).toBe(true);
    act(() => { ref.current!.back(); });
    expect(last()).toBe(false);
  });
});

describe('결함 4: 카드 상세가 없으면 지시 적기는 눌리지 않는다', () => {
  it('로딩 중: 흐린(busy) 단추이고 눌러도 아무것도 바뀌지 않으며 뒤로 가기는 닫을 것이 없다고 답한다', async () => {
    const server = fakeServer([reviewCard('a', 1)]);
    server.hang('getCard');
    const { screen, ref } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server });
    const button = screen.getByTestId('pas-report-open-composer');
    expect(button.props.accessibilityState).toMatchObject({ busy: true });
    fireEvent.press(button);
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    act(() => { expect(ref.current!.back()).toBe(false); });
  });

  it('실패 뒤 다시 시도로 상세가 와도 누르지 않은 입력창은 열리지 않는다', async () => {
    const server = fakeServer([reviewCard('a', 1)]);
    server.failNext('getCard');
    const { screen, props } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server });
    await waitFor(() => expect(screen.getByTestId('pas-report-thread-error')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    fireEvent.press(screen.getByLabelText('카드 다시 시도'));
    await waitFor(() => expect(screen.getByTestId('pas-report-timeline')).toBeTruthy());
    expect(screen.queryByTestId('pas-report-composer')).toBeNull();
    expect(props.onLayersChange).not.toHaveBeenCalledWith(true);
    // 상세가 온 뒤에는 눌러서 열린다.
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    expect(screen.getByTestId('pas-report-composer')).toBeTruthy();
  });

  it('상세 없이도 되는 완료와 보류는 그대로 눌린다', async () => {
    const server = fakeServer([reviewCard('a', 1)]);
    server.hang('getCard');
    const { screen, completion } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', server });
    fireEvent.press(screen.getByTestId('pas-report-hold'));
    await waitFor(() => expect(completion.complete).toHaveBeenCalledTimes(1));
  });
});

describe('감수: 항목 지시를 보낸 뒤', () => {
  it('입력창이 닫히고 대상이 풀려, 다음 지시 적기는 항목 없는 커멘트로 간다', async () => {
    const card = reviewCard('a', 1, { items: [checkItem({ id: 2, title: '증거를 붙였나' })] });
    const { screen, server } = mount({ cards: [card], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    fireEvent.press(await screen.findByLabelText('2 증거를 붙였나 고칠 점 남기기'));
    await waitFor(() => expect(screen.getByTestId('card-comment-target')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '첫 지시');
    fireEvent.press(screen.getByLabelText('커멘트 보내기'));
    await waitFor(() => expect(server.calls.filter(call => call.name === 'addCardComment')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('pas-report-composer')).toBeNull());
    expect(screen.queryByTestId('card-comment-target')).toBeNull();
    fireEvent.press(screen.getByTestId('pas-report-open-composer'));
    expect(screen.queryByTestId('card-comment-target')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '다음 글');
    fireEvent.press(screen.getByLabelText('커멘트 보내기'));
    await waitFor(() => expect(server.calls.filter(call => call.name === 'addCardComment')).toHaveLength(2));
    const second = server.calls.filter(call => call.name === 'addCardComment')[1].args[1] as Record<string, unknown>;
    expect(second).toMatchObject({ body: '다음 글' });
    expect(second).not.toHaveProperty('itemId');
  });
});

describe('사소: 카드를 오가도 스레드의 지역 상태가 따라가지 않는다', () => {
  it('한 카드에서 펼친 「원 요청」은 요청 항목 id가 같은 다른 카드에서 접힌 채 선다', async () => {
    const long = Array.from({ length: 9 }, (_, index) => `요청 ${index + 1}줄`).join('\n');
    const { screen, server } = mount({ cards: [reviewCard('a', 1, { request: long }), reviewCard('b', 2, { request: long })],
      entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', width: 820 });
    // 두 번째 카드의 상세를 미리 읽어 두어, 오가는 동안 로딩 화면이 끼어 상태를 비워 주지 않게 한다.
    await act(async () => { await refreshCard(server.api, 'b'); });
    fireEvent.press(await screen.findByLabelText('원 요청 더 보기'));
    expect(screen.getByLabelText('원 요청 접기')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pas-report-row-b'));
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('2번 카드'));
    expect(screen.getByLabelText('원 요청 더 보기')).toBeTruthy();
    expect(screen.queryByLabelText('원 요청 접기')).toBeNull();
  });
});

describe('결함 5, 6, 7: 모양', () => {
  it('5: 결재 상자 한 줄의 채운 단추와 테두리 단추가 같은 높이(채운 단추 최소 높이 = 테두리 단추 안쪽 + 바깥 가는 테두리)다', async () => {
    const { screen } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    await waitFor(() => expect(screen.getByTestId('pas-report-complete')).toBeTruthy());
    const minHeight = (id: string) => flat(screen.getByTestId(id)).minHeight as number;
    const filled = minHeight('pas-report-complete');
    const outline = (id: string) => minHeight(id) + 2 * StyleSheet.hairlineWidth;
    expect(filled).toBeGreaterThan(48);
    expect(outline('pas-report-hold')).toBeCloseTo(filled, 5);
    expect(outline('pas-report-open-composer')).toBeCloseTo(filled, 5);
    fireEvent.press(screen.getByTestId('pas-report-snooze-trigger'));
    expect(outline('pas-report-snooze-hour')).toBeCloseTo(filled, 5);
  });

  it('6: 선택지 목록의 왼쪽 막대는 이정표 점과 같은 색이고, 권함은 이름과 갈린 글이다', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const { screen } = mount({ cards: [card], details: { q: { questions: [openQuestion({ id: 'q1', cardId: 'q' })] } }, entries: [questionEntry('q', 7)], startCardId: 'q' });
    const list = await screen.findByTestId('pas-report-question-options-q1');
    const bar = flat(list.children[0] as never);
    expect(bar.borderLeftWidth).toBe(4);
    const recommended = within(list).getByText('권함', { exact: false });
    expect(recommended.props.children).toBe('  권함');
    const label = within(list).getAllByText(/^가/)[0];
    expect(flat(recommended).color).not.toBe(flat(label).color);
    // 막대 색이 구분선 색(바탕과 거의 같음)으로 돌아가면 대비가 다시 1.5:1 아래로 떨어진다.
    expect(bar.borderLeftColor).not.toBe(flat(screen.getByTestId('pas-report-decide')).borderTopColor);
  });

  it('7: 카드 목록 실패의 다시 시도는 실패 안내 글과 같은 시작선 안쪽 여백에 선다', async () => {
    const ok = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 820 });
    await waitFor(() => expect(ok.screen.getByTestId('pas-report-rail-hold')).toBeTruthy());
    const inset = flat(ok.screen.getByTestId('pas-report-rail-hold')).paddingHorizontal;
    ok.screen.unmount();
    const server = fakeServer([reviewCard('a', 1)]);
    server.failNext('listCards');
    const bad = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 820, server });
    await waitFor(() => expect(bad.screen.getByTestId('pas-report-rail-error')).toBeTruthy());
    expect(flat(bad.screen.getByTestId('pas-report-rail-error')).paddingHorizontal).toBe(inset);
    expect(inset).toBeGreaterThan(0);
  });
});

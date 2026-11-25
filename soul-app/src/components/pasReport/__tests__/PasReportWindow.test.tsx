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

import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { CardDto } from '../../../api/cardTypes';
import { cardFixture } from '../../../test-support/cards';
import { checkItem, fakeServer, openQuestion, reportEntry, reviewCard } from '../../../test-support/pas-report';
import { labels, resetCards, mount, questionEntry, reviewEntry, settle } from '../../../test-support/pas-report-window-harness';

beforeEach(resetCards);

describe('레일 묶음과 머리줄', () => {
  it('820pt 이상은 고정 레일이고 그 아래는 「안건 목록」 단추가 여는 서랍이다', async () => {
    const a = reviewCard('a', 1), b = reviewCard('b', 2);
    const narrow = mount({ cards: [a, b], entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', width: 819 });
    await settle();
    expect(narrow.screen.queryByTestId('pas-report-rail-fixed')).toBeNull();
    expect(narrow.screen.queryByTestId('pas-report-rail')).toBeNull();
    fireEvent.press(narrow.screen.getByTestId('pas-report-open-rail'));
    expect(narrow.screen.getByTestId('pas-report-drawer')).toBeTruthy();
    expect(within(narrow.screen.getByTestId('pas-report-drawer')).getByTestId('pas-report-row-b')).toBeTruthy();
    // 서랍에서 고르면 서랍이 닫히고 그 안건이 선다.
    fireEvent.press(narrow.screen.getByTestId('pas-report-row-b'));
    expect(narrow.screen.queryByTestId('pas-report-drawer')).toBeNull();
    expect(narrow.screen.getByTestId('pas-report-title').props.children).toBe('2번 카드');
    narrow.screen.unmount();
    const wide = mount({ cards: [a, b], entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'a', width: 820 });
    await settle();
    expect(wide.screen.getByTestId('pas-report-rail-fixed')).toBeTruthy();
    expect(wide.screen.queryByTestId('pas-report-open-rail')).toBeNull();
    expect(wide.screen.getByLabelText('카드 패널 열기')).toBeTruthy();
    expect(wide.screen.getByLabelText('보고 창 닫기')).toBeTruthy();
  });

  it('결재 대기, 진행 중, 미뤄 둠으로 묶고 보류함 개수는 on_hold 카드 수다', async () => {
    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    const cards = [reviewCard('a', 1), reviewCard('b', 2, { snoozedUntil: soon }), cardFixture({ id: 'r', number: 3, status: 'running', title: '3번 실행' }),
      cardFixture({ id: 'h1', number: 4, status: 'on_hold' }), cardFixture({ id: 'h2', number: 5, status: 'on_hold' })];
    const { screen } = mount({ cards, entries: [reviewEntry('a', 1), reviewEntry('b', 2), reportEntry({ key: 'pas-own', card_id: undefined as unknown as string })], startCardId: 'a', width: 820 });
    await waitFor(() => expect(screen.getByTestId('pas-report-rail-hold').props.children.join('')).toBe('보류함 2개'));
    expect(within(screen.getByTestId('pas-report-rail-결재 대기')).queryByTestId('pas-report-row-a')).toBeTruthy();
    expect(within(screen.getByTestId('pas-report-rail-결재 대기')).queryByTestId('pas-report-row-b')).toBeNull();
    expect(within(screen.getByTestId('pas-report-rail-미뤄 둠')).queryByTestId('pas-report-row-b')).toBeTruthy();
    expect(within(screen.getByTestId('pas-report-rail-진행 중')).queryByTestId('pas-report-row-r')).toBeTruthy();
    // card_id 없는 PAS 자체 장은 안건이 아니다.
    expect(screen.queryByTestId('pas-report-row-undefined')).toBeNull();
    expect(screen.queryByTestId('pas-report-rail-처리됨')).toBeNull();
  });

  it('카드 목록을 못 읽으면 개수를 0으로 보이지 않고 실패와 다시 시도를 둔다', async () => {
    const server = fakeServer([reviewCard('a', 1)]);
    server.failNext('listCards');
    const { screen } = mount({ cards: [reviewCard('a', 1)], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 820, server });
    await waitFor(() => expect(screen.getByTestId('pas-report-rail-error')).toBeTruthy());
    expect(screen.queryByTestId('pas-report-rail-hold')).toBeNull();
    fireEvent.press(screen.getByLabelText('카드 목록 다시 시도'));
    await waitFor(() => expect(screen.getByTestId('pas-report-rail-hold')).toBeTruthy());
  });

  it('미룬 시각이 지나면 화면 타이머로 결재 대기에 돌아온다(서버 호출 없음)', async () => {
    const soon = new Date(Date.now() + 400).toISOString();
    const { screen, server } = mount({ cards: [reviewCard('a', 1, { snoozedUntil: soon }), reviewCard('b', 2)],
      entries: [reviewEntry('a', 1), reviewEntry('b', 2)], startCardId: 'b', width: 820 });
    await waitFor(() => expect(within(screen.getByTestId('pas-report-rail-미뤄 둠')).queryByTestId('pas-report-row-a')).toBeTruthy());
    const before = server.calls.length;
    await waitFor(() => expect(within(screen.getByTestId('pas-report-rail-결재 대기')).queryByTestId('pas-report-row-a')).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByTestId('pas-report-rail-미뤄 둠')).toBeNull();
    expect(server.calls.slice(before).filter(call => call.name === 'updateCard')).toHaveLength(0);
  });
});

describe('안건 종류별 결재 단추', () => {
  const groups = (screen: ReturnType<typeof render>) => ({
    primary: labels(within(screen.getByTestId('pas-report-stamps-primary'))),
    secondary: screen.queryByTestId('pas-report-stamps-secondary') ? labels(within(screen.getByTestId('pas-report-stamps-secondary'))) : [],
  });

  it('질문: 선택지는 왼쪽 묶음, 다르게 답하기와 되묻기와 답변 미루기는 오른쪽 묶음이고 선택지는 스레드에 없다', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const question = openQuestion({ id: 'q1', cardId: 'q' });
    const { screen } = mount({ cards: [card], details: { q: { questions: [question] } }, entries: [questionEntry('q', 7)], startCardId: 'q' });
    await waitFor(() => expect(screen.getByTestId('pas-report-question-q1')).toBeTruthy());
    expect(groups(screen)).toEqual({ primary: ['가', '나'], secondary: ['다르게 답하기', '되묻기', '답변 미루기'] });
    // 선택지를 고르는 곳은 결재 상자 한 곳이다. 스레드에는 눌리는 선택지도 눌리는 모양의 죽은 단추도 없다.
    expect(screen.getAllByLabelText('가')).toHaveLength(1);
    expect(screen.queryByTestId('card-question-choice-0')).toBeNull();
    // 선택지 설명은 읽힌다.
    expect(screen.getByText('가는 빠릅니다.')).toBeTruthy();
    expect(screen.getByText('나는 안전합니다.')).toBeTruthy();
  });

  it('부탁: 채운 「했어」가 왼쪽 묶음 첫 자리, 되묻기와 답변 미루기가 오른쪽 묶음', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 부탁', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const question = openQuestion({ id: 'q1', cardId: 'q', kind: 'request', options: null, optionDetails: undefined });
    const { screen } = mount({ cards: [card], details: { q: { questions: [question] } }, entries: [questionEntry('q', 7, 'q1', { question_kind: 'request' })], startCardId: 'q' });
    await waitFor(() => expect(screen.getByTestId('pas-report-done')).toBeTruthy());
    expect(groups(screen)).toEqual({ primary: ['했어'], secondary: ['되묻기', '답변 미루기'] });
  });

  it('검수, 막힘, 진행 중, 검증 대기', async () => {
    const run = async (card: CardDto, entry: ReturnType<typeof reportEntry>, expected: ReturnType<typeof groups>) => {
      const { screen } = mount({ cards: [card], entries: [entry], startCardId: card.id });
      await waitFor(() => expect(screen.getByTestId('pas-report-stamps-primary') ?? screen.getByTestId('pas-report-stamps-secondary')).toBeTruthy());
      expect(groups(screen)).toEqual(expected);
      screen.unmount();
    };
    await run(reviewCard('a', 1), reviewEntry('a', 1), { primary: ['완료', '보류'], secondary: ['지시 적기', '답변 미루기'] });
    await run(cardFixture({ id: 'b', number: 2, status: 'blocked', assigneeKind: 'session', assigneeSessionId: 's-main' }),
      reviewEntry('b', 2, { card_status: 'blocked' }), { primary: ['확인했어'], secondary: ['지시 적기', '답변 미루기'] });
    // 진행 중과 검증 대기 카드는 카드 목록에서 온 안건이라 지시 적기뿐이다.
    const running = cardFixture({ id: 'r', number: 3, status: 'running', title: '3번 실행', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const only = mount({ cards: [running], entries: [], startCardId: 'r' });
    await waitFor(() => expect(only.screen.getByTestId('pas-report-stamps-secondary')).toBeTruthy());
    expect(labels(within(only.screen.getByTestId('pas-report-stamps-secondary')))).toEqual(['지시 적기']);
    expect(only.screen.queryByTestId('pas-report-stamps-primary')).toBeNull();
  });

  it('미뤄 둔 안건은 답변 미루기 자리에 미루기 해제를 두고, 해제는 snoozedUntil null을 보낸다', async () => {
    const snoozedUntil = new Date(Date.now() + 5 * 3600_000).toISOString();
    const card = reviewCard('a', 1, { snoozedUntil });
    const { screen, server } = mount({ cards: [card], entries: [reviewEntry('a', 1)], startCardId: 'a', width: 820 });
    await waitFor(() => expect(screen.getByTestId('pas-report-unsnooze')).toBeTruthy());
    expect(groups(screen).secondary).toEqual(['지시 적기', '미루기 해제']);
    expect(screen.queryByLabelText('답변 미루기')).toBeNull();
    fireEvent.press(screen.getByTestId('pas-report-unsnooze'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'updateCard')).toBe(true));
    const patch = server.calls.find(call => call.name === 'updateCard')!.args;
    expect(patch[0]).toBe('a');
    expect(patch[1]).toEqual({ snoozedUntil: null });
    expect(typeof patch[2]).toBe('number');
  });

  it('안건이 없으면 결재 상자를 그리지 않는다', async () => {
    const { screen } = mount({ cards: [], entries: [], startCardId: null, width: 820 });
    await settle();
    expect(screen.queryByTestId('pas-report-decide')).toBeNull();
    expect(screen.getByTestId('pas-report-thread-empty')).toBeTruthy();
  });
});

describe('질문에 답하는 요청', () => {
  const setup = async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main' });
    const question = openQuestion({ id: 'q1', cardId: 'q' });
    const harness = mount({ cards: [card, reviewCard('z', 9)], details: { q: { questions: [question] } },
      entries: [questionEntry('q', 7), reviewEntry('z', 9)], startCardId: 'q', width: 820 });
    await waitFor(() => expect(harness.screen.getByTestId('pas-report-ask-back')).toBeTruthy());
    return harness;
  };

  it('선택지를 누르면 선택 답을 보내고 그 안건을 처리됨으로 옮겨 다음 안건으로 넘어간다', async () => {
    const { screen, server } = await setup();
    fireEvent.press(screen.getByLabelText('가'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'answerCardQuestion')).toBe(true));
    expect(server.calls.find(call => call.name === 'answerCardQuestion')!.args.slice(0, 3)).toEqual(['q', 'q1', expect.objectContaining({ mode: 'choice', option: '가' })]);
    await waitFor(() => expect(screen.getByTestId('pas-report-title').props.children).toBe('9번 카드'));
    expect(within(screen.getByTestId('pas-report-rail-처리됨')).queryByTestId('pas-report-row-q')).toBeTruthy();
  });

  it('다르게 답하기는 글 답으로 질문을 종료하고, 되묻기는 questionId를 붙여 질문을 유지한다', async () => {
    const { screen, server } = await setup();
    fireEvent.press(screen.getByTestId('pas-report-answer-freely'));
    await waitFor(() => expect(screen.getByPlaceholderText('다르게 답하기')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('다르게 답하기'), '둘 다 하지 말자');
    fireEvent.press(screen.getByLabelText('답 보내기'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'answerCardQuestion')).toBe(true));
    expect(server.calls.find(call => call.name === 'answerCardQuestion')!.args[2]).toMatchObject({ mode: 'text', answer: '둘 다 하지 말자' });
    expect(server.calls.some(call => call.name === 'addCardComment')).toBe(false);
  });

  it('되묻기는 커멘트에 questionId를 붙여 보내고 답 요청은 보내지 않는다', async () => {
    const { screen, server } = await setup();
    fireEvent.press(screen.getByTestId('pas-report-ask-back'));
    await waitFor(() => expect(screen.getByPlaceholderText('물어볼 것')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('물어볼 것'), '왜 가가 빠른가요?');
    fireEvent.press(screen.getByLabelText('답 보내기'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'addCardComment')).toBe(true));
    expect(server.calls.find(call => call.name === 'addCardComment')!.args[1]).toMatchObject({ body: '왜 가가 빠른가요?', questionId: 'q1' });
    expect(server.calls.find(call => call.name === 'addCardComment')!.args[1]).not.toHaveProperty('itemId');
    expect(server.calls.some(call => call.name === 'answerCardQuestion')).toBe(false);
  });

  it('질문이 열려 있는 동안 항목 지시는 questionId와 「N번 항목: 」 머리글로 간다', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main',
      items: [checkItem({ id: 3, title: '표를 고쳤나' })] });
    const question = openQuestion({ id: 'q1', cardId: 'q' });
    const { screen, server } = mount({ cards: [card], details: { q: { questions: [question] } }, entries: [questionEntry('q', 7)], startCardId: 'q' });
    const fix = await screen.findByLabelText('3 표를 고쳤나 고칠 점 남기기');
    fireEvent.press(fix);
    await waitFor(() => expect(screen.getByTestId('card-comment-target')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '다시 확인해 줘');
    fireEvent.press(screen.getByLabelText('커멘트 보내기'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'addCardComment')).toBe(true));
    const body = server.calls.find(call => call.name === 'addCardComment')!.args[1] as Record<string, unknown>;
    expect(body).toMatchObject({ body: '3번 항목: 다시 확인해 줘', questionId: 'q1' });
    expect(body).not.toHaveProperty('itemId');
  });

  it('항목 대상이 잡힌 채 되묻기를 열면 대상을 풀어 알림줄과 보내는 곳이 어긋나지 않는다', async () => {
    const card = cardFixture({ id: 'q', number: 7, status: 'blocked', blockedKind: 'question', title: '7번 질문', assigneeKind: 'session', assigneeSessionId: 's-main',
      items: [checkItem({ id: 3, title: '표를 고쳤나' })] });
    const { screen } = mount({ cards: [card], details: { q: { questions: [openQuestion({ id: 'q1', cardId: 'q' })] } }, entries: [questionEntry('q', 7)], startCardId: 'q' });
    fireEvent.press(await screen.findByLabelText('3 표를 고쳤나 고칠 점 남기기'));
    await waitFor(() => expect(screen.getByTestId('card-comment-target')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pas-report-ask-back'));
    await waitFor(() => expect(screen.getByTestId('card-question-target')).toBeTruthy());
    expect(screen.queryByTestId('card-comment-target')).toBeNull();
  });

  it('질문이 없을 때 항목 지시는 커멘트에 itemId를 붙인다', async () => {
    const card = reviewCard('a', 1, { items: [checkItem({ id: 2, title: '증거를 붙였나' })] });
    const { screen, server } = mount({ cards: [card], entries: [reviewEntry('a', 1)], startCardId: 'a' });
    fireEvent.press(await screen.findByLabelText('2 증거를 붙였나 고칠 점 남기기'));
    await waitFor(() => expect(screen.getByTestId('card-comment-target')).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '다시');
    fireEvent.press(screen.getByLabelText('커멘트 보내기'));
    await waitFor(() => expect(server.calls.some(call => call.name === 'addCardComment')).toBe(true));
    expect(server.calls.find(call => call.name === 'addCardComment')!.args[1]).toMatchObject({ body: '다시', itemId: 2 });
    expect(server.calls.find(call => call.name === 'addCardComment')!.args[1]).not.toHaveProperty('questionId');
  });
});


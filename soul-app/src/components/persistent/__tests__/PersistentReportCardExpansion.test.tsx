jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'expansion-operation-id') }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockOpenCardLink = jest.fn();
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => mockOpenCardLink }));

import React from 'react';
import { Keyboard, ScrollView, View } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { CardCheckItem, CardComment, CardDetail } from '../../../api/cardTypes';
import type { PersistentReportEntry } from '../../../api/types';
import { useAuthStore } from '../../../store/authStore';
import { useCardStore } from '../../../store/cardStore';
import { useDraftStore } from '../../../store/draftStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { cardFixture } from '../../../test-support/cards';
import { PersistentReportCardExpansion } from '../PersistentReportCardExpansion';
import { PersistentReportPager } from '../PersistentReportPager';
import { ChatUiControllerProvider } from '../../chat-ui/ChatUiControllerProvider';
import { measurePersistentReports } from '../../../test-utils/persistent-report-layout';

jest.mock('../../../theme/useDeviceType', () => ({ useDeviceType: () => 'tabletLandscape', deviceTypeToBaseKey: () => 'tablet' }));

const at = '2026-10-05T08:00:00Z';
const card = cardFixture({ id: 'card-531', number: 531, status: 'review', nodeId: null,
  now: { text: '검수 결과를 확인해 주세요.', turn: 'user', ask: '확인 항목도 살펴봐 주세요.', updatedAt: at, sessionId: 'session-1' } });
const item: CardCheckItem = { id: 1, title: '첫 확인 항목', state: 'done', result: '반영했습니다.', evidence: [], caveat: null,
  rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: at, display: 'reported' };
const entry: PersistentReportEntry = { key: 'card_531', kind: 'see', title: '검수 결과', card_numbers: [531], context: '결과를 봐 주세요.',
  action: '', options: [], state: 'open', answer: '', updated_at: at };
function makeDetail(): CardDetail {
  return { card: { ...card, items: [item] }, reports: [], questions: [
    { id: 'question-1', cardId: card.id, sessionId: 'session-1', text: '진행할까요?', options: ['네'], answer: null, askedAt: at },
  ], sessions: [], nowHistory: [], comments: [
    { id: 'old', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body: '오래된 커멘트', createdAt: '2026-10-05T07:00:00Z' },
    { id: 'recent-1', cardId: card.id, authorKind: 'agent', authorId: null, sessionId: null, kind: 'comment', body: '최근 커멘트 하나', createdAt: '2026-10-05T07:30:00Z' },
    { id: 'recent-2', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body: '최근 커멘트 둘', createdAt: '2026-10-05T07:45:00Z' },
  ] };
}

beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'expansion@example.com' })).toString('base64url')}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://expansion.test' });
  useDraftStore.setState({ drafts: {} });
  useCardStore.setState({ rows: {}, details: {}, pendingItemConfirmations: {} });
  mockOpenCardLink.mockReset();
});

test('resolves a single card number, shows only its latest comments, and keeps item then question then card send routing', async () => {
  let detail = makeDetail();
  const saved: CardComment[] = [];
  const apiMock = {
    listCards: jest.fn().mockResolvedValue({ cards: [{ ...card, number: 531 }] }),
    getCard: jest.fn().mockImplementation(async () => ({ ...detail, card: { ...detail.card }, questions: [...detail.questions], comments: [...(detail.comments ?? [])] })),
    addCardComment: jest.fn().mockImplementation(async (cardId, input) => {
      const comment: CardComment = { id: input.idempotencyKey, cardId, authorKind: 'user', authorId: null, sessionId: null,
        kind: 'comment', ...(input.itemId === undefined ? {} : { itemId: input.itemId }), body: input.body, createdAt: new Date().toISOString() };
      saved.push(comment); detail = { ...detail, comments: [...(detail.comments ?? []), comment] }; return comment;
    }),
    answerCardQuestion: jest.fn().mockImplementation(async (_cardId, questionId, answer) => {
      detail = { ...detail, questions: detail.questions.map(question => question.id === questionId
        ? { ...question, answer, answeredAt: new Date().toISOString() } : question) };
      return { folderId: detail.card.folderId, card: detail.card };
    }),
  };
  const api = apiMock as unknown as ApiClient;
  const screen = render(<PersistentReportCardExpansion api={api} entry={entry} />);
  await waitFor(() => expect(screen.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());
  expect(apiMock.listCards).toHaveBeenCalledWith(undefined, { includeCompleted: true });
  expect(apiMock.getCard).toHaveBeenCalledWith(card.id);
  expect(screen.getByText('최근 커멘트 하나')).toBeTruthy();
  expect(screen.getByText('최근 커멘트 둘')).toBeTruthy();
  expect(screen.queryByText('오래된 커멘트')).toBeNull();

  fireEvent.press(screen.getByTestId('card-check-item-1-fix'));
  expect(screen.getByTestId('card-comment-target')).toBeTruthy();
  fireEvent.changeText(screen.getByPlaceholderText('질문에 답하기'), '항목을 고쳐 주세요.');
  await act(async () => fireEvent.press(screen.getByLabelText('답 보내기')));
  expect(apiMock.addCardComment).toHaveBeenCalledWith(card.id, expect.objectContaining({ body: '항목을 고쳐 주세요.', itemId: 1 }));
  expect(apiMock.answerCardQuestion).not.toHaveBeenCalled();

  fireEvent.changeText(screen.getByPlaceholderText('질문에 답하기'), '네, 진행해 주세요.');
  await act(async () => fireEvent.press(screen.getByLabelText('답 보내기')));
  await waitFor(() => expect(apiMock.answerCardQuestion).toHaveBeenCalledWith(card.id, 'question-1', '네, 진행해 주세요.', expect.any(String)));
  expect(screen.getByPlaceholderText('커멘트')).toBeTruthy();

  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '일반 카드 커멘트');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(apiMock.addCardComment).toHaveBeenLastCalledWith(card.id, { body: '일반 카드 커멘트', idempotencyKey: expect.any(String) });

  await act(async () => fireEvent.press(screen.getByLabelText('카드 열기')));
  expect(mockOpenCardLink).toHaveBeenCalledWith('/?card=card-531');
});

test('omits the checklist and comment timeline when both have no rows', async () => {
  const empty = makeDetail();
  empty.card = { ...empty.card, items: [] };
  empty.comments = [];
  const api = { getCard: jest.fn().mockResolvedValue(empty) } as unknown as ApiClient;
  const screen = render(<PersistentReportCardExpansion api={api} entry={{ ...entry, card_id: card.id }} />);

  await waitFor(() => expect(screen.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());
  expect(screen.queryByTestId('card-check-items')).toBeNull();
  expect(screen.queryByTestId('card-timeline')).toBeNull();
  expect(screen.getByLabelText('카드 열기')).toBeTruthy();
  expect(screen.getByTestId('card-comment-composer')).toBeTruthy();
});

test('shows a folded card read error and retries in place', async () => {
  const detail = makeDetail();
  const api = { getCard: jest.fn()
    .mockRejectedValueOnce(new Error('Request failed with status 503'))
    .mockResolvedValueOnce(detail) } as unknown as ApiClient;
  const screen = render(<PersistentReportCardExpansion api={api} entry={{ ...entry, card_id: card.id }} />);

  await waitFor(() => expect(screen.getByText('카드를 불러오지 못했습니다.')).toBeTruthy());
  expect(screen.queryByText('Request failed with status 503')).toBeNull();
  expect(screen.getByTestId('persistent-report-card-retry')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('persistent-report-card-retry')); });
  await waitFor(() => expect(screen.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());
  expect(api.getCard).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('카드를 불러오지 못했습니다.')).toBeNull();
});

test.each([false, true])('focused card composer follows reading growth and viewport changes (bubble=%s)', async bubble => {
  const api = { getCard: jest.fn().mockResolvedValue(makeDetail()) } as unknown as ApiClient;
  const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
  const screen = render(<ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
    <PersistentReportPager entries={[{ ...entry, card_id: card.id }]} index={0} api={api} bubble={bubble} maxHeight={440}
      onSelect={jest.fn()} onDismiss={jest.fn()} onFocusComposer={jest.fn()}
      renderCardDetails={item => <PersistentReportCardExpansion api={api} entry={item} />} />
  </ChatUiControllerProvider>);
  measurePersistentReports(screen);
  fireEvent.press(screen.getByTestId('report-title'));
  await waitFor(() => expect(screen.getByPlaceholderText('질문에 답하기')).toBeTruthy());
  const reading = screen.getByTestId('report-scroll');
  fireEvent(reading, 'contentSizeChange', 318, 1000);
  expect(scrollToEnd).not.toHaveBeenCalled();
  fireEvent(screen.getByPlaceholderText('질문에 답하기'), 'focus');
  await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());
  scrollToEnd.mockClear();
  fireEvent.changeText(screen.getByPlaceholderText('질문에 답하기'), '여러 줄\n커멘트를\n길게\n입력합니다.');
  fireEvent(reading, 'contentSizeChange', 318, 1184);
  await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());
  scrollToEnd.mockClear();
  fireEvent(reading, 'layout', { nativeEvent: { layout: { height: 240 } } });
  await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());
  fireEvent(screen.getByPlaceholderText('질문에 답하기'), 'blur');
  scrollToEnd.mockClear();
  fireEvent(reading, 'contentSizeChange', 318, 1200);
  expect(scrollToEnd).not.toHaveBeenCalled();
  screen.unmount();
  scrollToEnd.mockRestore();
});

test('vertical report list keeps a focused earlier card visible instead of jumping to the last card', async () => {
  const api = { getCard: jest.fn().mockResolvedValue(makeDetail()) } as unknown as ApiClient;
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  const entries = [{ ...entry, card_id: card.id }, { ...entry, key: 'card_532', card_id: 'card-532' }];
  const screen = render(<ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
    <PersistentReportPager entries={entries} index={0} api={api} verticalList expandedKey={entry.key} maxHeight={440}
      onSelect={jest.fn()} onDismiss={jest.fn()} onFocusComposer={jest.fn()}
      renderCardDetails={item => <PersistentReportCardExpansion api={api} entry={item} />} />
  </ChatUiControllerProvider>);
  await waitFor(() => expect(screen.getByPlaceholderText('질문에 답하기')).toBeTruthy());
  fireEvent(screen.getByTestId('report-track'), 'layout', { nativeEvent: { layout: { width: 318, height: 300 } } });
  fireEvent(screen.getByTestId('report-list-entry-card_531'), 'layout', { nativeEvent: { layout: { y: 40, height: 400 } } });
  fireEvent(screen.getByPlaceholderText('질문에 답하기'), 'focus');
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 140, animated: false }));
  screen.unmount();
  scrollTo.mockRestore();
});

test('tablet inline band compacts for the keyboard unless card details are expanded', async () => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const keyboard = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
    const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks);
    return { remove: () => { callbacks.delete(callback); } } as ReturnType<typeof Keyboard.addListener>;
  });
  const visible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  const event = { duration: 250, easing: 'keyboard', isEventFromThisApp: true,
    endCoordinates: { screenX: 0, screenY: 422, width: 1180, height: 398 } };
  const emit = (name: string) => act(() => { for (const callback of listeners.get(name) ?? []) callback(event); });
  const entry: PersistentReportEntry = { key: 'card_531', kind: 'see', title: '검수 결과', card_numbers: [531],
    card_id: card.id, context: '확인해 주세요.', action: '', options: [], state: 'open', answer: '', updated_at: at };
  const entries: PersistentReportEntry[] = [
    { ...entry, kind: 'see', card_numbers: [531], card_id: card.id, title: '검수 결과' },
    { ...entry, key: 'card_532', card_numbers: [532], card_id: 'card-532', title: '다음 검수 결과' },
  ];
  const screen = render(<ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
    <PersistentReportPager entries={entries} index={0} api={{ getCard: jest.fn().mockResolvedValue(makeDetail()) } as unknown as ApiClient}
      bubble={false} maxHeight={440} onSelect={jest.fn()} onDismiss={jest.fn()} onFocusComposer={jest.fn()}
      renderCardDetails={selected => <View testID={`expanded-${selected.key}`} />} />
  </ChatUiControllerProvider>);
  measurePersistentReports(screen, { width: 318 });

  emit('keyboardWillShow'); emit('keyboardDidShow');
  measurePersistentReports(screen, { width: 318 });
  await waitFor(() => expect(screen.queryByTestId('report-nav', { includeHiddenElements: true })).toBeNull());
  emit('keyboardWillHide'); emit('keyboardDidHide');
  measurePersistentReports(screen, { width: 318 });
  await waitFor(() => expect(screen.getByTestId('report-nav', { includeHiddenElements: true })).toBeTruthy());

  emit('keyboardWillShow'); emit('keyboardDidShow');
  measurePersistentReports(screen, { width: 318 });
  await waitFor(() => expect(screen.queryByTestId('report-nav', { includeHiddenElements: true })).toBeNull());
  await waitFor(() => expect(screen.getByTestId('report-deck', { includeHiddenElements: true }).props.pointerEvents).toBe('auto'));
  fireEvent.press(screen.getAllByTestId('report-title', { includeHiddenElements: true })[0]);
  await waitFor(() => expect(screen.getByTestId('expanded-card_531', { includeHiddenElements: true })).toBeTruthy());
  expect(screen.getByTestId('report-nav', { includeHiddenElements: true })).toBeTruthy();

  screen.unmount();
  visible.mockRestore(); keyboard.mockRestore();
});

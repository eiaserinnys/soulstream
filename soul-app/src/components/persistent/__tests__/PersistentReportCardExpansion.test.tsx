jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'expansion-operation-id') }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockOpenCardLink = jest.fn();
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => mockOpenCardLink }));

import React from 'react';
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

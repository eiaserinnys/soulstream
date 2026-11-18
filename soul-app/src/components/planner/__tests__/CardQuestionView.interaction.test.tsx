jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'question-operation-id') }));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { CardQuestion } from '../../../api/cardTypes';
import { CardQuestionView } from '../CardQuestionView';

const question: CardQuestion = {
  id: 'question-1', cardId: 'card-1', sessionId: 'session-1', text: '진행할까요?',
  options: null, answer: null, askedAt: '2026-10-05T08:00:00Z',
};

test('답변을 보내는 동안 확인 단추는 busy로 남아 누름을 무시하고 초점을 잃지 않는다', async () => {
  const answerCardQuestion = jest.fn(() => new Promise<never>(() => undefined));
  const screen = render(<CardQuestionView api={{ answerCardQuestion } as unknown as ApiClient} question={question} />);
  fireEvent.changeText(screen.getByLabelText('질문 답변'), '네');
  await act(async () => { fireEvent.press(screen.getByLabelText('답변 확인')); });
  const button = screen.getByLabelText('답변 확인');
  expect(answerCardQuestion).toHaveBeenCalledTimes(1);
  expect(button.props.disabled).toBeFalsy();
  expect(button.props.accessibilityState).toMatchObject({ busy: true });
  await act(async () => { fireEvent.press(button); });
  expect(answerCardQuestion).toHaveBeenCalledTimes(1);
});

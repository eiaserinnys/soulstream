import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { CardComment } from '../../../api/cardTypes';
import { CardNotes } from '../CardNotes';

jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: { markdown: string }) =>
  require('react').createElement(require('react-native').Text, null, markdown) }));
jest.mock('../../events/CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: ({ markdown }: { markdown: string }) =>
  require('react').createElement(require('react-native').Text, null, markdown) }));

const notes: CardComment[] = Array.from({ length: 7 }, (_, index) => ({ id: `note-${index + 1}`, cardId: 'card-1',
  authorKind: 'agent', authorId: 'roselin', sessionId: null, kind: 'note', body: `노트 ${index + 1}`,
  createdAt: `2026-10-0${index + 1}T00:00:00Z` }));

test('인계 요약을 먼저 보이고 최근 다섯 노트와 앞선 노트를 시간순으로 접는다', () => {
  const screen = render(<CardNotes brief="# 인계 요약" notes={notes} sessions={[]} />);
  expect(screen.getByText('# 인계 요약')).toBeTruthy();
  expect(screen.getByText('노트 3')).toBeTruthy();
  expect(screen.getByText('노트 7')).toBeTruthy();
  expect(screen.queryByText('노트 1')).toBeNull();
  fireEvent.press(screen.getByLabelText('앞선 노트 2건 펼치기'));
  expect(screen.getByText('노트 1')).toBeTruthy();
  expect(screen.getByText('노트 2')).toBeTruthy();
});


test('기록 줄은 작성자와 담당, HH:MM을 보이고 담당 세션이 비어 있으면 담당 꼬리표를 만들지 않는다', () => {
  const note = { ...notes[0], sessionId: 's1', createdAt: '2026-10-04T06:58:00' };
  const sessions = [{ agentSessionId: 's1', agentName: '로젤린', displayName: null, status: 'idle', createdAt: '', updatedAt: '' }];
  const screen = render(<CardNotes brief="인계" notes={[note]} sessions={sessions} assigneeSessionId="s1" />);
  expect(screen.getByText('로젤린')).toBeTruthy();
  expect(screen.getByText('담당')).toBeTruthy();
  expect(screen.getByText('06:58')).toBeTruthy();
  screen.rerender(<CardNotes brief="인계" notes={[{ ...note, sessionId: null }]} sessions={sessions} assigneeSessionId={null} />);
  expect(screen.queryByText('담당')).toBeNull();
});

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ReviewDialogueOwners } from '../ReviewDialogueOwners';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
// Unrelated owner imports bring native icons into Jest; the owned-agent panel stays real.
jest.mock('../../components/chat/ClaudeRuntimeTasksStrip', () => ({ ClaudeRuntimeTasksStrip: () => null, ClaudeRuntimeTaskOutputModal: () => null }));
jest.mock('../../components/planner/CardBoardWorkspace', () => ({ CardBoardWorkspace: () => null }));

test('opens the real owned-agent editor and one-time key through the registered fixture owner', async () => {
  const screen = render(<ReviewDialogueOwners opened="owned-agents" onClose={() => {}} />);
  await screen.findByText('아직 등록한 에이전트가 없습니다.');
  fireEvent.press(screen.getByLabelText('에이전트 추가'));
  fireEvent.changeText(screen.getByLabelText('에이전트 이름'), '공개 검수 도우미');
  fireEvent.press(screen.getByLabelText('저장'));
  await screen.findByText('공개 검수 도우미');
  fireEvent.press(screen.getByLabelText('새 키 발급'));
  await screen.findByText('FAKE-REVIEW-KEY-DO-NOT-USE');
  screen.rerender(<ReviewDialogueOwners opened={null} onClose={() => {}} />);
  expect(screen.queryByText('FAKE-REVIEW-KEY-DO-NOT-USE')).toBeNull();
  screen.rerender(<ReviewDialogueOwners opened="owned-agents" onClose={() => {}} />);
  await screen.findByText('아직 등록한 에이전트가 없습니다.');
  expect(screen.queryByText('FAKE-REVIEW-KEY-DO-NOT-USE')).toBeNull();
});

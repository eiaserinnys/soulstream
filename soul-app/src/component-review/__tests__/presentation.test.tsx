import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SessionCardView } from '../../components/SessionCardView';
import { ProjectContextEditorView } from '../../components/planner/ProjectContextEditorView';
import { useAuthStore } from '../../store/authStore';

test('실제 세션 행의 검수 버튼은 주입된 로컬 동작만 실행한다', async () => {
  const acknowledge = jest.fn().mockResolvedValue(undefined);
  const request = jest.spyOn(global, 'fetch');
  const screen = render(<SessionCardView session={{
    agentSessionId: 'review-session', displayName: '공개 예시 세션', status: 'completed',
    reviewRequired: true, reviewState: 'needs_review',
    createdAt: '', updatedAt: '', agentPortraitUrl: null,
  }} onPress={jest.fn()} folderName="공개 예시" serverUrl="" jwt={null}
    review={{ acknowledge, inFlight: false }} />);
  await act(async () => fireEvent.press(screen.getByTestId('session-card-review-ack'), { stopPropagation: jest.fn() }));
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  request.mockRestore();
});

test('실제 컨텍스트 편집 표시와 취소·저장 동작을 재사용한다', async () => {
  useAuthStore.setState({ jwt: null });
  const save = jest.fn().mockResolvedValue(undefined);
  const screen = render(<ProjectContextEditorView projectPageId="public" detail={{
    data: { blocks: [{ parentId: null, text: '공개 지침', blockType: 'paragraph', properties: {} }] },
    error: null,
  }} saveProjectContext={save} />);
  fireEvent.press(screen.getByText('편집'));
  fireEvent.changeText(screen.getByPlaceholderText('이 프로젝트의 공통 지침'), '로컬 수정');
  fireEvent.press(screen.getByText('취소'));
  expect(screen.getByTestId('folder-context-read-text').props.children).toBe('공개 지침');
  fireEvent.press(screen.getByText('편집'));
  fireEvent.changeText(screen.getByPlaceholderText('이 프로젝트의 공통 지침'), '저장 예시');
  await act(async () => fireEvent.press(screen.getByText('컨텍스트 저장')));
  expect(save).toHaveBeenCalledWith('public', '저장 예시');
  expect(screen.getByTestId('folder-context-read-text').props.children).toBe('저장 예시');
});

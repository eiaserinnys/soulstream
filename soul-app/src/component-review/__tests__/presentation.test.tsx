import { act, fireEvent, render } from '@testing-library/react-native';
import { SessionCardView } from '../../components/SessionCardView';
import { FolderContextSection } from '../../components/planner/FolderContextSection';
import { createReviewApi } from '../fixtures';
import { dialogueFolders } from '../dialogue-fixtures';
import { withFolderContext } from '../folder-context-fixtures';
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

test('검수 창의 폴더 맥락은 실제 요약 부품과 로컬 데이터만 쓰고 설정은 주입된 동작을 연다', async () => {
  useAuthStore.setState({ jwt: null });
  const openSettings = jest.fn();
  const request = jest.spyOn(global, 'fetch');
  const screen = render(<FolderContextSection api={withFolderContext(createReviewApi()) as never} folders={dialogueFolders}
    folderId="public-child" folderPageId="public-child-page" active onOpenSettings={openSettings} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(screen.getByText(/화면 검수는 아이폰과 아이패드 폭에서 함께 본다\./)).toBeTruthy();
  expect(screen.getByText('soulstream · 프론트엔드 아키텍처 · UI 디자인 기준')).toBeTruthy();
  expect(screen.getByText('공개 예시 에이전트 · public-node · 사용 가능한 예시 모델')).toBeTruthy();
  fireEvent.press(screen.getByText('설정'));
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  request.mockRestore();
});

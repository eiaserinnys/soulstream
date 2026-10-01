import { Alert } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

const mockAcknowledgeSessionReview = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({ acknowledgeSessionReview: mockAcknowledgeSessionReview }),
}));

import { useSessionReviewAcknowledge } from '../useSessionReviewAcknowledge';
import { useAppNoticeStore } from '../../store/appNoticeStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  useAppNoticeStore.setState({ notice: null });
  useSettingsStore.setState({ serverUrl: 'https://server.test' });
  useSessionStore.setState({
    sessions: {
      session: {
        agentSessionId: 'session', displayName: 'session', status: 'completed',
        reviewRequired: true, reviewState: 'needs_review',
        createdAt: '', updatedAt: '',
      },
    },
  });
});

test.each([
  ['acknowledged', '확인 처리했습니다.'],
  ['already_acknowledged', '이미 확인된 결과입니다.'],
] as const)('%s 성공 문구와 session projection을 보존한다', async (kind, message) => {
  mockAcknowledgeSessionReview.mockResolvedValue({ kind });
  const { result } = renderHook(() => useSessionReviewAcknowledge('session'));
  await act(async () => result.current.acknowledge());
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '검수 확인',
    message,
    tone: 'success',
  });
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(useSessionStore.getState().sessions.session.reviewState).toBe('acknowledged');
});

test('서버 오류와 네트워크 오류 문구를 구분한다', async () => {
  mockAcknowledgeSessionReview.mockResolvedValueOnce({ kind: 'server_error', code: 'E', message: 'broken' });
  const first = renderHook(() => useSessionReviewAcknowledge('session'));
  await act(async () => first.result.current.acknowledge());
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '검수 확인 실패',
    message: 'E: broken',
    tone: 'error',
  });

  useAppNoticeStore.setState({ notice: null });
  mockAcknowledgeSessionReview.mockRejectedValueOnce(new Error('network'));
  const second = renderHook(() => useSessionReviewAcknowledge('session'));
  await act(async () => second.result.current.acknowledge());
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '네트워크 오류',
    message: '연결을 확인하고 다시 시도해주세요.',
    tone: 'error',
  });
  expect(Alert.alert).not.toHaveBeenCalled();
});

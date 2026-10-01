import { fireEvent, render } from '@testing-library/react-native';
import { Image, StyleSheet } from 'react-native';
import type { SessionEvent } from '../../../api/types';
import { UserMessage } from '../UserMessage';
import { useSettingsStore } from '../../../store/settingsStore';

test('채팅 말풍선과 첨부의 시각 속성 snapshot은 불변이다', () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  const screen = render(<UserMessage event={{ id: 'snapshot', type: 'user_message', data: { text: '사진 두 장', attachments: ['/tmp/one.png', '/tmp/two.png'] } }} session={{ agentSessionId: 's', nodeId: 'node-1', displayName: null, status: 'idle', createdAt: '', updatedAt: '' }} />);
  expect({ bubble: StyleSheet.flatten(screen.getByTestId('user-message-bubble').props.style),
    text: screen.getByTestId('user-message-text').props.children,
    images: screen.UNSAFE_getAllByType(Image).map(({ props }) => ({ source: props.source, style: StyleSheet.flatten(props.style), resizeMode: props.resizeMode, accessibilityLabel: props.accessibilityLabel })) }).toMatchSnapshot();
});

test('user message는 평상시에 selectable=false다', () => {
  const event: SessionEvent = {
    id: 'event-1',
    type: 'user_message',
    data: { content: '선택은 메뉴에서만 시작한다' },
  };
  const { getByTestId } = render(<UserMessage event={event} />);

  expect(getByTestId('user-message-text').props.selectable).toBe(false);
});

test('채팅 첨부 탭도 같은 뷰어에서 다른 첨부로 스와이프한다', () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  const screen = render(<UserMessage event={{ id: 'images', type: 'user_message', data: { attachments: ['/tmp/one.png', '/tmp/two.png'] } }} session={{ agentSessionId: 's', nodeId: 'node-1', displayName: null, status: 'idle', createdAt: '', updatedAt: '' }} />);
  fireEvent.press(screen.getByLabelText('첨부 이미지 2'));
  expect(screen.getByTestId('image-viewer-pages').props.pagingEnabled).toBe(true);
  expect(screen.getByTestId('image-viewer-pages').props.contentOffset.x).toBeGreaterThan(0);
  expect(screen.getAllByTestId('image-viewer-zoom')).toHaveLength(2);
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(screen.queryByTestId('image-viewer-pages')).toBeNull();
});

test('pending user message는 전송 상태를 말풍선에 표시하고 실패 액션을 연결한다', () => {
  const onRetry = jest.fn();
  const onRestore = jest.fn();
  const event = {
    id: 'optimistic-user-pending',
    type: 'user_message',
    data: { text: '보낼 문장' },
    pendingStatus: 'failed',
    failureReason: '전달을 확인하지 못했습니다',
  } as SessionEvent & { pendingStatus: 'failed'; failureReason: string };
  const { getByTestId, getByText } = render(
    <UserMessage
      event={event}
      pendingStatus="failed"
      failureReason="전달을 확인하지 못했습니다"
      onRetry={onRetry}
      onRestore={onRestore}
    />,
  );

  expect(getByText('전달을 확인하지 못했습니다')).toBeTruthy();
  fireEvent.press(getByTestId('pending-message-retry'));
  fireEvent.press(getByTestId('pending-message-restore'));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onRestore).toHaveBeenCalledTimes(1);
});

test('sending pending message는 흐린 말풍선과 상태 문구를 표시한다', () => {
  const event = {
    id: 'optimistic-user-sending',
    type: 'user_message',
    data: { text: '보낼 문장' },
    pendingStatus: 'sending',
  } as SessionEvent & { pendingStatus: 'sending' };
  const { getByTestId, getByText } = render(
    <UserMessage event={event} pendingStatus="sending" />,
  );

  expect(getByText('보내는 중')).toBeTruthy();
  expect(StyleSheet.flatten(getByTestId('user-message-bubble').props.style).opacity).toBeLessThan(1);
});

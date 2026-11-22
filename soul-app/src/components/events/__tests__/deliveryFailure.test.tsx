import { fireEvent, render } from '@testing-library/react-native';
import { EventRenderer } from '../EventRenderer';
import { useChatStore } from '../../../store/chatStore';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');

const SESSION_ID = 'session-1';

function seedFailures(failures: Record<string, string>) {
  useChatStore.setState({
    deliveryFailuresBySession: { [SESSION_ID]: failures },
  });
}

afterEach(() => {
  useChatStore.setState({
    deliveryFailuresBySession: {},
    deliveryFailureRefreshBySession: {},
    pendingOptimisticBySession: {},
  });
  jest.restoreAllMocks();
});

test('사람이 보낸 실패 말풍선은 실패 줄과 두 단추를 보여준다', () => {
  seedFailures({ 'input-failed': 'runner_receipt_unknown' });
  const onRetry = jest.fn();
  const onRestore = jest.fn();
  const event = {
    id: '41',
    type: 'user_message' as const,
    data: { text: '전달하지 못한 문장입니다.', input_id: 'input-failed' },
  };

  const screen = render(
    <EventRenderer
      event={event}
      sessionId={SESSION_ID}
      onRetryFailedDelivery={onRetry}
      onRestoreFailedDelivery={onRestore}
    />,
  );

  expect(screen.getByTestId('pending-message-failure')).toBeTruthy();
  expect(screen.getByText('전달을 확인하지 못했습니다')).toBeTruthy();
  // 실패 사유 코드는 화면에 내보내지 않는다.
  expect(screen.queryByText('runner_receipt_unknown')).toBeNull();

  fireEvent.press(screen.getByTestId('pending-message-retry'));
  expect(onRetry).toHaveBeenCalledWith({
    text: '전달하지 못한 문장입니다.',
    attachmentPaths: [],
  });
  fireEvent.press(screen.getByTestId('pending-message-restore'));
  expect(onRestore).toHaveBeenCalledWith('전달하지 못한 문장입니다.');
});

test('실패 목록에 없는 말풍선은 그대로 두고, 다른 input_id도 건드리지 않는다', () => {
  seedFailures({ 'input-other': 'runner_receipt_unknown' });
  const event = {
    id: '42',
    type: 'user_message' as const,
    data: { text: '전달된 문장입니다.', input_id: 'input-delivered' },
  };

  const screen = render(
    <EventRenderer
      event={event}
      sessionId={SESSION_ID}
      onRetryFailedDelivery={jest.fn()}
      onRestoreFailedDelivery={jest.fn()}
    />,
  );

  expect(screen.queryByTestId('pending-message-failure')).toBeNull();
  expect(screen.queryByText('다시 보내기')).toBeNull();
  expect(screen.getByText('전달된 문장입니다.')).toBeTruthy();
});

test('첨부가 있는데 경로를 얻지 못하면 다시 보내기 단추를 빼고 복원만 남긴다', () => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('network disabled'));
  seedFailures({ 'input-attached': 'runner_receipt_unknown' });
  const event = {
    id: '43',
    type: 'user_message' as const,
    data: {
      text: '첨부 실패 문장입니다.',
      input_id: 'input-attached',
      attachment_ids: ['attachment-1'],
    },
  };

  const screen = render(
    <EventRenderer
      event={event}
      sessionId={SESSION_ID}
      onRetryFailedDelivery={jest.fn()}
      onRestoreFailedDelivery={jest.fn()}
    />,
  );

  expect(screen.getByTestId('pending-message-failure')).toBeTruthy();
  expect(screen.queryByTestId('pending-message-retry')).toBeNull();
  expect(screen.getByTestId('pending-message-restore')).toBeTruthy();
});

test('인터벤션 실패 말풍선도 같은 실패 줄을 쓴다', () => {
  seedFailures({ 'input-intervention': 'runner_receipt_unknown' });
  const event = {
    id: '44',
    type: 'intervention_sent' as const,
    data: { text: '개입 문장입니다.', input_id: 'input-intervention' },
  };

  const screen = render(
    <EventRenderer
      event={event}
      sessionId={SESSION_ID}
      onRetryFailedDelivery={jest.fn()}
      onRestoreFailedDelivery={jest.fn()}
    />,
  );

  expect(screen.getByTestId('pending-message-failure')).toBeTruthy();
  expect(screen.getByText('전달을 확인하지 못했습니다')).toBeTruthy();
});

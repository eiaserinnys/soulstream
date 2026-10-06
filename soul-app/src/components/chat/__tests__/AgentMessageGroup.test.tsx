import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { AgentMessageGroup } from '../AgentMessageGroup';

test('starts collapsed, toggles its messages, and does not retain expansion after remount', () => {
  const view = render(
    <AgentMessageGroup count={3}>
      <Text>첫 번째 위임 보고</Text>
      <Text>두 번째 위임 보고</Text>
      <Text>세 번째 위임 보고</Text>
    </AgentMessageGroup>,
  );

  const header = view.getByRole('button', { name: '다른 세션 메시지 3건' });
  expect(header.props.accessibilityState).toEqual({ expanded: false });
  expect(view.queryByText('첫 번째 위임 보고')).toBeNull();

  fireEvent.press(header);
  expect(view.getByText('첫 번째 위임 보고')).toBeTruthy();
  expect(view.getByText('두 번째 위임 보고')).toBeTruthy();
  expect(view.getByText('세 번째 위임 보고')).toBeTruthy();
  expect(view.getByRole('button', { name: '다른 세션 메시지 3건' }).props.accessibilityState)
    .toEqual({ expanded: true });

  fireEvent.press(view.getByRole('button', { name: '다른 세션 메시지 3건' }));
  expect(view.queryByText('첫 번째 위임 보고')).toBeNull();

  view.unmount();
  const remounted = render(<AgentMessageGroup count={3}><Text>첫 번째 위임 보고</Text></AgentMessageGroup>);
  expect(remounted.getByRole('button', { name: '다른 세션 메시지 3건' }).props.accessibilityState)
    .toEqual({ expanded: false });
});

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { PHONE_CHAT_TYPOGRAPHY, TABLET_CHAT_TYPOGRAPHY } from '../../../theme';
import { SettingsInput } from '../SettingsFormParts';

test('채팅 입력은 본문 크기와 접근성 이름을 유지하고 빈 라벨을 그리지 않는다', () => {
  const screen = render(
    <SettingsInput
      variant="chat"
      label=""
      accessibilityLabel="참석 인원"
      value="12"
      testID="chat-attendee-count"
      onChangeText={jest.fn()}
    />,
  );

  const input = screen.getByTestId('chat-attendee-count');
  expect(input.props.accessibilityLabel).toBe('참석 인원');
  expect(screen.queryByText('참석 인원')).toBeNull();
  expect([PHONE_CHAT_TYPOGRAPHY.body, TABLET_CHAT_TYPOGRAPHY.body])
    .toContain(StyleSheet.flatten(input.props.style).fontSize);
});

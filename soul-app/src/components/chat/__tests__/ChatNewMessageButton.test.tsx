import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, renderHook } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { useTokens } from '../../../theme';
import { ChatNewMessageButton } from '../ChatNewMessageButton';

test('새 메시지 버튼은 panel 원형, outline 화살표, 이름을 쓰고 눌림을 전달한다', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const onPress = jest.fn();
  const screen = render(<ChatNewMessageButton onPress={onPress} />);
  const button = screen.getByLabelText('새 메시지로 이동');
  const surface = screen.getByTestId('chat-new-message-visual');

  expect(StyleSheet.flatten(surface.props.style)).toMatchObject({
    backgroundColor: tokens.persistentSession.panel,
    borderRadius: tokens.foundation.radius.round,
  });
  expect(surface.props.children.props.name).toBe('arrow-down-outline');
  fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

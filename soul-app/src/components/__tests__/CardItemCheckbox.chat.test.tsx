import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { CardItemCheckbox } from '../CardItemCheckbox';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test('채팅 체크는 카드 번호 없이 이름·checked 상태를 노출하고 웹 Space를 한 번 처리한다', () => {
  const onPress = jest.fn();
  const originalPlatform = Platform.OS;
  (Platform as any).OS = 'web';
  try {
    const screen = render(
      <CardItemCheckbox
        variant="chat"
        title="연간 결제"
        checked={false}
        testID="chat-annual-plan"
        onPress={onPress}
      />,
    );

    const checkbox = screen.getByTestId('chat-annual-plan');
    const visual = screen.getByTestId('chat-annual-plan-visual');
    const borderBeforeFocus = StyleSheet.flatten(visual.props.style).borderColor;
    expect(checkbox.props.accessibilityLabel).toBe('연간 결제');
    expect(checkbox.props.accessibilityState).toMatchObject({ checked: false });
    fireEvent(checkbox, 'focus');
    expect(StyleSheet.flatten(visual.props.style).borderColor).not.toBe(borderBeforeFocus);
    const keyEvent = { key: ' ', preventDefault: jest.fn(), stopPropagation: jest.fn() };
    fireEvent(checkbox, 'keyDownCapture', keyEvent);
    expect(keyEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(keyEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  } finally {
    (Platform as any).OS = originalPlatform;
  }
});

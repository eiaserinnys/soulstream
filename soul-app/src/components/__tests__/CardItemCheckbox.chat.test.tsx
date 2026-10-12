import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { CardItemCheckbox } from '../CardItemCheckbox';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

test.each(['ios', 'web'] as const)('채팅 체크 줄은 %s에서 왼쪽 내용 폭을 유지한다', platform => {
  const originalPlatform = Platform.OS;
  (Platform as any).OS = platform;
  try {
    const screen = render(<CardItemCheckbox variant="chat" label="연간 결제" checked testID="chat-check" onPress={jest.fn()} />);
    const frame = StyleSheet.flatten(screen.getByTestId('chat-check').props.style);
    expect(frame).toMatchObject({ alignSelf: 'flex-start', flexShrink: 0 });
    expect(frame.flexGrow).toBeUndefined();
    expect(frame.width).toBeUndefined();
  } finally {
    (Platform as any).OS = originalPlatform;
  }
});

test('채팅 체크 줄은 이름과 checked 상태를 한 요소로 묶고 라벨·Space를 한 번 토글한다', () => {
  const onPress = jest.fn();
  const originalPlatform = Platform.OS;
  (Platform as any).OS = 'web';
  try {
    function Harness() {
      const [checked, setChecked] = React.useState(false);
      return <CardItemCheckbox variant="chat" label="연간 결제" checked={checked} testID="chat-annual-plan" onPress={() => {
        onPress();
        setChecked(value => !value);
      }} />;
    }
    const screen = render(<Harness />);

    const checkbox = screen.getByTestId('chat-annual-plan');
    expect(checkbox.props.accessibilityLabel).toBe('연간 결제');
    expect(checkbox.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getAllByRole('checkbox', { name: '연간 결제' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '연간 결제' })).toBeNull();

    fireEvent.press(screen.getByText('연간 결제'));
    expect(screen.getByRole('checkbox', { name: '연간 결제' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    const checkedBorderWidth = StyleSheet.flatten(screen.getByTestId('chat-annual-plan-visual').props.style).borderWidth;
    fireEvent(screen.getByRole('checkbox', { name: '연간 결제' }), 'focus');
    const focusedStyle = StyleSheet.flatten(screen.getByTestId('chat-annual-plan-visual').props.style);
    expect(focusedStyle.borderWidth).toBeGreaterThan(checkedBorderWidth);
    expect(focusedStyle.outlineColor).toBe(focusedStyle.borderColor);
    expect(focusedStyle.outlineWidth).toBeGreaterThan(0);
    expect(focusedStyle.outlineOffset).toBeGreaterThan(0);

    const keyEvent = { key: ' ', preventDefault: jest.fn(), stopPropagation: jest.fn() };
    fireEvent(screen.getByRole('checkbox', { name: '연간 결제' }), 'keyDownCapture', keyEvent);
    expect(keyEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(keyEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox', { name: '연간 결제' }).props.accessibilityState).toMatchObject({ checked: false });
    expect(onPress).toHaveBeenCalledTimes(2);
  } finally {
    (Platform as any).OS = originalPlatform;
  }
});

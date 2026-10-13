import React from 'react';
import { StyleSheet } from 'react-native';
import { render, renderHook, fireEvent } from '@testing-library/react-native';
import { PHONE_CHAT_TYPOGRAPHY, TABLET_CHAT_TYPOGRAPHY, useTokens } from '../../../theme';
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


afterEach(() => require('../../../store/settingsStore').useSettingsStore.setState({ appearance: 'system' }));
test.each(['light', 'dark'] as const)('chat input shares the paper border owner in %s manuscript only', appearance => {
  require('../../../store/settingsStore').useSettingsStore.setState({ appearance });
  const { result } = renderHook(() => useTokens());
  const blur = jest.fn();
  const screen = render(<SettingsInput variant="chat" presentation="manuscript" label="메모" value="" onBlur={blur} />);
  const input = () => screen.getByLabelText('메모');
  expect(StyleSheet.flatten(input().props.style).borderColor).toBe(result.current.persistentSession.line);
  fireEvent(input(), 'focus');
  expect(StyleSheet.flatten(input().props.style).borderColor).toBe(result.current.colors.accent);
  fireEvent(input(), 'blur', { nativeEvent: {} });
  expect(blur).toHaveBeenCalledTimes(1);
  expect(StyleSheet.flatten(input().props.style).borderColor).toBe(result.current.persistentSession.line);
  screen.rerender(<SettingsInput variant="chat" label="메모" value="" />);
  expect(StyleSheet.flatten(input().props.style).borderColor).toBe(result.current.colors.border);
  screen.rerender(<SettingsInput presentation="manuscript" label="메모" value="" />);
  expect(StyleSheet.flatten(input().props.style).borderColor).toBe(result.current.colors.border);
});

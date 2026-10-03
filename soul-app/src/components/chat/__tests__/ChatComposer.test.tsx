import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

import { ChatComposer } from '../ChatComposer';

function renderComposer(
  input = '',
  disabled = false,
  sending = false,
  hasPendingOptimistic = false,
) {
  const onChangeInput = jest.fn();
  const onPickAttachment = jest.fn();
  const onSend = jest.fn();
  const utils = render(
    <ChatComposer
      input={input}
      onChangeInput={onChangeInput}
      onPickAttachment={onPickAttachment}
      onSend={onSend}
      uploading={false}
      sending={sending}
      hasPendingOptimistic={hasPendingOptimistic}
      disabled={disabled}
      voiceControls={<Text testID="voice-control">mic</Text>}
    />,
  );
  return { ...utils, onChangeInput, onPickAttachment, onSend };
}

describe('ChatComposer', () => {
  test('공통 한 줄 시작과 입력 표면 계약을 snapshot으로 기록한다', () => {
    expect(renderComposer('hello').toJSON()).toMatchSnapshot();
  });
  test('rounded input surface keeps one-row control order', () => {
    const { getByTestId } = renderComposer();

    const boxStyle = StyleSheet.flatten(getByTestId('chat-composer-box').props.style);
    expect(boxStyle.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(boxStyle.borderColor).toBeTruthy();
    expect(boxStyle.borderRadius).toBeGreaterThan(12);

    const input = getByTestId('chat-composer-text-input');
    expect(input.props.multiline).toBe(true);
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBeGreaterThan(80);

    const contentRow = getByTestId('chat-composer-content-row');
    expect(StyleSheet.flatten(contentRow.props.style).flexDirection).toBe('row');
    const childTestIds = React.Children.toArray(contentRow.props.children).map(
      (child: any) => child.props.testID,
    ).filter(Boolean);
    expect(childTestIds).toEqual([
      'chat-composer-attach-button',
      'chat-composer-text-input',
      'chat-composer-voice-slot',
      'chat-composer-send-button',
    ]);
  });

  test('빈 입력·긴 비개행은 한 줄이고 Enter 후 본문만 자라며 삭제하면 복귀한다', () => {
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="" />);
    const inputStyle = () => StyleSheet.flatten(screen.getByTestId('chat-composer-text-input').props.style);
    const rowStyle = () => StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style);
    const initialHeight = inputStyle().height;
    expect(initialHeight).toBe(48);
    expect(rowStyle().alignItems).toBe('center');
    const button = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
    const longText = '개행 없이 초안을 그대로 유지합니다. '.repeat(40);
    screen.rerender(<ChatComposer {...props} input={longText} />);
    expect(inputStyle().height).toBe(initialHeight);
    expect(screen.getByTestId('chat-composer-text-input').props.value).toBe(longText);
    screen.rerender(<ChatComposer {...props} input={'첫 줄\n둘째 줄'} />);
    expect(inputStyle().height).toBeGreaterThan(initialHeight!);
    expect(screen.getByTestId('chat-composer-text-input').props.textAlignVertical).toBe('top');
    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style)).toEqual(button);
    screen.rerender(<ChatComposer {...props} input="첫 줄" />);
    expect(inputStyle().height).toBe(initialHeight);
    expect(rowStyle().alignItems).toBe('center');
  });

  test('attach and send handlers stay wired while empty send remains disabled', () => {
    const empty = renderComposer('');
    const emptySend = empty.getByTestId('chat-composer-send-button');
    expect(emptySend.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(emptySend);
    expect(empty.onSend).not.toHaveBeenCalled();

    fireEvent.press(empty.getByTestId('chat-composer-attach-button'));
    expect(empty.onPickAttachment).toHaveBeenCalledTimes(1);

    const filled = renderComposer('hello');
    const filledSend = filled.getByTestId('chat-composer-send-button');
    expect(filledSend.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(filledSend);
    expect(filled.onSend).toHaveBeenCalledTimes(1);
  });

  test('text input delegates changes without owning message state', () => {
    const { getByTestId, onChangeInput } = renderComposer('');
    fireEvent.changeText(getByTestId('chat-composer-text-input'), 'line 1\nline 2');
    expect(onChangeInput).toHaveBeenCalledWith('line 1\nline 2');
  });

  test('offline disabled는 input·attachment·send·voice slot을 모두 비활성화한다', () => {
    const disabled = renderComposer('hello', true);
    expect(disabled.getByTestId('chat-composer-text-input').props.editable).toBe(false);
    expect(disabled.getByTestId('chat-composer-attach-button').props.accessibilityState.disabled).toBe(true);
    expect(disabled.getByTestId('chat-composer-send-button').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(disabled.getByTestId('chat-composer-attach-button'));
    fireEvent.press(disabled.getByTestId('chat-composer-send-button'));
    expect(disabled.onPickAttachment).not.toHaveBeenCalled();
    expect(disabled.onSend).not.toHaveBeenCalled();
  });

  test('pending cell이 있으면 입력은 계속 가능하고 보내기만 막으며 sending일 때 spinner를 보인다', () => {
    const pending = renderComposer('새 초안', false, true, true);
    expect(pending.getByTestId('chat-composer-text-input').props.editable).toBe(true);
    expect(pending.getByTestId('chat-composer-send-button').props.accessibilityState.disabled).toBe(true);
    expect(pending.getByTestId('chat-composer-send-spinner')).toBeTruthy();
    fireEvent.press(pending.getByTestId('chat-composer-send-button'));
    expect(pending.onSend).not.toHaveBeenCalled();

    const failed = renderComposer('새 초안', false, false, true);
    expect(failed.getByTestId('chat-composer-text-input').props.editable).toBe(true);
    expect(failed.getByTestId('chat-composer-send-button').props.accessibilityState.disabled).toBe(true);
    expect(failed.queryByTestId('chat-composer-send-spinner')).toBeNull();
  });

  test('sending pending cell에서도 첨부 버튼은 활성 상태다', () => {
    const sending = renderComposer('초안', false, true, true);
    const attachmentButton = sending.getByTestId('chat-composer-attach-button');

    expect(attachmentButton.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(attachmentButton);
    expect(sending.onPickAttachment).toHaveBeenCalledTimes(1);
  });
});

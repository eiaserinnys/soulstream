import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

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
  test('기존 채팅 입력 렌더 snapshot은 불변이다', () => {
    expect(renderComposer('hello').toJSON()).toMatchSnapshot();
  });
  test('single frameless rounded composer keeps one-row control order', () => {
    const { getByTestId } = renderComposer();

    const boxStyle = StyleSheet.flatten(getByTestId('chat-composer-box').props.style);
    expect(boxStyle.borderWidth).toBeUndefined();
    expect(boxStyle.borderColor).toBeUndefined();
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

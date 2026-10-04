import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

import { ChatComposer } from '../ChatComposer';
import * as inputMeasurement from '../useTextInputContentHeight';

afterEach(() => jest.restoreAllMocks());

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

  test('Android 콘텐츠 이벤트 수신 후 높이·정렬·스크롤 계산과 clear 계약', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="" />);
    const field = () => screen.getByTestId('chat-composer-text-input');
    const inputStyle = () => StyleSheet.flatten(field().props.style);
    const rowStyle = () => StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style);
    const measure = (height: number) => fireEvent(field(), 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height } } });
    const initialHeight = inputStyle().height;
    expect(initialHeight).toBe(48);
    expect(field().props.scrollEnabled).toBe(false);
    expect(rowStyle().alignItems).toBe('center');
    const button = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
    for (const text of ['개행 없는 긴 문장 '.repeat(20), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄']) {
      screen.rerender(<ChatComposer {...props} input={text} />);
      measure(110);
      expect(inputStyle().height).toBe(110);
      expect(field().props.textAlignVertical).toBe('top');
      expect(rowStyle().alignItems).toBe('flex-end');
      expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style)).toEqual(button);
      screen.rerender(<ChatComposer {...props} input="한 줄" />);
      measure(42);
      expect(inputStyle().height).toBe(initialHeight);
    }
    screen.rerender(<ChatComposer {...props} input={'긴 글 '.repeat(200)} />);
    measure(250);
    expect(inputStyle().height).toBe(128);
    expect(field().props.scrollEnabled).toBe(true);
    screen.rerender(<ChatComposer {...props} input="" />);
    expect(inputStyle().height).toBe(initialHeight);
    expect(field().props.scrollEnabled).toBe(false);
  });

  test('Android 복원 draft의 콘텐츠 이벤트 수신 후 상한 계산', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const draft = '복원할 긴 초안 '.repeat(30);
    const screen = renderComposer(draft);
    fireEvent(screen.getByTestId('chat-composer-text-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 200, height: 250 } },
    });
    const field = screen.getByTestId('chat-composer-text-input');
    expect(field.props.value).toBe(draft);
    expect(StyleSheet.flatten(field.props.style).height).toBe(128);
    expect(field.props.scrollEnabled).toBe(true);
  });

  test('iOS는 값을 바꿔도 고정 높이가 없고 layout 이벤트 수신으로 상한 스크롤을 정한다', () => {
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="" />);
    const field = () => screen.getByTestId('chat-composer-text-input');
    const layout = (height: number) => fireEvent(field(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height } } });
    const button = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
    for (const value of ['', '한국어 연속 입력 '.repeat(20), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄', '한 줄', '']) {
      screen.rerender(<ChatComposer {...props} input={value} />);
      expect(StyleSheet.flatten(field().props.style)).toMatchObject({ minHeight: 48, maxHeight: 128 });
      expect(StyleSheet.flatten(field().props.style).height).toBeUndefined();
      expect(field().props.multiline).toBe(true);
      expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style)).toEqual(button);
    }
    screen.rerender(<ChatComposer {...props} input={'긴 글 '.repeat(100)} />);
    layout(108);
    expect(field().props.scrollEnabled).toBe(false);
    // The cap must enable scrolling without a contentSizeChange event.
    layout(128);
    expect(field().props.scrollEnabled).toBe(true);
    screen.rerender(<ChatComposer {...props} input={'더 긴 글 '.repeat(100)} />);
    expect(field().props.scrollEnabled).toBe(true);
    screen.rerender(<ChatComposer {...props} input="한 줄" />);
    layout(48);
    expect(field().props.scrollEnabled).toBe(false);
    screen.rerender(<ChatComposer {...props} input="" />);
    expect(StyleSheet.flatten(field().props.style).height).toBeUndefined();
  });

  test('웹 측정값 수신 후 기존 rows·줄바꿈·명시 높이·상한 계산 계약', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    // The hook's DOM measurement is mocked; this test covers only its consumer contract.
    const measurement = jest.spyOn(inputMeasurement, 'useTextInputContentHeight');
    measurement.mockReturnValue({ ref: { current: null }, contentHeight: 0, onContentSizeChange: undefined });
    const screen = renderComposer('본문');
    const field = () => screen.getByTestId('chat-composer-text-input');
    expect(field().props.rows).toBe(1);
    expect(StyleSheet.flatten(field().props.style)).toMatchObject({ height: 48, whiteSpace: 'pre-wrap' });
    measurement.mockReturnValue({ ref: { current: null }, contentHeight: 250, onContentSizeChange: undefined });
    screen.rerender(<ChatComposer input="긴 본문" onChangeInput={jest.fn()} onPickAttachment={jest.fn()} onSend={jest.fn()} uploading={false} sending={false} voiceControls={null} />);
    expect(StyleSheet.flatten(field().props.style).height).toBe(128);
    expect(field().props.scrollEnabled).toBe(true);
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

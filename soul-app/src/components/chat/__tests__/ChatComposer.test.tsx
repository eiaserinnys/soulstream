import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

import { ChatComposer } from '../ChatComposer';
import { ChatInterruptButton } from '../ChatInterruptButton';
import { makeStyles } from '../ChatBody.styles';
import { useTokens } from '../../../theme';
import { ADD_GLYPH_INSET_RATIO } from '../ChatBody.styles';
import * as inputMeasurement from '../useTextInputContentHeight';

afterEach(() => jest.restoreAllMocks());

function renderComposer(
  input = '',
  disabled = false,
  sending = false,
  hasPendingOptimistic = false,
  uploading = false,
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
      uploading={uploading}
      sending={sending}
      hasPendingOptimistic={hasPendingOptimistic}
      disabled={disabled}
      voiceControls={<Text testID="voice-control">mic</Text>}
    />,
  );
  return { ...utils, onChangeInput, onPickAttachment, onSend };
}

interface MountCount {
  mounted: number;
  unmounted: number;
}

function MountProbe({ count, testID }: { count: MountCount; testID: string }) {
  React.useEffect(() => {
    count.mounted += 1;
    return () => { count.unmounted += 1; };
  }, [count]);
  return <Text testID={testID}>{testID}</Text>;
}

describe('ChatComposer', () => {
  test('공통 한 줄 시작과 입력 표면 계약을 snapshot으로 기록한다', () => {
    expect(renderComposer('hello').toJSON()).toMatchSnapshot();
  });
  test('rounded input surface keeps the single-line composer in one control row', () => {
    const screen = renderComposer();
    const { getByTestId } = screen;

    const boxStyle = StyleSheet.flatten(getByTestId('chat-composer-box').props.style);
    expect(boxStyle.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(boxStyle.borderColor).toBeTruthy();
    expect(boxStyle.borderRadius).toBeGreaterThan(12);

    const input = getByTestId('chat-composer-text-input');
    expect(input.props.multiline).toBe(true);
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBeGreaterThan(80);
    expect(StyleSheet.flatten(input.props.style).flex).toBe(1);

    const contentRow = getByTestId('chat-composer-content-row');
    expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'center',
      columnGap: 6,
    });
    const contentChildTestIds = React.Children.toArray(contentRow.props.children).map(
      (child: any) => child.props.testID,
    );
    expect(contentChildTestIds).toEqual([
      'chat-composer-attach-slot',
      'chat-composer-text-input',
      'chat-composer-controls-spacer',
      undefined,
    ]);

    const spacer = screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' });
    expect(StyleSheet.flatten(spacer.props.style).display).toBe('none');
    const rightControls = React.Children.toArray(contentRow.props.children)[3] as React.ReactElement<any>;
    expect(StyleSheet.flatten(rightControls.props.style)).toMatchObject({
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    });
    expect(React.Children.toArray(rightControls.props.children).map(
      (child: any) => child.props.testID,
    )).toEqual([
      'chat-composer-voice-slot',
      'chat-composer-send-button',
    ]);
  });

  test('web placeholder stays on one line while empty and typed text keeps pre-wrap', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.spyOn(inputMeasurement, 'useTextInputContentHeight').mockImplementation(() => ({
      ref: { current: null as any },
      contentHeight: 48,
      onContentSizeChange: undefined,
    }));
    const props = {
      onChangeInput: jest.fn(),
      onPickAttachment: jest.fn(),
      onSend: jest.fn(),
      uploading: false,
      sending: false,
      voiceControls: null,
    };
    const screen = render(<ChatComposer {...props} input="" />);
    const field = () => screen.getByTestId('chat-composer-text-input');

    expect(StyleSheet.flatten(field().props.style)).toMatchObject({
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      overflow: 'hidden',
    });

    screen.rerender(<ChatComposer {...props} input="첫 줄\n둘째 줄" />);
    expect(StyleSheet.flatten(field().props.style)).toMatchObject({ whiteSpace: 'pre-wrap' });
    expect(StyleSheet.flatten(field().props.style).textOverflow).toBeUndefined();
    expect(StyleSheet.flatten(field().props.style).overflow).toBeUndefined();
  });

  test('manuscript input omits placeholder and keeps an accessible name', () => {
    const props = {
      onChangeInput: jest.fn(),
      onPickAttachment: jest.fn(),
      onSend: jest.fn(),
      uploading: false,
      sending: false,
      voiceControls: null,
    };
    const screen = render(<ChatComposer {...props} input="" presentation="manuscript" />);
    const field = screen.getByTestId('chat-composer-text-input');
    const box = StyleSheet.flatten(screen.getByTestId('chat-composer-box').props.style);

    expect(field.props.placeholder).toBeUndefined();
    expect(field.props.accessibilityLabel).toBe('메시지');
    expect(box.paddingBottom).toBeGreaterThan(0);
  });

  test('reports the composer box and row rectangles for anchor-relative baseline measurement', () => {
    const onComposerBoxLayout = jest.fn();
    const props: any = {
      input: '', onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(),
      uploading: false, sending: false, voiceControls: null, presentation: 'manuscript', embedded: true,
      onComposerBoxLayout,
    };
    const screen = render(<ChatComposer {...props} />);
    const row = { x: 0, y: 14, width: 360, height: 70 };
    const box = { x: 0, y: 0, width: 360, height: 54 };
    fireEvent(screen.getByTestId('chat-composer-row'), 'layout', { nativeEvent: { layout: row } });
    fireEvent(screen.getByTestId('chat-composer-box'), 'layout', { nativeEvent: { layout: box } });

    expect(onComposerBoxLayout).toHaveBeenLastCalledWith(box, row);
  });

  test('원고형 도구 버튼은 외곽선 없는 outline glyph를 쓰고 기본 채팅은 그대로 둔다', () => {
    const props = {
      onChangeInput: jest.fn(),
      onPickAttachment: jest.fn(),
      onSend: jest.fn(),
      uploading: false,
      sending: false,
      voiceControls: null,
    };
    const normal = render(<ChatComposer {...props} input="초안" />);
    const normalAttach = normal.getByTestId('chat-composer-attach-visual').props.children;
    const normalSend = normal.getByTestId('chat-composer-send-visual').props.children;
    expect(normalAttach.props.name).toBe('add');
    expect(normalSend.props.name).toBe('send');
    expect(StyleSheet.flatten(normal.getByTestId('chat-composer-send-visual').props.style).backgroundColor)
      .not.toBe('transparent');

    const manuscript = render(<ChatComposer {...props} input="초안" presentation="manuscript" />);
    const attach = manuscript.getByTestId('chat-composer-attach-visual');
    const send = manuscript.getByTestId('chat-composer-send-visual');
    expect(attach.props.children.props.name).toBe('add-outline');
    expect(send.props.children.props.name).toBe('send-outline');
    expect(StyleSheet.flatten(attach.props.style).backgroundColor).toBe('transparent');
    expect(StyleSheet.flatten(send.props.style).backgroundColor).toBe('transparent');
    expect(send.props.children.props.color).toBeTruthy();
  });

  test('원고형 중단 버튼은 투명 표면의 outline glyph를 쓰고 일반 채팅은 빨간 채움을 유지한다', () => {
    const tokens = renderHook(() => useTokens()).result.current;
    const styles = makeStyles(tokens);
    const defaultButton = render(<ChatInterruptButton
      interrupting={false} disabled={false} styles={styles}
      accentTextColor={tokens.colors.accentText} textPrimaryColor={tokens.colors.textPrimary}
      onPress={jest.fn()}
    />);
    expect(defaultButton.getByTestId('chat-composer-interrupt-visual').props.children.props.name).toBe('stop');
    expect(StyleSheet.flatten(defaultButton.getByTestId('chat-composer-interrupt-visual').props.style).backgroundColor)
      .toBe(tokens.colors.error);

    const manuscript = render(<ChatInterruptButton
      interrupting={false} disabled={false} presentation="manuscript" styles={styles}
      accentTextColor={tokens.colors.accentText} textPrimaryColor={tokens.colors.textPrimary}
      onPress={jest.fn()}
    />);
    const visual = manuscript.getByTestId('chat-composer-interrupt-visual');
    expect(visual.props.children.props.name).toBe('stop-outline');
    expect(StyleSheet.flatten(visual.props.style).backgroundColor).toBe('transparent');
    expect(visual.props.children.props.color).toBe(tokens.colors.textPrimary);
  });

  test('wrap stacks the row, stays stacked until empty, and preserves mounted controls and input', () => {
    const measurementRef = { current: null as any };
    let contentHeight = 48;
    jest.spyOn(inputMeasurement, 'useTextInputContentHeight').mockImplementation(() => ({
      ref: measurementRef,
      contentHeight,
      onContentSizeChange: undefined,
    }));
    const interruptCount = { mounted: 0, unmounted: 0 };
    const voiceCount = { mounted: 0, unmounted: 0 };
    const interrupt = <MountProbe count={interruptCount} testID="interrupt-control" />;
    const voice = <MountProbe count={voiceCount} testID="voice-control" />;
    const props = {
      onChangeInput: jest.fn(),
      onPickAttachment: jest.fn(),
      onSend: jest.fn(),
      uploading: false,
      sending: false,
      interruptControls: interrupt,
      voiceControls: voice,
    };
    const screen = render(<ChatComposer {...props} input="한 줄" />);
    const contentRow = () => screen.getByTestId('chat-composer-content-row');
    const rowStyle = () => StyleSheet.flatten(contentRow().props.style);
    const textInput = () => screen.getByTestId('chat-composer-text-input');

    expect(rowStyle()).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'center',
      columnGap: 6,
    });
    const children = () => React.Children.toArray(contentRow().props.children) as React.ReactElement<any>[];
    expect(children().map((child) => child.props.testID)).toEqual([
      'chat-composer-attach-slot',
      'chat-composer-text-input',
      'chat-composer-controls-spacer',
      undefined,
    ]);
    expect(StyleSheet.flatten(textInput().props.style)).toMatchObject({ flex: 1 });
    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-attach-slot').props.style).position)
      .toBeUndefined();
    expect(StyleSheet.flatten(screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' }).props.style).display)
      .toBe('none');
    const inputInstance = measurementRef.current;
    expect(inputInstance).toBeTruthy();
    expect(interruptCount).toEqual({ mounted: 1, unmounted: 0 });
    expect(voiceCount).toEqual({ mounted: 1, unmounted: 0 });

    contentHeight = 72;
    screen.rerender(<ChatComposer {...props} input="첫 줄\n둘째 줄" />);
    expect(rowStyle()).toMatchObject({ flexWrap: 'wrap', columnGap: 0 });
    expect(StyleSheet.flatten(textInput().props.style)).toMatchObject({ width: '100%' });
    expect(StyleSheet.flatten(textInput().props.style).flex).toBeUndefined();
    const attachIcon = screen.getByTestId('chat-composer-attach-visual').props.children as React.ReactElement<any>;
    const hitTarget = 44;
    const inputPadding = StyleSheet.flatten(textInput().props.style).paddingHorizontal;
    const expectedAttachLeft = inputPadding - (hitTarget - attachIcon.props.size) / 2
      - attachIcon.props.size * ADD_GLYPH_INSET_RATIO;
    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-attach-slot').props.style)).toMatchObject({
      position: 'absolute',
      bottom: 0,
      left: expectedAttachLeft,
      height: hitTarget,
      justifyContent: 'center',
    });
    const spacer = screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' });
    expect(spacer.props.accessible).toBe(false);
    expect(spacer.props.focusable).toBe(false);
    expect(spacer.props.tabIndex).toBe(-1);
    expect(StyleSheet.flatten(spacer.props.style)).toMatchObject({
      flex: 1,
      minHeight: 44,
      marginLeft: hitTarget + expectedAttachLeft,
    });

    contentHeight = 48;
    screen.rerender(<ChatComposer {...props} input="짧게 줄임" />);
    expect(rowStyle().flexWrap).toBe('wrap');
    screen.rerender(<ChatComposer {...props} input="" />);
    expect(rowStyle().flexWrap).toBe('nowrap');
    expect(measurementRef.current).toBe(inputInstance);
    expect(interruptCount).toEqual({ mounted: 1, unmounted: 0 });
    expect(voiceCount).toEqual({ mounted: 1, unmounted: 0 });
  });

  test.each(['default', 'manuscript'] as const)(
    '%s clear commit restores the single-row layout before the stacked reset effect',
    (presentation) => {
      let contentHeight = 72;
      jest.spyOn(inputMeasurement, 'useTextInputContentHeight').mockImplementation(() => ({
        ref: { current: null as any },
        contentHeight,
        onContentSizeChange: undefined,
      }));

      const deferredEffects: Array<() => void> = [];
      const originalUseLayoutEffect = React.useLayoutEffect;
      let deferNextLayoutEffect = false;
      jest.spyOn(React, 'useLayoutEffect').mockImplementation((effect, dependencies) => {
        if (deferNextLayoutEffect) {
          deferNextLayoutEffect = false;
          originalUseLayoutEffect(() => {
            deferredEffects.push(effect);
          }, dependencies);
          return;
        }
        originalUseLayoutEffect(effect, dependencies);
      });

      const props = {
        onChangeInput: jest.fn(),
        onPickAttachment: jest.fn(),
        onSend: jest.fn(),
        uploading: false,
        sending: false,
        voiceControls: null,
        presentation,
      };
      const screen = render(<ChatComposer {...props} input="첫 줄\n둘째 줄" />);
      const contentRow = () => screen.getByTestId('chat-composer-content-row');
      expect(StyleSheet.flatten(contentRow().props.style).flexWrap).toBe('wrap');

      contentHeight = 48;
      deferNextLayoutEffect = true;
      screen.rerender(<ChatComposer {...props} input="" />);

      const rowStyle = StyleSheet.flatten(contentRow().props.style);
      const field = screen.getByTestId('chat-composer-text-input');
      const fieldStyle = StyleSheet.flatten(field.props.style);
      const attachmentStyle = StyleSheet.flatten(screen.getByTestId('chat-composer-attach-slot').props.style);
      const spacer = screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' });
      const voiceSlot = screen.UNSAFE_root.findByProps({ testID: 'chat-composer-voice-slot' });

      expect(deferredEffects).toHaveLength(1);
      expect(rowStyle.flexWrap).toBe('nowrap');
      expect(fieldStyle.flex).toBe(1);
      expect(fieldStyle.width).toBeUndefined();
      expect(fieldStyle.height).toBe(Math.max(48, fieldStyle.minHeight));
      expect(fieldStyle.paddingHorizontal).not.toBe(0);
      expect(attachmentStyle.position).toBeUndefined();
      if (presentation === 'manuscript') {
        expect(attachmentStyle.marginLeft).toBeLessThan(0);
      } else {
        expect(attachmentStyle.marginLeft).toBeUndefined();
      }
      expect(StyleSheet.flatten(spacer.props.style).display).toBe('none');
      expect(StyleSheet.flatten(voiceSlot.props.style).display).toBeUndefined();

      act(() => {
        deferredEffects[0]();
      });
      expect(StyleSheet.flatten(contentRow().props.style).flexWrap).toBe('nowrap');

      screen.rerender(<ChatComposer {...props} input="다음 입력" />);
      expect(StyleSheet.flatten(contentRow().props.style).flexWrap).toBe('nowrap');
      expect(screen.getByTestId('chat-composer-send-button').props.accessibilityState.disabled).toBe(false);
    },
  );

  test('Android 콘텐츠 이벤트 수신 후 높이·정렬·스크롤 계산과 clear 계약', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="" />);
    const field = () => screen.getByTestId('chat-composer-text-input');
    const inputStyle = () => StyleSheet.flatten(field().props.style);
    const contentRowStyle = () => StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style);
    const rightControlsStyle = () => {
      const rightControls = React.Children.toArray(screen.getByTestId('chat-composer-content-row').props.children)[3] as React.ReactElement<any>;
      return StyleSheet.flatten(rightControls.props.style);
    };
    const measure = (height: number) => fireEvent(field(), 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height } } });
    const initialHeight = inputStyle().height;
    expect(initialHeight).toBe(48);
    expect(field().props.scrollEnabled).toBe(false);
    expect(contentRowStyle().flexWrap).toBe('nowrap');
    const initialRightControlsStyle = rightControlsStyle();
    const button = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
    for (const text of ['개행 없는 긴 문장 '.repeat(20), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄']) {
      screen.rerender(<ChatComposer {...props} input={text} />);
      measure(110);
      expect(inputStyle().height).toBe(110);
      expect(field().props.textAlignVertical).toBe('top');
      expect(contentRowStyle().flexWrap).toBe('wrap');
      expect(rightControlsStyle()).toEqual(initialRightControlsStyle);
      expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style)).toEqual(button);
      screen.rerender(<ChatComposer {...props} input="한 줄" />);
      measure(42);
      expect(inputStyle().height).toBe(initialHeight);
      expect(contentRowStyle().flexWrap).toBe('wrap');
    }
    screen.rerender(<ChatComposer {...props} input={'긴 글 '.repeat(200)} />);
    measure(250);
    expect(inputStyle().height).toBe(128);
    expect(field().props.scrollEnabled).toBe(true);
    screen.rerender(<ChatComposer {...props} input="" />);
    expect(inputStyle().height).toBe(initialHeight);
    expect(field().props.scrollEnabled).toBe(false);
    expect(contentRowStyle().flexWrap).toBe('nowrap');
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
    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style).flexWrap).toBe('wrap');
  });

  test('iOS는 빈 입력만 한 줄 높이를 지정하고 실제 입력의 상한 스크롤은 layout으로 정한다', () => {
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="" />);
    const field = () => screen.getByTestId('chat-composer-text-input');
    const layout = (height: number) => fireEvent(field(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height } } });
    const button = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
    for (const value of ['', '한국어 연속 입력 '.repeat(20), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄', '한 줄', '']) {
      screen.rerender(<ChatComposer {...props} input={value} />);
      expect(StyleSheet.flatten(field().props.style)).toMatchObject({ minHeight: 48, maxHeight: 128 });
      expect(StyleSheet.flatten(field().props.style).height).toBe(value.length === 0 ? 48 : undefined);
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
    expect(StyleSheet.flatten(field().props.style).height).toBe(48);
  });

  test.each(['가', ' ', '\n'])('iOS 최대 높이 → 빈 값 → 첫 입력 %j → 긴 입력의 JS 계약', (firstInput) => {
    // JS props/style only: layout events are supplied, not produced by native typing.
    jest.replaceProperty(Platform, 'OS', 'ios');
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input={'긴 글 '.repeat(100)} />);
    const field = () => screen.getByTestId('chat-composer-text-input');
    const style = () => StyleSheet.flatten(field().props.style);
    const singleLineHeight = style().minHeight;
    const layoutAtCap = () => fireEvent(field(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: style().maxHeight } } });

    layoutAtCap();
    expect(field().props.scrollEnabled).toBe(true);
    expect(style().height).toBeUndefined();

    screen.rerender(<ChatComposer {...props} input="" />);
    expect(style().height).toBe(singleLineHeight);
    expect(field().props.scrollEnabled).toBe(false);

    // No shrinking layout event: the first input must not inherit the old cap state.
    screen.rerender(<ChatComposer {...props} input={firstInput} />);
    expect(style().height).toBeUndefined();
    expect(field().props.scrollEnabled).toBe(false);

    screen.rerender(<ChatComposer {...props} input={'다시 긴 글 '.repeat(100)} />);
    expect(style().height).toBeUndefined();
    expect(field().props.scrollEnabled).toBe(false);
    layoutAtCap();
    expect(field().props.scrollEnabled).toBe(true);
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
    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style).flexWrap).toBe('wrap');
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

  test('stacked controls space focuses the input but does nothing while disabled', () => {
    const focus = jest.fn();
    const measurementRef = { current: null as any };
    jest.spyOn(inputMeasurement, 'useTextInputContentHeight').mockReturnValue({
      ref: measurementRef,
      contentHeight: 72,
      onContentSizeChange: undefined,
    });
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null };
    const screen = render(<ChatComposer {...props} input="첫 줄\n둘째 줄" />);
    const spacer = () => screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' });
    measurementRef.current = { focus };

    expect(spacer().props.accessible).toBe(false);
    expect(spacer().props.focusable).toBe(false);
    fireEvent.press(spacer());
    expect(focus).toHaveBeenCalledTimes(1);

    screen.rerender(<ChatComposer {...props} input="첫 줄\n둘째 줄" disabled />);
    measurementRef.current = { focus };
    fireEvent.press(spacer());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('stacked layout removes the empty voice slot gap but preserves the gap when voice controls exist', () => {
    jest.spyOn(inputMeasurement, 'useTextInputContentHeight').mockReturnValue({
      ref: { current: null },
      contentHeight: 72,
      onContentSizeChange: undefined,
    });
    const props = { onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false };
    const screen = render(<ChatComposer {...props} input="첫 줄\n둘째 줄" voiceControls={null} />);
    const voiceSlot = () => screen.UNSAFE_root.findByProps({ testID: 'chat-composer-voice-slot' });
    const rightControls = () => React.Children.toArray(
      screen.getByTestId('chat-composer-content-row').props.children,
    )[3] as React.ReactElement<any>;

    expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style).flexWrap).toBe('wrap');
    expect(StyleSheet.flatten(voiceSlot().props.style).display).toBe('none');
    expect(StyleSheet.flatten(rightControls().props.style).gap).toBe(6);

    screen.rerender(<ChatComposer {...props} input="첫 줄\n둘째 줄" voiceControls={<Text testID="voice-control">mic</Text>} />);
    expect(StyleSheet.flatten(voiceSlot().props.style).display).toBeUndefined();
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

  test('sending 중에는 입력이 비어도 강조 표면의 spinner를 표시하고 전송을 막는다', () => {
    const empty = renderComposer('', false, true);
    const active = renderComposer('보낼 내용');
    const emptySend = empty.getByTestId('chat-composer-send-button');
    const busySurface = StyleSheet.flatten(empty.getByTestId('chat-composer-send-visual').props.style);
    const activeSurface = StyleSheet.flatten(active.getByTestId('chat-composer-send-visual').props.style);

    expect(empty.getByTestId('chat-composer-send-spinner')).toBeTruthy();
    expect(emptySend.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(busySurface.backgroundColor).toBe(activeSurface.backgroundColor);
    expect(busySurface.opacity).toBeUndefined();
    fireEvent.press(emptySend);
    expect(empty.onSend).not.toHaveBeenCalled();

    const withDraft = renderComposer('다음 초안', false, true);
    expect(withDraft.getByTestId('chat-composer-send-button').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(withDraft.getByTestId('chat-composer-send-button'));
    expect(withDraft.onSend).not.toHaveBeenCalled();
  });

  test('uploading 중 첨부 버튼은 흐리지 않고 busy 접근성을 전달한다', () => {
    const screen = renderComposer('초안', false, false, false, true);
    const attachmentButton = screen.getByTestId('chat-composer-attach-button');
    const busySurface = StyleSheet.flatten(screen.getByTestId('chat-composer-attach-visual').props.style);

    expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeTruthy();
    expect(attachmentButton.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(busySurface.opacity).toBeUndefined();
  });

  test('sending pending cell에서도 첨부 버튼은 활성 상태다', () => {
    const sending = renderComposer('초안', false, true, true);
    const attachmentButton = sending.getByTestId('chat-composer-attach-button');

    expect(attachmentButton.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(attachmentButton);
    expect(sending.onPickAttachment).toHaveBeenCalledTimes(1);
  });
});

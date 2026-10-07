import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import { ChatComposer } from '../ChatComposer';
import { ADD_GLYPH_INSET_RATIO } from '../ChatBody.styles';

function composer(input = '메시지') {
  return (
    <ChatComposer
      input={input}
      onChangeInput={jest.fn()}
      onPickAttachment={jest.fn()}
      onSend={jest.fn()}
      uploading={false}
      sending={false}
      interruptControls={<View testID="interrupt-control"><Text>stop</Text></View>}
      voiceControls={<View testID="voice-control"><Text>mic</Text></View>}
    />
  );
}

test.each([
  ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
  ['phone large text', { width: 390, height: 844, scale: 3, fontScale: 2 }, 44],
  ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 48],
  ['iPad large text', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
] as const)('%s composer는 줄바꿈 전 한 줄이고 줄바꿈 뒤 같은 요소를 쌓는다', (
  _label,
  dimensions,
  hitTarget,
) => {
  mockDimensions = dimensions;
  const screen = render(composer());
  const box = screen.getByTestId('chat-composer-box');
  const boxStyle = StyleSheet.flatten(box.props.style);
  expect(boxStyle).toMatchObject({ minHeight: 56 });
  const contentRow = screen.getByTestId('chat-composer-content-row');
  expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({
    minHeight: 48,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    columnGap: 6,
  });
  expect(boxStyle.height).toBeUndefined();
  expect(screen.queryByTestId('chat-composer-toolbar')).toBeNull();
  const inputRow = screen.getByTestId('chat-composer-input-row');
  const controlsRow = screen.getByTestId('chat-composer-controls-row');
  expect(contentRow.props.collapsable).toBe(false);
  expect(inputRow.props.collapsable).toBe(false);
  expect(controlsRow.props.collapsable).toBe(false);
  expect(StyleSheet.flatten(inputRow.props.style)).toMatchObject({
    flexDirection: 'row', alignItems: 'center', minWidth: 0,
    flexGrow: 1, flexShrink: 1, flexBasis: 0,
  });
  expect(StyleSheet.flatten(controlsRow.props.style)).toMatchObject({
    flexDirection: 'row', alignItems: 'center', flexShrink: 0, minHeight: hitTarget,
  });

  const input = screen.getByTestId('chat-composer-text-input');
  expect(StyleSheet.flatten(input.props.style).maxHeight).toBe(128);
  expect(StyleSheet.flatten(input.props.style).flex).toBe(1);
  expect(StyleSheet.flatten(input.props.style).width).toBeUndefined();
  expect(input.props.textAlignVertical).toBe('center');
  const contentChildren = () => React.Children.toArray(contentRow.props.children) as React.ReactElement<any>[];
  const childrenBeforeWrap = contentChildren();
  expect(childrenBeforeWrap.map((child) => child.props.testID)).toEqual([
    'chat-composer-attach-slot',
    'chat-composer-input-row',
    'chat-composer-controls-row',
  ]);
  expect(React.Children.toArray(inputRow.props.children).map((child: any) => child.props.testID))
    .toEqual(['chat-composer-text-input']);
  expect(React.Children.toArray(controlsRow.props.children).map((child: any) => child.props.testID))
    .toEqual(['chat-composer-controls-spacer', undefined]);
  const attachmentSlot = screen.getByTestId('chat-composer-attach-slot');
  expect(StyleSheet.flatten(attachmentSlot.props.style).position).toBeUndefined();
  expect(StyleSheet.flatten(attachmentSlot.props.style).marginLeft).toBeUndefined();
  const spacer = screen.UNSAFE_root.findByProps({ testID: 'chat-composer-controls-spacer' });
  expect(spacer.props.accessible).toBe(false);
  expect(spacer.props.focusable).toBe(false);
  expect(spacer.props.tabIndex).toBe(-1);
  expect(StyleSheet.flatten(spacer.props.style).display).toBe('none');
  const controlsChildren = React.Children.toArray(controlsRow.props.children) as React.ReactElement<any>[];
  const rightControls = controlsChildren[1];
  expect(StyleSheet.flatten(rightControls.props.style)).toMatchObject({
    flexDirection: 'row',
    gap: 6,
  });
  const deviceLineHeight = (dimensions.width >= 768 ? 18 : 17) * 1.3;
  const measuredLineHeight = deviceLineHeight * dimensions.fontScale;
  expect(StyleSheet.flatten(input.props.style).minHeight).toBe(Math.max(48, measuredLineHeight + 20));
  expect(StyleSheet.flatten(input.props.style).height).toBeUndefined();
  const rightControlsStyleBeforeWrap = StyleSheet.flatten(rightControls.props.style);
  const textInputInstance = input.instance;

  screen.rerender(composer('메시지\n둘째 줄'));
  fireEvent(screen.getByTestId('chat-composer-text-input'), 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height: measuredLineHeight * 2 + 20 } } });
  expect(screen.getByTestId('chat-composer-text-input').props.textAlignVertical).toBe('top');
  const stackedInput = screen.getByTestId('chat-composer-text-input');
  expect(StyleSheet.flatten(stackedInput.props.style)).toMatchObject({ flex: 1, minHeight: Math.max(48, measuredLineHeight + 20) });
  expect(StyleSheet.flatten(stackedInput.props.style).width).toBeUndefined();
  expect(StyleSheet.flatten(stackedInput.props.style).height).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style)).toMatchObject({
    flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'stretch', columnGap: 0, rowGap: 0,
  });
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-input-row').props.style)).toMatchObject({
    flexDirection: 'row', alignItems: 'center', minWidth: 0,
    flexGrow: 0, flexShrink: 0, flexBasis: 'auto',
  });
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-controls-row').props.style).minHeight).toBe(hitTarget);
  expect(stackedInput.instance).toBe(textInputInstance);

  const attachmentIcon = screen.getByTestId('chat-composer-attach-visual').props.children as React.ReactElement<any>;
  const inputPaddingHorizontal = StyleSheet.flatten(stackedInput.props.style).paddingHorizontal;
  const expectedAttachmentLeft = inputPaddingHorizontal
    - (hitTarget - attachmentIcon.props.size) / 2
    - attachmentIcon.props.size * ADD_GLYPH_INSET_RATIO;
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-attach-slot').props.style)).toMatchObject({
    position: 'absolute',
    bottom: 0,
    left: expectedAttachmentLeft,
    height: hitTarget,
    alignItems: 'center',
    justifyContent: 'center',
  });
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-controls-spacer').props.style)).toMatchObject({
    flex: 1,
    minHeight: hitTarget,
    alignSelf: 'stretch',
    marginLeft: hitTarget + expectedAttachmentLeft,
  });
  const rightControlsAfterWrap = React.Children.toArray(
    screen.getByTestId('chat-composer-controls-row').props.children,
  )[1] as React.ReactElement<any>;
  expect(StyleSheet.flatten(rightControlsAfterWrap.props.style)).toEqual(rightControlsStyleBeforeWrap);

  screen.rerender(composer('짧게'));
  fireEvent(screen.getByTestId('chat-composer-text-input'), 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height: measuredLineHeight + 20 } } });
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style).flexDirection).toBe('column');
  screen.rerender(composer(''));
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-content-row').props.style).flexDirection).toBe('row');

  for (const name of ['attach', 'send']) {
    expect(StyleSheet.flatten(screen.getByTestId(`chat-composer-${name}-button`).props.style))
      .toMatchObject({ minWidth: hitTarget, minHeight: hitTarget });
    expect(StyleSheet.flatten(screen.getByTestId(`chat-composer-${name}-visual`).props.style))
      .toMatchObject({ width: 40, height: 40 });
  }
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-visual').props.style).backgroundColor)
    .not.toBe(StyleSheet.flatten(screen.getByTestId('chat-composer-attach-visual').props.style).backgroundColor);

  const contentOrder = React.Children.toArray(contentRow.props.children)
    .map((child: any) => child?.props?.testID);
  expect(contentOrder).toEqual([
    'chat-composer-attach-slot',
    'chat-composer-input-row',
    'chat-composer-controls-row',
  ]);
  expect(screen.getByTestId('chat-composer-attach-button')).toBeTruthy();
  expect(React.Children.toArray(rightControls.props.children).map((child: any) => child.props.testID)).toEqual([
    'interrupt-control',
    'chat-composer-voice-slot',
    'chat-composer-send-button',
  ]);
});

test('embedded delegates only outer padding; regular minimumBottomPadding and inner controls stay unchanged', () => {
  const props = { input: '본문', onChangeInput: jest.fn(), onPickAttachment: jest.fn(), onSend: jest.fn(), uploading: false, sending: false, voiceControls: null, minimumBottomPadding: 32 };
  const screen = render(<ChatComposer {...props} />);
  const inner = StyleSheet.flatten(screen.getByTestId('chat-composer-box').props.style);
  const send = StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style);
  expect(StyleSheet.flatten(screen.UNSAFE_getAllByType(View)[0].props.style).paddingBottom).toBe(32);
  screen.rerender(<ChatComposer {...props} embedded />);
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-row').props.style)).toMatchObject({ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 });
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-box').props.style)).toEqual(inner);
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-button').props.style)).toEqual(send);
});

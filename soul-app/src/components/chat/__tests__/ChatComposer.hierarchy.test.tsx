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
] as const)('%s composer는 글 칸을 위에 두고 visual40/frame%i 조작 줄을 유지한다', (
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
    flexDirection: 'column',
  });
  expect(boxStyle.height).toBeUndefined();
  expect(screen.queryByTestId('chat-composer-toolbar')).toBeNull();

  const input = screen.getByTestId('chat-composer-text-input');
  expect(StyleSheet.flatten(input.props.style).maxHeight).toBe(128);
  expect(StyleSheet.flatten(input.props.style).flex).toBeUndefined();
  expect(input.props.textAlignVertical).toBe('center');
  const controlsRow = screen.getByTestId('chat-composer-controls-row');
  const controlsRowStyle = StyleSheet.flatten(controlsRow.props.style);
  expect(controlsRowStyle).toMatchObject({
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  });
  const rightControls = React.Children.toArray(controlsRow.props.children)[1] as React.ReactElement<any>;
  expect(StyleSheet.flatten(rightControls.props.style)).toMatchObject({ flexDirection: 'row', gap: 6 });
  const deviceLineHeight = (dimensions.width >= 768 ? 18 : 17) * 1.3;
  const measuredLineHeight = deviceLineHeight * dimensions.fontScale;
  expect(StyleSheet.flatten(input.props.style).minHeight).toBe(Math.max(48, measuredLineHeight + 20));
  expect(StyleSheet.flatten(input.props.style).height).toBeUndefined();
  const controlsStyleBeforeExpansion = StyleSheet.flatten(controlsRow.props.style);
  screen.rerender(composer('메시지\n둘째 줄'));
  fireEvent(screen.getByTestId('chat-composer-text-input'), 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height: measuredLineHeight * 2 + 20 } } });
  expect(screen.getByTestId('chat-composer-text-input').props.textAlignVertical).toBe('top');
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-text-input').props.style).height).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-controls-row').props.style)).toEqual(controlsStyleBeforeExpansion);

  for (const name of ['attach', 'send']) {
    expect(StyleSheet.flatten(screen.getByTestId(`chat-composer-${name}-button`).props.style))
      .toMatchObject({ minWidth: hitTarget, minHeight: hitTarget });
    expect(StyleSheet.flatten(screen.getByTestId(`chat-composer-${name}-visual`).props.style))
      .toMatchObject({ width: 40, height: 40 });
  }
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-send-visual').props.style).backgroundColor)
    .not.toBe(StyleSheet.flatten(screen.getByTestId('chat-composer-attach-visual').props.style).backgroundColor);

  const contentOrder = React.Children.toArray(contentRow.props.children)
    .map((child: any) => child?.props?.testID)
    .filter(Boolean);
  expect(contentOrder).toEqual([
    'chat-composer-text-input',
    'chat-composer-controls-row',
  ]);
  const controlsOrder = React.Children.toArray(controlsRow.props.children)
    .map((child: any) => child?.props?.testID);
  expect(controlsOrder).toEqual([
    'chat-composer-attach-button',
    undefined,
  ]);
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

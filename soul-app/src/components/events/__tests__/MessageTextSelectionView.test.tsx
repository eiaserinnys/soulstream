const mockFocus = jest.fn();
const mockBlur = jest.fn();
const mockSetSelection = jest.fn();

jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { View } = require('react-native');

  return {
    EnrichedMarkdownTextInput: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        focus: mockFocus,
        blur: mockBlur,
        setSelection: mockSetSelection,
      }));
      return React.createElement(View, {
        ...props,
        testID: 'message-selection-markdown',
      });
    }),
  };
});

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { MessageTextSelectionView } from '../MessageTextSelectionView';

beforeEach(() => {
  mockFocus.mockClear();
  mockBlur.mockClear();
  mockSetSelection.mockClear();
});

describe('MessageTextSelectionView', () => {
  test('markdown 진입 시 editable=false로 focus 후 전체 선택한다', async () => {
    const onDone = jest.fn();
    const { getByTestId } = render(
      <MessageTextSelectionView
        model={{ kind: 'markdown', text: '**전체 선택**' }}
        onDone={onDone}
      />,
    );

    await waitFor(() => {
      expect(mockFocus).toHaveBeenCalledTimes(1);
      expect(mockSetSelection).toHaveBeenCalledTimes(1);
    });
    expect(mockSetSelection).toHaveBeenCalledWith(0, '**전체 선택**'.length);
    expect(getByTestId('message-selection-markdown').props).toMatchObject({
      editable: false,
      autoFocus: false,
      defaultValue: '**전체 선택**',
    });

    fireEvent(getByTestId('message-selection-markdown'), 'blur');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('plain text는 키보드를 열지 않는 read-only TextInput에서 전체 선택한다', () => {
    const onDone = jest.fn();
    const { getByTestId, getByText } = render(
      <MessageTextSelectionView
        model={{ kind: 'plain', text: '범위를 조절할 본문' }}
        onDone={onDone}
        variant="user"
        actionColor="#ffffff"
      />,
    );

    expect(getByTestId('message-selection-plain').props).toMatchObject({
      editable: false,
      showSoftInputOnFocus: false,
      multiline: true,
      selection: { start: 0, end: '범위를 조절할 본문'.length },
      selectionColor: '#07111f',
    });
    expect(getByText('완료').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ color: '#ffffff' })]),
    );

    fireEvent.press(getByTestId('message-selection-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

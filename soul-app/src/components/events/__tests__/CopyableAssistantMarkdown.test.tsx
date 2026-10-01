jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: (props: any) =>
      React.createElement(Text, props, props.markdown),
  };
});

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return (props: any) => React.createElement(Text, props, props.name);
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { CopyableAssistantMarkdown } from '../CopyableAssistantMarkdown';

const markdownStyle = {
  blockquote: {
    color: '#999999',
    backgroundColor: '#111111',
    borderColor: '#777777',
    borderWidth: 3,
    gapWidth: 8,
  },
};

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('CopyableAssistantMarkdown', () => {
  test('최상위 인용마다 작은 copy 아이콘과 44pt 터치 타깃을 렌더한다', () => {
    const { getByTestId } = render(
      <CopyableAssistantMarkdown
        markdown={['> 첫째', '', '> 둘째'].join('\n')}
        markdownStyle={markdownStyle}
      />,
    );

    for (const index of [0, 1]) {
      const button = getByTestId(`blockquote-copy-button-${index}`);
      const style = StyleSheet.flatten(button.props.style);
      expect(style.width).toBe(44);
      expect(style.height).toBe(44);
      expect(getByTestId(`blockquote-copy-icon-${index}`).props.name).toBe('copy-outline');
    }
  });

  test('각 버튼은 자기 인용의 렌더 본문만 복사하고 1600ms 동안 check로 바뀐다', async () => {
    jest.useFakeTimers();
    const { getByTestId } = render(
      <CopyableAssistantMarkdown
        markdown={[
          '> **첫째** [링크](https://example.com)',
          '',
          '> 둘째',
        ].join('\n')}
        markdownStyle={markdownStyle}
      />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('blockquote-copy-button-0'));
      await Promise.resolve();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('첫째 링크');
    expect(getByTestId('blockquote-copy-icon-0').props.name).toBe('checkmark');
    expect(getByTestId('blockquote-copy-feedback-0').props.children)
      .toBe('인용문을 복사했습니다');
    expect(AccessibilityInfo.announceForAccessibility)
      .toHaveBeenCalledWith('인용문을 복사했습니다');

    act(() => {
      jest.advanceTimersByTime(1600);
    });
    expect(getByTestId('blockquote-copy-icon-0').props.name).toBe('copy-outline');
  });

  test('복사 실패는 버튼을 늘리지 않고 접근성 피드백으로 알린다', async () => {
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    const { getByTestId, getAllByRole } = render(
      <CopyableAssistantMarkdown
        markdown="> 거부된 인용"
        markdownStyle={markdownStyle}
      />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('blockquote-copy-button-0'));
      await Promise.resolve();
    });

    expect(getAllByRole('button')).toHaveLength(1);
    expect(getByTestId('blockquote-copy-icon-0').props.name).toBe('copy-outline');
    expect(getByTestId('blockquote-copy-feedback-0').props.children)
      .toBe('인용문을 복사하지 못했습니다');
    expect(AccessibilityInfo.announceForAccessibility)
      .toHaveBeenCalledWith('인용문을 복사하지 못했습니다');
  });

  test('인용이 없으면 기존 native markdown 단일 렌더 계약을 유지한다', () => {
    const onLinkPress = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <CopyableAssistantMarkdown
        markdown="[링크](https://example.com)"
        markdownStyle={markdownStyle}
        onLinkPress={onLinkPress}
      />,
    );

    expect(queryByTestId('blockquote-copy-button-0')).toBeNull();
    expect(getByTestId('assistant-markdown').props).toMatchObject({
      flavor: 'github',
      selectable: false,
      onLinkPress,
    });
  });
});

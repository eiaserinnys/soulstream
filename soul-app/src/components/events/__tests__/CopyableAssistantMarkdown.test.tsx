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
  codeBlock: {
    backgroundColor: '#222222',
    borderRadius: 6,
    marginTop: 12,
    marginBottom: 16,
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

  test('짧고 긴 코드블록 모두 44pt 버튼과 분리된 본문 여백을 가진다', () => {
    const { getByTestId } = render(
      <CopyableAssistantMarkdown
        markdown={['```', 'x', '```', '', '```ts', 'const first = "a long first line";', 'const second = true;', '```'].join('\n')}
        markdownStyle={markdownStyle}
      />,
    );

    for (const index of [0, 1]) {
      const frame = getByTestId(`codeblock-copy-frame-${index}`);
      const frameStyle = StyleSheet.flatten(frame.props.style);
      const content = getByTestId(`codeblock-markdown-${index}`);
      const button = getByTestId(`codeblock-copy-button-${index}`);
      const buttonStyle = StyleSheet.flatten(button.props.style);

      expect(frameStyle).toMatchObject({
        backgroundColor: '#222222',
        borderRadius: 6,
        marginTop: 12,
        marginBottom: 16,
        minHeight: 44,
        justifyContent: 'center',
      });
      expect(StyleSheet.flatten(content.props.containerStyle).paddingRight).toBe(44);
      expect(content.props.markdownStyle.codeBlock).toMatchObject({ marginTop: 0, marginBottom: 0 });
      expect(buttonStyle).toMatchObject({ position: 'absolute', top: 0, right: 0, width: 44, height: 44 });
      expect(button.props.accessibilityLabel).toBe('코드 복사');
      expect(button.props.accessibilityState).toEqual({ busy: false });
      expect(StyleSheet.flatten(getByTestId(`codeblock-copy-icon-${index}`).props.style).opacity).toBe(0.75);
    }
  });

  test('코드 펜스와 태그를 제외한 본문을 복사하고 실패를 접근성 피드백으로 알린다', async () => {
    jest.useFakeTimers();
    const { getByTestId, getAllByRole } = render(
      <CopyableAssistantMarkdown
        markdown={'```ts\nconst answer = 42;\n```'}
        markdownStyle={markdownStyle}
      />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('codeblock-copy-button-0'));
      await Promise.resolve();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('const answer = 42;');
    expect(getByTestId('codeblock-copy-icon-0').props.name).toBe('checkmark');
    expect(getByTestId('codeblock-copy-feedback-0').props.children).toBe('코드를 복사했습니다');
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('코드를 복사했습니다');
    act(() => jest.advanceTimersByTime(1600));
    expect(getByTestId('codeblock-copy-icon-0').props.name).toBe('copy-outline');

    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    await act(async () => {
      fireEvent.press(getByTestId('codeblock-copy-button-0'));
      await Promise.resolve();
    });
    expect(getAllByRole('button')).toHaveLength(1);
    expect(getByTestId('codeblock-copy-feedback-0').props.children).toBe('코드를 복사하지 못했습니다');
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith('코드를 복사하지 못했습니다');
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

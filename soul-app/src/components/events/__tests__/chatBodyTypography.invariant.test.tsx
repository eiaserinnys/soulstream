import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

jest.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: () => null }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import type { SessionEvent } from '../../../api/types';

const event = (type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent => ({
  id: `${type}-1`,
  type,
  data,
});

test.each([
  ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 17],
  ['phone large text', { width: 390, height: 844, scale: 3, fontScale: 2 }, 17],
  ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 18],
  ['iPad large text', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 18],
] as const)('%s 일반 사용자/assistant 본문과 bubble padding은 N9에서 불변이다', (
  _label,
  dimensions,
  bodySize,
) => {
  mockDimensions = dimensions;
  const user = render(<UserMessage event={event('user_message', { text: '사용자 본문' })} />);
  const assistant = render(
    <AssistantMessage event={event('text_delta', { text: 'assistant 본문', _live_only: true })} />,
  );

  for (const [screen, textId, bubbleId] of [
    [user, 'user-message-text', 'user-message-bubble'],
    [assistant, 'assistant-streaming-text', 'assistant-message-bubble'],
  ] as const) {
    expect(StyleSheet.flatten(screen.getByTestId(textId).props.style)).toMatchObject({
      fontSize: bodySize,
      lineHeight: bodySize * 1.3,
    });
    expect(StyleSheet.flatten(screen.getByTestId(bubbleId).props.style)).toMatchObject({
      paddingHorizontal: 16,
      paddingVertical: 14,
    });
  }
});

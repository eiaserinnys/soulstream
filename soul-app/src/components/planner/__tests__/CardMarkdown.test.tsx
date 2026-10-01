import React from 'react';
import { render, renderHook } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import { useSettingsStore } from '../../../store/settingsStore';

jest.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: (props: any) => require('react').createElement(require('react-native').Text, { ...props, testID: 'markdown' }, props.markdown) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockDimensions }));

import { AssistantMessage } from '../../events/AssistantMessage';
import { PlannerMarkdownText } from '../PlannerMarkdownText';
import { CardReportView } from '../CardReportView';

afterEach(() => useSettingsStore.setState({ appearance: 'system' }));

test.each([
  [390, 'light', 17, 22],
  [1024, 'dark', 18, 23],
] as const)('카드 마크다운은 %s %s 채팅 스타일을 공유하며 제목만 16pt이다', (width, appearance, bodySize, headingSize) => {
  mockDimensions = { ...mockDimensions, width };
  useSettingsStore.setState({ appearance });
  const markdown = '# 제목\n\n- [ ] 할 일\n- [x] 한 일\n\n`코드`';
  const chat = render(<AssistantMessage event={{ id: 'message', type: 'assistant_message', data: { text: markdown } }} />);
  const card = render(<PlannerMarkdownText markdown={markdown} variant="card" />);
  const report = render(<CardReportView report={{ id: 'report', cardId: 'card', title: '보고', format: 'markdown', body: markdown, createdAt: '' }} />);
  const chatStyle = chat.getByTestId('markdown').props.markdownStyle;
  const cardStyle = card.getByTestId('markdown').props.markdownStyle;
  expect(chatStyle.paragraph.fontSize).toBe(bodySize);
  expect(chatStyle.h1.fontSize).toBe(headingSize);
  for (const key of ['paragraph', 'list', 'code', 'codeBlock', 'blockquote', 'table', 'taskList']) {
    expect(cardStyle[key]).toEqual(chatStyle[key]);
  }
  const { result } = renderHook(() => useTokens());
  for (const key of ['h1', 'h2', 'h3']) {
    expect(cardStyle[key]).toEqual({ color: result.current.colors.textPrimary, ...result.current.foundation.typography.cardTitle });
  }
  expect(cardStyle).toEqual(report.getByTestId('markdown').props.markdownStyle);
  expect(card.getByTestId('markdown').props.flavor).toBe('github');
  // 폴더/편집기 소비자의 기본 스타일은 그대로 유지한다.
  const folder = render(<PlannerMarkdownText markdown={markdown} />);
  expect(folder.getByTestId('markdown').props.markdownStyle).toMatchObject({ paragraph: { fontSize: 15 }, h1: { fontSize: 28 }, h2: { fontSize: 18 }, h3: { fontSize: 16 } });
});

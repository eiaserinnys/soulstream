import React from 'react';
import { fireEvent, render, renderHook, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
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
import { CardTimeline } from '../CardTimeline';
import { cardFixture } from '../../../test-support/cards';

afterEach(() => useSettingsStore.setState({ appearance: 'system' }));

test('보고 폭 계약은 접기와 펼치기에서 같고 질문과 에이전트 커멘트는 내용 폭을 유지한다', () => {
  const card = cardFixture({ id: 'width-card', request: '지시', assigneeAgentId: 'roselin', createdAt: '2026-10-01T00:00:00Z' });
  const screen = render(<CardTimeline detail={{ card, sessions: [],
    reports: [{ id: 'width', cardId: card.id, title: '보고', format: 'markdown', body: '이미지가 없는 긴 한국어 보고 본문을 펼쳐도 말풍선 폭이 유지되어야 합니다.', createdAt: '2026-10-01T00:02:00Z' }],
    questions: [{ id: 'question', cardId: card.id, sessionId: 'roselin-session', text: '짧은 질문', options: null, answer: null, askedAt: '2026-10-01T00:01:00Z' }],
    comments: [{ id: 'comment', cardId: card.id, authorKind: 'agent', authorId: 'roselin', sessionId: null, kind: 'comment', body: '짧은 커멘트', createdAt: '2026-10-01T00:03:00Z' }],
  }} onChooseAnswer={() => {}} />);
  const bubbleStyle = () => StyleSheet.flatten(within(screen.getByTestId('card-fold-report-width')).getByTestId('assistant-message-bubble').props.style);
  const collapsed = bubbleStyle();
  expect(collapsed).toMatchObject({ flexGrow: 1, flexShrink: 1, maxWidth: '86%' });
  const neighbors = () => screen.getAllByTestId('assistant-message-bubble').filter((_, index) => index !== 1).map(bubble => StyleSheet.flatten(bubble.props.style));
  const before = neighbors();
  expect(before).toHaveLength(2);
  for (const style of before) expect(style.flexGrow).toBeUndefined();
  fireEvent.press(screen.getByLabelText('report-width 자세히'));
  expect(screen.getByTestId('card-report-markdown-width')).toBeTruthy();
  expect(bubbleStyle()).toEqual(collapsed);
  expect(neighbors()).toEqual(before);
  fireEvent.press(screen.getByLabelText('report-width 접기'));
  expect(screen.queryByTestId('card-report-markdown-width')).toBeNull();
  expect(bubbleStyle()).toEqual(collapsed);
});

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
  expect(report.getByTestId('markdown').props.markdownStyle).toMatchObject(cardStyle);
  expect(card.getByTestId('markdown').props.flavor).toBe('github');
  // 폴더/편집기 소비자의 기본 스타일은 그대로 유지한다.
  const folder = render(<PlannerMarkdownText markdown={markdown} />);
  expect(folder.getByTestId('markdown').props.markdownStyle).toMatchObject({ paragraph: { fontSize: 15 }, h1: { fontSize: 28 }, h2: { fontSize: 18 }, h3: { fontSize: 16 } });
});

test.each([390, 1194])('펼친 보고 %s는 기존 썸네일 간격과 전체폭 왼쪽 본문을 사용한다', (width) => {
  mockDimensions = { ...mockDimensions, width };
  useSettingsStore.setState({ serverUrl: 'https://cards.test' });
  const screen = render(<CardReportView report={{ id: 'aligned', cardId: 'card', title: '보고', format: 'markdown',
    body: '본문\n\n![첫 사진](https://cards.test/one.png)\n![둘째 사진](https://cards.test/two.png)\n\n마지막', createdAt: '' }} />);
  const { result } = renderHook(() => useTokens());
  expect(StyleSheet.flatten(screen.getByTestId('card-report-markdown-aligned').props.style))
    .toMatchObject({ gap: result.current.uiSpacing.sm, width: '100%', alignSelf: 'stretch', alignItems: 'flex-start' });
  for (const markdown of screen.getAllByTestId('markdown')) {
    expect(markdown.props.containerStyle).toMatchObject({ width: '100%', textAlign: 'left' });
    for (const key of ['paragraph', 'h1', 'h2', 'h3']) expect(markdown.props.markdownStyle[key].textAlign).toBe('left');
  }
});

import React from 'react';
import { fireEvent, render, renderHook, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { createPlannerVisualRoles, createSessionVisualRoles, useTokens } from '../../../theme';
import { LIGHT_COLORS } from '../../../theme/colors';
import { createAssistantMarkdownStyle } from '../../../theme/assistantMarkdownStyle';
import { plannerMarkdownStyle } from '../PlannerMarkdownText';
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

test('노트 기록 본문은 보조 색 15/22이고 기본 마크다운의 글자색은 그대로다', () => {
  const screen = render(<PlannerMarkdownText markdown="기록 본문" variant="note" />);
  const { result } = renderHook(() => useTokens());
  expect(screen.getByTestId('markdown').props.markdownStyle.paragraph).toMatchObject({
    color: result.current.colors.textSecondary, fontSize: 15, lineHeight: 22,
  });
  screen.rerender(<PlannerMarkdownText markdown="기록 본문" />);
  expect(screen.getByTestId('markdown').props.markdownStyle.paragraph.color).toBe(result.current.colors.textPrimary);
});

test('보고 폭 계약은 접기와 펼치기에서 같고 질문과 에이전트 커멘트는 내용 폭을 유지한다', () => {
  const card = cardFixture({ id: 'width-card', request: '지시', assigneeAgentId: 'roselin', createdAt: '2026-10-01T00:00:00Z' });
  const screen = render(<CardTimeline detail={{ card, sessions: [],
    reports: [{ id: 'width', cardId: card.id, title: '보고', format: 'markdown', body: '이미지가 없는 긴 한국어 보고 본문을 펼쳐도 말풍선 폭이 유지되어야 합니다.', createdAt: '2026-10-01T00:02:00Z' }],
    questions: [{ id: 'question', cardId: card.id, sessionId: 'roselin-session', text: '짧은 질문', options: null, answer: null, askedAt: '2026-10-01T00:01:00Z' }],
    comments: [{ id: 'comment', cardId: card.id, authorKind: 'agent', authorId: 'roselin', sessionId: null, kind: 'comment', body: '짧은 커멘트', createdAt: '2026-10-01T00:03:00Z' }],
  }} onChooseAnswer={() => {}} />);
  const bubbleStyle = () => StyleSheet.flatten(within(screen.getByTestId('card-fold-report-width')).getByTestId('assistant-message-bubble').props.style);
  for (const message of screen.UNSAFE_getAllByType(AssistantMessage)) expect(message.props.rowInset).toBe('none');
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

test('철회 질문은 사유를 표시하고 답 선택지를 숨기며 열린 질문 선택지는 유지한다', () => {
  const card = cardFixture({ id: 'withdrawal-card', request: '지시', assigneeAgentId: 'roselin', createdAt: '2026-10-01T00:00:00Z' });
  const withdrawalReason = '커멘트에서 B안으로 정해져 거둡니다';
  const screen = render(<CardTimeline detail={{ card, sessions: [], reports: [], comments: [], questions: [
    { id: 'withdrawn', cardId: card.id, sessionId: 'roselin-session', text: '어느 안으로 할까요?', options: ['A안', 'B안'], answer: null,
      askedAt: '2026-10-01T00:01:00Z', withdrawnAt: '2026-10-01T00:02:00Z', withdrawalReason },
    { id: 'open', cardId: card.id, sessionId: 'roselin-session', text: '아직 답을 보내지 않은 질문입니다.', options: ['확인했습니다'], answer: null,
      askedAt: '2026-10-01T00:03:00Z' },
  ] }} onChooseAnswer={() => {}} />);

  expect(screen.getByText('철회됨')).toBeTruthy();
  expect(screen.getByTestId('card-question-withdrawal-question-withdrawn').props.children).toBe(withdrawalReason);
  expect(screen.queryByLabelText('A안')).toBeNull();
  expect(screen.queryByLabelText('B안')).toBeNull();
  expect(screen.getByLabelText('확인했습니다')).toBeTruthy();
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
  for (const key of ['h4', 'h5', 'h6']) expect(cardStyle[key]).toEqual(chatStyle[key]);
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

test('planner 표는 채팅 마크다운의 토큰 스타일을 공유한다', () => {
  const { result } = renderHook(() => useTokens());
  const chatTable = createAssistantMarkdownStyle(result.current).table;
  const planner = render(<PlannerMarkdownText markdown="| A | B |\n| --- | --- |\n| 값 | 값 |" />);

  expect(planner.getByTestId('markdown').props.markdownStyle.table).toEqual(chatTable);
});

test('planner와 채팅 마크다운의 h4~h6 및 구분선·코드 테두리는 테마 토큰을 쓴다', () => {
  const { result } = renderHook(() => useTokens());
  const roles = createPlannerVisualRoles(result.current);
  const planner = render(<PlannerMarkdownText markdown="#### 넷째\n\n##### 다섯째\n\n###### 여섯째\n\n---\n\n`코드`\n\n```ts\nconst ok = true;\n```" />);
  const plannerStyle = planner.getByTestId('markdown').props.markdownStyle;

  for (const key of ['h4', 'h5', 'h6']) {
    expect(plannerStyle[key]).toEqual({
      color: result.current.colors.textPrimary,
      ...roles.typography.body,
      fontWeight: '700',
    });
  }
  expect(plannerStyle.thematicBreak).toEqual({ color: result.current.colors.border });
  expect(plannerStyle.code.borderColor).toBe(result.current.colors.border);
  expect(plannerStyle.codeBlock).toMatchObject({ borderColor: result.current.colors.accent, borderWidth: 0 });

  for (const narration of [false, true]) {
    const chatStyle = createAssistantMarkdownStyle(result.current, narration);
    expect(chatStyle.h4).toEqual(chatStyle.h3);
    expect(chatStyle.h5).toEqual(chatStyle.h3);
    expect(chatStyle.h6).toEqual(chatStyle.h3);
    expect(chatStyle.thematicBreak).toEqual({ color: result.current.colors.border });
    expect(chatStyle.code).toMatchObject({ borderColor: result.current.colors.border });
    expect(chatStyle.codeBlock).toMatchObject({ borderColor: result.current.colors.accent, borderWidth: 0 });
  }
});

test('planner 체크 완료 항목은 본문 색상으로 표시한다', () => {
  const { result } = renderHook(() => useTokens());
  const planner = render(<PlannerMarkdownText markdown="- [x] 완료" />);

  expect(planner.getByTestId('markdown').props.markdownStyle.taskList.checkedTextColor)
    .toBe(result.current.colors.textPrimary);
});

test('HTML 카드 보고서는 문서 기본 바탕으로 렌더된다', () => {
  const report = render(<CardReportView report={{
    id: 'html-report', cardId: 'card', title: '보고', format: 'html',
    body: '<h1>HTML 보고</h1>', createdAt: '',
  }} />);
  const webView = report.getByTestId('card-report-html-html-report');
  const { result } = renderHook(() => useTokens());

  expect(webView.props.source.html).toContain('<style>:where(:root){color-scheme:light;}</style>');
  expect(webView.props.style.backgroundColor).toBe(LIGHT_COLORS.background);
  expect(StyleSheet.flatten(report.getByTestId('card-report-html-frame-html-report').props.style))
    .toEqual({ overflow: 'hidden', borderRadius: createSessionVisualRoles(result.current).chat.attachment.radius });
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

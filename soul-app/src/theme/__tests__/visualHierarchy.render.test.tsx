import React from 'react';
import { Animated, StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { PlannerFolder } from '../../api/plannerTypes';
import type { Session } from '../../api/types';

const mockUsePlannerTaskRuns = jest.fn();

let mockDeviceType: 'phone' | 'tabletPortrait' = 'phone';

jest.mock('../useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../hooks/usePlannerReads', () => ({
  usePlannerFolderSessions: (...args: unknown[]) => mockUsePlannerTaskRuns(...args),
}));
jest.mock('../../components/useSessionCardAnimation', () => ({
  useSessionCardAnimation: () => {
    const { Animated: MockAnimated } = require('react-native');
    return {
      pulse: new MockAnimated.Value(0),
      shimmer: new MockAnimated.Value(0),
      reducedMotion: false,
      appActive: true,
      animationEnabled: false,
    };
  },
}));

jest.spyOn(Animated, 'loop').mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  reset: jest.fn(),
} as any));

import { GroupedGlassSheet } from '../../components/planner/GroupedGlassSheet';
import { PlannerFolderRow } from '../../components/planner/PlannerFolderRow';
import { ToolEvent } from '../../components/events/ToolEvent';
import { SessionCard } from '../../components/SessionCard';
import { FolderSessionHistory } from '../../components/planner/FolderSessionHistory';
import { ClaudeRuntimeTasksStrip } from '../../components/chat/ClaudeRuntimeTasksStrip';
import { ClaudeRuntimeSignalsStrip } from '../../components/chat/ClaudeRuntimeSignalsStrip';
import { AssistantMessage } from '../../components/events/AssistantMessage';
import { UserMessage } from '../../components/events/UserMessage';
import { ChatComposer } from '../../components/chat/ChatComposer';
import { useSessionStore } from '../../store/sessionStore';
import { useChatStore } from '../../store/chatStore';

const folder = {
  page: { id: 'task', title: '시각 위계', metadata: {} },
  blocks: [],
  status: 'open',
  assignee: '로젤린',
  contextCount: 0,
  progress: null,
  sessions: [],
  sessionIds: [],

} as unknown as PlannerFolder;

test.each([
  ['phone', 17, 16, 16],
  ['tabletPortrait', 18, 16, 16],
] as const)('%s 실제 렌더에서 phone 제목 불변·iPad 제목 -2pt와 tool/runtime 비변경을 고정한다', (device, chatBody, cardTitle, cardPadding) => {
  mockDeviceType = device;
  const card = render(<GroupedGlassSheet><PlannerFolderRow folder={folder} /></GroupedGlassSheet>);
  const tool = render(<ToolEvent start={{ id: '1', type: 'tool_start', data: { tool_name: 'Bash' } }} />);

  expect(StyleSheet.flatten(card.getByText('시각 위계').props.style).fontSize).toBe(cardTitle);
  expect(StyleSheet.flatten(card.getByTestId('planner-task-row-task').props.style).paddingHorizontal)
    .toBe(cardPadding);
  expect(StyleSheet.flatten(tool.getByText('Bash').props.style).fontSize).toBeLessThan(chatBody);
  expect(StyleSheet.flatten(tool.getByTestId('tool-event-header-visual').props.style).minHeight).toBe(40);
});

test.each([
  ['phone', 17, 44],
  ['tabletPortrait', 18, 48],
] as const)('%s 실제 렌더에서 세션·실행 이력·런타임·채팅 위계와 밀도를 함께 고정한다', async (
  device,
  chatBody,
  touchTarget,
) => {
  mockDeviceType = device;
  const sessionId = `visual-${device}`;
  const session = {
    agentSessionId: sessionId,
    displayName: '세션 카드 제목',
    status: 'running',
    reviewRequired: true,
    reviewState: 'needs_review',
    agentName: '로젤린',
    nodeId: 'eiaserinnys',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:01:00.000Z',
  } satisfies Session;
  useSessionStore.setState({
    sessions: { [sessionId]: session },
    catalog: { folders: [], sessions: {} },
  });
  mockUsePlannerTaskRuns.mockReturnValue({
    data: { items: [{ agentSessionId: sessionId }], nextCursor: null, total: 1 },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useChatStore.setState({
    claudeRuntimeBySession: {
      [sessionId]: {
        updatedAt: 100,
        tasks: {
          folder: {
            taskId: 'task',
            status: 'running',
            updatedAt: 100,
            taskType: 'bash',
            summary: 'runtime task summary',
          },
        },
        schedules: {},
        notifications: {
          notice: {
            notificationId: 'notice',
            source: 'system',
            title: '런타임 알림',
            message: 'runtime notification',
            updatedAt: 100,
          },
        },
        remoteTriggers: {},
      },
    },
  });

  const card = render(<SessionCard session={session} onPress={jest.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(card.getByTestId('session-card-agent-avatar')).toBeTruthy();
  expect(card.getByText('검수 필요')).toBeTruthy();
  expect(card.queryByText('실행 중')).toBeNull();
  expect(card.getByText('로젤린')).toBeTruthy();
  expect(card.getByText('eiaserinnys')).toBeTruthy();
  expect(card.getByTestId('session-card-time')).toBeTruthy();
  expect(StyleSheet.flatten(card.getByText('세션 카드 제목').props.style)).toMatchObject({
    fontSize: 16,
    lineHeight: 22,
  });
  expect(StyleSheet.flatten(card.getByText('로젤린').props.style).fontSize).toBeLessThan(chatBody);
  expect(StyleSheet.flatten(card.getByTestId('session-card-pressable').props.style).minHeight).toBe(112);
  const sessionStyle = StyleSheet.flatten(card.getByTestId('session-card-pressable').props.style);
  expect(sessionStyle.paddingHorizontal).toBe(16);
  expect(sessionStyle.paddingVertical).toBe(16);
  expect(StyleSheet.flatten(card.getByTestId('session-card-agent-avatar').props.style)).toMatchObject({
    width: 44,
    height: 44,
  });
  expect(
    StyleSheet.flatten(card.getByTestId('session-card-right-rail').props.style),
  ).toMatchObject({
    width: 76,
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  });

  const history = render(
    <FolderSessionHistory
      api={null}
      folderId="task-page"
      onOpenSession={jest.fn()}
    />,
  );
  const historyContainerStyle = StyleSheet.flatten(
    history.getByTestId('task-run-history-list').props.style,
  );
  const historySurfaceStyle = StyleSheet.flatten(
    history.getByTestId(`task-run-surface-${sessionId}`).props.style,
  );
  expect(historyContainerStyle.gap).toBe(8);
  expect(historySurfaceStyle.marginVertical).toBe(0);
  expect(historyContainerStyle.gap + (historySurfaceStyle.marginVertical * 2)).toBe(8);
  expect(history.getByTestId(`task-run-avatar-${sessionId}`)).toBeTruthy();
  expect(history.getByText('검수 필요')).toBeTruthy();
  expect(history.queryByText('실행 중')).toBeNull();
  expect(history.getByText('로젤린')).toBeTruthy();
  expect(history.getByText('eiaserinnys')).toBeTruthy();
  expect(history.getByTestId(`task-run-time-${sessionId}`)).toBeTruthy();
  expect(StyleSheet.flatten(history.getByText('세션 카드 제목').props.style).fontSize).toBe(16);
  const historyStyle = StyleSheet.flatten(history.getByTestId(`task-run-row-${sessionId}`).props.style);
  expect(historyStyle.minHeight).toBe(112);
  expect(historyStyle.paddingVertical).toBe(16);

  const tasks = render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={null} />);
  expect(StyleSheet.flatten(tasks.getByTestId('runtime-tasks-strip').props.style).paddingVertical).toBe(0);
  fireEvent.press(tasks.getByText('Claude Runtime Tasks'));
  expect(StyleSheet.flatten(tasks.getByTestId('runtime-task-row-task').props.style).minHeight).toBe(40);
  expect(StyleSheet.flatten(tasks.getByText('Claude Runtime Tasks').props.style).fontSize).toBeLessThan(chatBody);

  const signals = render(<ClaudeRuntimeSignalsStrip sessionId={sessionId} api={null} />);
  expect(StyleSheet.flatten(signals.getByTestId('runtime-signals-strip').props.style).paddingVertical).toBe(0);
  expect(StyleSheet.flatten(signals.getByText('Runtime Signals').props.style).fontSize).toBeLessThan(chatBody);
  fireEvent.press(signals.getByText('Runtime Signals'));
  expect(StyleSheet.flatten(signals.getByTestId('runtime-signal-row-notice').props.style).minHeight).toBe(40);

  const assistant = render(
    <AssistantMessage
      event={{ id: 'assistant', type: 'text_delta', data: { text: '기존 채팅 본문' } }}
      session={session}
    />,
  );
  expect(StyleSheet.flatten(assistant.getByTestId('assistant-streaming-text').props.style).fontSize).toBe(chatBody);
  expect(StyleSheet.flatten(assistant.getByTestId('assistant-message-bubble').props.style)).toMatchObject({
    paddingHorizontal: 16,
    paddingVertical: 14,
    maxWidth: '86%',
  });

  const user = render(
    <UserMessage
      event={{ id: 'user', type: 'user_message', data: { text: '사용자 메시지' } }}
      session={session}
    />,
  );
  expect(StyleSheet.flatten(user.getByTestId('user-message-bubble').props.style)).toMatchObject({
    paddingHorizontal: 16,
    paddingVertical: 14,
    maxWidth: '86%',
  });

  const composer = render(
    <ChatComposer
      input="메시지"
      onChangeInput={jest.fn()}
      onPickAttachment={jest.fn()}
      onSend={jest.fn()}
      uploading={false}
      sending={false}
      voiceControls={null}
    />,
  );
  expect(StyleSheet.flatten(composer.getByTestId('chat-composer-box').props.style).minHeight).toBe(56);
  expect(StyleSheet.flatten(composer.getByTestId('chat-composer-attach-button').props.style)).toMatchObject({
    minWidth: touchTarget,
    minHeight: touchTarget,
  });
  expect(StyleSheet.flatten(composer.getByTestId('chat-composer-send-button').props.style)).toMatchObject({
    minWidth: touchTarget,
    minHeight: touchTarget,
  });
});

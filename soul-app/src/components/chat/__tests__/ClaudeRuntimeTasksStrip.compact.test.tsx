import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { ClaudeRuntimeTasksStrip } from '../ClaudeRuntimeTasksStrip';
import { useChatStore } from '../../../store/chatStore';

const SID = 'sess-runtime-tasks-compact';

test('런타임 작업은 한 줄 ellipsis와 시각 박스에서 분리된 터치 영역을 사용한다', () => {
  const summary = '/very/long/worktree/path '.repeat(12).trim();
  useChatStore.setState({
    claudeRuntimeBySession: {
      [SID]: {
        updatedAt: 100,
        tasks: {
          'task-long': {
            taskId: 'task-long-identifier-that-must-truncate',
            status: 'running',
            updatedAt: 100,
            taskType: 'bash',
            summary,
          },
        },
        schedules: {},
        notifications: {},
        remoteTriggers: {},
      },
    },
  });

  const screen = render(<ClaudeRuntimeTasksStrip sessionId={SID} api={null} />);
  fireEvent.press(screen.getByText('Claude Runtime Tasks'));

  expect(screen.getByText(summary).props.numberOfLines).toBe(1);
  expect(screen.getByText(summary).props.ellipsizeMode).toBe('tail');
  expect(screen.getByText('task-long-identifier-that-must-truncate').props.ellipsizeMode).toBe('tail');
  expect(StyleSheet.flatten(screen.getByText('running').props.style).minHeight).toBeUndefined();
  const outputButton = screen.getByLabelText('출력 보기');
  const outputVisual = screen.getByTestId(
    'runtime-task-output-visual-task-long-identifier-that-must-truncate',
  );
  const outputFrame = StyleSheet.flatten(outputButton.props.style);
  expect(outputFrame.minWidth).toBeGreaterThanOrEqual(44);
  expect(outputFrame.minHeight).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(outputVisual.props.style)).toMatchObject({
    width: 28,
    height: 28,
  });
  expect(outputButton.props.hitSlop).toBeUndefined();
});

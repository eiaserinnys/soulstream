import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { ClaudeRuntimeTasksStrip, ClaudeRuntimeTaskOutputModal } from '../ClaudeRuntimeTasksStrip';
import { useChatStore } from '../../../store/chatStore';

import { createDialogueApi, reviewTask } from '../../../component-review/dialogue-fixtures';

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

test('운영 출력 버튼으로 원본 모달을 열고 닫으며 표면 렌더를 보존한다', async () => {
  const api = createDialogueApi();
  useChatStore.getState().setClaudeRuntimeTasks('public-idle', {
    sessionId: 'public-idle', sessionState: 'idle', runtimeSessionId: null, updatedAt: 1, tasks: [reviewTask],
  });
  const screen = render(<ClaudeRuntimeTasksStrip sessionId="public-idle" api={api} />);
  fireEvent.press(screen.getByText('Claude Runtime Tasks'));
  await act(async () => fireEvent.press(screen.getByLabelText('출력 보기')));
  await waitFor(() => expect(screen.getByTestId('runtime-output-modal')).toBeTruthy());
  expect(findOutputTree(screen.toJSON())).toMatchSnapshot();
  fireEvent.press(screen.getByLabelText('닫기'));
  expect(screen.queryByTestId('runtime-output-modal')).toBeNull();
});

test('검수도 같은 출력 모달에 fixture를 전달하여 즉시 열고 닫는다', async () => {
  const output = await createDialogueApi().getClaudeBackgroundTaskOutput('public-idle', 'public-task');
  const close = jest.fn();
  const screen = render(<ClaudeRuntimeTaskOutputModal output={output} onClose={close} />);
  expect(screen.getByText(output.output!)).toBeTruthy();
  expect(screen.getByTestId('runtime-output-modal')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('닫기'));
  expect(close).toHaveBeenCalledTimes(1);
});

function findOutputTree(tree: any): any {
  if (!tree) return null;
  if (Array.isArray(tree)) return tree.map(findOutputTree).find(Boolean) ?? null;
  if (tree.props?.testID === 'runtime-output-modal') return tree;
  return findOutputTree(tree.children);
}

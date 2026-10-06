jest.mock('./../useClaudeRuntimeListRefresh', () => ({
  useClaudeRuntimeTasksRefresh: () => ({ loading: false, recoveryNeeded: false, refresh: jest.fn() }),
  useClaudeRuntimeSchedulesRefresh: () => ({ loading: false, recoveryNeeded: false, refresh: jest.fn() }),
}));
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ChatRuntimeStrips } from '../ChatRuntimeStrips';
import { useChatStore } from '../../../store/chatStore';

function setRows(kinds: string[]) {
  useChatStore.setState({ claudeRuntimeBySession: { pas: {
    tasks: kinds.includes('tasks') ? { task: { taskId: 'task', status: 'running', updatedAt: 1 } } : {},
    schedules: kinds.includes('schedules') ? { schedule: { scheduleId: 'schedule', status: 'active', updatedAt: 1 } } : {},
    notifications: kinds.includes('signals') ? { notification: { notificationId: 'notification', message: '신호', updatedAt: 1 } } : {},
    remoteTriggers: {},
  } as any } });
}
test.each([['tasks', 'schedules', 'signals'], ['tasks'], ['schedules'], ['signals'], []])(
  '원고형 실제 보조 줄 %j은 마지막 아래 테두리만 없고 줄 사이는 한 겹이다', (...kinds) => {
    setRows(kinds);
    const view = render(<ChatRuntimeStrips sessionId="pas" api={null} presentation="manuscript" />);
    const rows = view.queryAllByTestId(/^runtime-(tasks|schedules|signals)-strip$/);
    expect(rows.map(row => row.props.testID)).toEqual(kinds.map(kind => `runtime-${kind}-strip`));
    rows.forEach((row, index) => expect(StyleSheet.flatten(row.props.style).borderBottomWidth).toBe(index === rows.length - 1 ? 0 : StyleSheet.hairlineWidth));
  },
);
test('뒤 보조 줄이 없어지면 남은 줄이 틀의 선을 마지막 경계로 사용한다', () => {
  setRows(['tasks', 'schedules']);
  const view = render(<ChatRuntimeStrips sessionId="pas" api={null} presentation="manuscript" />);
  expect(StyleSheet.flatten(view.getByTestId('runtime-tasks-strip').props.style).borderBottomWidth).toBe(StyleSheet.hairlineWidth);
  act(() => setRows(['tasks']));
  expect(StyleSheet.flatten(view.getByTestId('runtime-tasks-strip').props.style).borderBottomWidth).toBe(0);
});

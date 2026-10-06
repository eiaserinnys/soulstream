import React from 'react';
import { render, renderHook } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useTokens } from '../../../theme';
import { SessionStoryPanel } from '../SessionStoryPanel';
import { ClaudeRuntimeTasksStrip } from '../ClaudeRuntimeTasksStrip';
import { ClaudeRuntimeSchedulesStrip } from '../ClaudeRuntimeSchedulesStrip';
import { ClaudeRuntimeSignalsStrip } from '../ClaudeRuntimeSignalsStrip';
import { useChatStore } from '../../../store/chatStore';
jest.mock('../useClaudeRuntimeListRefresh', () => ({
  useClaudeRuntimeTasksRefresh: () => ({ loading: false, recoveryNeeded: true, refresh: jest.fn() }),
  useClaudeRuntimeSchedulesRefresh: () => ({ loading: false, recoveryNeeded: true, refresh: jest.fn() }),
}));

test('원고형의 스토리·런타임은 종이 위 패널/선 표면만 바꾸고 default는 유지한다', () => {
  useChatStore.setState({ claudeRuntimeBySession: { pas: { tasks: {}, schedules: {}, notifications: {}, remoteTriggers: {},
    sessionState: {}, transcriptMirror: { status: 'active' } } as any } });
  const t = renderHook(() => useTokens()).result.current;
  const api = { getSessionStory: jest.fn() } as any;
  for (const [Component, id] of [[SessionStoryPanel, 'session-story-panel'], [ClaudeRuntimeTasksStrip, 'runtime-tasks-strip'],
    [ClaudeRuntimeSchedulesStrip, 'runtime-schedules-strip'], [ClaudeRuntimeSignalsStrip, 'runtime-signals-strip']] as const) {
    const normal = render(React.createElement(Component as React.ComponentType<any>, { sessionId: 'pas', api }));
    const before = StyleSheet.flatten(normal.getByTestId(id).props.style);
    normal.rerender(React.createElement(Component as React.ComponentType<any>, { sessionId: 'pas', api, presentation: 'manuscript' }));
    const manuscript = StyleSheet.flatten(normal.getByTestId(id).props.style);
    expect(manuscript.backgroundColor).toBe(t.persistentSession.panel);
    expect(manuscript.borderBottomColor).toBe(t.persistentSession.line);
    normal.rerender(React.createElement(Component as React.ComponentType<any>, { sessionId: 'pas', api }));
    expect(StyleSheet.flatten(normal.getByTestId(id).props.style)).toEqual(before);
    normal.unmount();
  }
});

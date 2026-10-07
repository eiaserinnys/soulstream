import { act, fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { DARK_PERSISTENT_SESSION_COLORS, LIGHT_COLORS } from '../../../theme/colors';
import type { SessionEvent } from '../../../api/types';
import { ReviewManuscriptActivity } from '../../../component-review/ReviewManuscriptActivity';
import { ThinkingEvent } from '../../events/ThinkingEvent';
import { useSettingsStore } from '../../../store/settingsStore';
import type { ManuscriptActivityRenderItem } from '../manuscriptActivityProjection';
import { ManuscriptActivitySegment } from '../ManuscriptActivitySegment';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

function activityItem(): ManuscriptActivityRenderItem {
  const failedStart = ev('1', 'tool_start', {
    tool_use_id: 'tool-1',
    tool_name: 'mcp__soulstream__Read',
    tool_input: 'private preview',
  });
  const failedResult = ev('2', 'tool_result', {
    tool_use_id: 'tool-1',
    result: 'failed output',
    is_error: true,
  });
  const thought = ev('3', 'thinking_delta', { thinking: '실행 사이의 생각 행' });
  const runningStart = ev('4', 'tool_start', {
    tool_use_id: 'tool-2',
    tool_name: 'mcp__node__Bash',
    tool_input: 'running input',
  });

  return {
    kind: 'activity',
    key: 'activity-tool-1',
    items: [
      { kind: 'tool', start: failedStart, result: failedResult, key: 'tool-1' },
      { kind: 'event', event: thought, key: 'evt-3' },
      { kind: 'tool', start: runningStart, key: 'tool-4' },
    ],
  };
}

describe('ManuscriptActivitySegment', () => {
  it('한 줄 접힘 표시에 도구 수와 실행·실패 상태를 보여주고, 펼치면 개별 줄을 유지한다', () => {
    const screen = render(
      <ManuscriptActivitySegment item={activityItem()} sessionId="session-1" api={null} />,
    );
    const toggle = screen.getByTestId('manuscript-activity-toggle');

    expect(screen.getByText('도구 2회')).toBeTruthy();
    expect(screen.getByText('실행 중')).toBeTruthy();
    const failure = screen.getByText('실패 1');
    expect(StyleSheet.flatten(failure.props.style).color).toBe(LIGHT_COLORS.errorText);
    expect(screen.queryByText('Read')).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
    expect(screen.queryByTestId('manuscript-activity-items')).toBeNull();
    expect(toggle.props.accessibilityState.expanded).toBe(false);

    fireEvent.press(toggle);

    expect(screen.getAllByTestId('tool-event-row-slot')).toHaveLength(2);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getAllByTestId('tool-event-state-icon')[0].props.color).toBe(LIGHT_COLORS.errorText);
    expect(StyleSheet.flatten(screen.getByText('Read').props.style).color).toBe(LIGHT_COLORS.errorText);
    const eventMenus = screen.getAllByTestId('event-context-menu-anchor');
    expect(eventMenus).toHaveLength(3);
    expect(within(eventMenus[1]).getByText('실행 사이의 생각 행')).toBeTruthy();
    const thoughtInset = screen.getByTestId('manuscript-activity-thinking-inset');
    const toolHeader = screen.getAllByTestId('tool-event-header-visual')[0];
    expect(StyleSheet.flatten(thoughtInset.props.style).paddingHorizontal)
      .toBe(StyleSheet.flatten(toolHeader.props.style).paddingHorizontal);
    expect(screen.queryByText('mcp__soulstream__Read')).toBeNull();
    expect(screen.queryByText('private preview')).toBeNull();

    const rowToggles = screen.getAllByTestId('tool-event-header-touch');
    fireEvent.press(rowToggles[0]);
    expect(screen.getByText('private preview')).toBeTruthy();
    fireEvent.press(rowToggles[0]);
    expect(screen.queryByText('private preview')).toBeNull();
    expect(screen.getByTestId('manuscript-activity-toggle').props.accessibilityState.expanded).toBe(true);
    fireEvent.press(screen.getByTestId('manuscript-activity-toggle'));
    expect(screen.queryByTestId('manuscript-activity-items')).toBeNull();
  });

  it('표본 원고형 열은 종이 바탕을 쓰고, 단독 생각 문단은 열 시작선을 유지한다', async () => {
    const previousAppearance = useSettingsStore.getState().appearance;
    await act(async () => {
      useSettingsStore.setState({ appearance: 'dark' });
    });
    try {
      const sample = render(<ReviewManuscriptActivity />);
      const manuscriptColumn = sample.getByTestId('review-activity-manuscript-column');
      expect(StyleSheet.flatten(manuscriptColumn.props.style).backgroundColor)
        .toBe(DARK_PERSISTENT_SESSION_COLORS.paper);
    } finally {
      await act(async () => {
        useSettingsStore.setState({ appearance: previousAppearance });
      });
    }

    const standalone = render(<ThinkingEvent event={ev('solo', 'thinking_delta', { thinking: '단독 생각' })}
      presentation="manuscript" />);
    const standaloneText = StyleSheet.flatten(standalone.getByTestId('thinking-event-text').props.style);
    expect(standaloneText.marginLeft).toBeUndefined();
    expect(standaloneText.paddingHorizontal).toBeUndefined();
  });

  it('접힌 줄은 글자·아이콘만 두고 surface와 외곽선을 그리지 않는다', () => {
    const screen = render(
      <ManuscriptActivitySegment item={activityItem()} sessionId="session-1" api={null} />,
    );
    const header = screen.getByTestId('manuscript-activity-toggle');
    const style = StyleSheet.flatten(header.props.style);
    const toolIcon = screen.getByTestId('manuscript-activity-icon');

    expect(style.borderWidth).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
    expect(toolIcon.props.name).toBe('construct-outline');
    expect(toolIcon.props.color).toBe(LIGHT_COLORS.textSecondary);
    expect(screen.getByText('∨', { includeHiddenElements: true })).toBeTruthy();
  });
});

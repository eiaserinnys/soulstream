import { Appearance, StyleSheet, View } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => 'light',
}));

import { ToolEvent } from '../ToolEvent';
import type { SessionEvent } from '../../../api/types';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent => ({
  id,
  type,
  data,
});

beforeAll(() => {
  jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
});

afterAll(() => {
  jest.restoreAllMocks();
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
  });
});

describe('ToolEvent lazy trace detail', () => {
  test('구조화 배열 결과는 text 외 annotations와 비text 블록까지 화면에 보존한다', () => {
    const result = [
      { type: 'text', text: '본문', annotations: { source: 'fixture' }, extra: 7 },
      { type: 'image', source: { media_type: 'image/png', data: 'abc' } },
    ];
    const screen = render(
      <ToolEvent
        start={ev('10', 'tool_start', { tool_name: 'Read', tool_input: 'input' })}
        result={ev('11', 'tool_result', { result, is_error: false })}
      />,
    );

    fireEvent.press(screen.getByTestId('tool-event-header-touch'));
    expect(screen.getByText(JSON.stringify(result, null, 2))).toBeTruthy();
  });

  test.each([
    ['문자열', 'plain result', 'plain result'],
    ['빈 배열', [], '[]'],
    ['객체', { ok: true }, JSON.stringify({ ok: true }, null, 2)],
    ['null', null, '없음'],
  ])('%s 결과의 기존 표시 의미를 유지한다', (_label, result, expected) => {
    const screen = render(
      <ToolEvent
        start={ev('10', 'tool_start', { tool_name: 'Read', tool_input: 'input' })}
        result={ev('11', 'tool_result', { result, is_error: false })}
      />,
    );

    fireEvent.press(screen.getByTestId('tool-event-header-touch'));
    expect(screen.getByText(expected)).toBeTruthy();
  });

  test.each([
    ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
    ['phone large text', { width: 390, height: 844, scale: 3, fontScale: 2 }, 44],
    ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 48],
    ['iPad large text', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
  ] as const)('%s collapsed/expanded 도구 위계는 compact exact와 hit frame을 분리한다', (
    _label,
    dimensions,
    hitTarget,
  ) => {
    mockDimensions = dimensions;
    const screen = render(
      <ToolEvent
        start={ev('10', 'tool_start', {
          tool_name: 'mcp__long_tool_name',
          tool_input: '긴 입력 요약 '.repeat(20),
        })}
        result={ev('11', 'tool_result', {
          result: '출력 본문',
          is_error: false,
        })}
      />,
    );

    const touch = screen.getByTestId('tool-event-header-touch');
    const visual = screen.getByTestId('tool-event-header-visual');
    expect(StyleSheet.flatten(touch.props.style)).toMatchObject({
      minHeight: hitTarget,
      minWidth: hitTarget,
    });
    expect(touch.props.accessibilityRole).toBe('button');
    expect(touch.props.accessibilityState.expanded).toBe(false);
    expect(touch.props.accessibilityLabel).toContain('mcp__long_tool_name');
    expect(StyleSheet.flatten(visual.props.style)).toMatchObject({
      minHeight: 40,
      height: 40,
      paddingHorizontal: 12,
      paddingVertical: 6,
      gap: 6,
    });

    const name = screen.getByText('mcp__long_tool_name');
    const summary = screen.getByText('긴 입력 요약 '.repeat(20).trim());
    expect(StyleSheet.flatten(name.props.style)).toMatchObject({
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '600',
      minWidth: 0,
    });
    expect(StyleSheet.flatten(summary.props.style)).toMatchObject({
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '400',
      minWidth: 0,
    });
    expect(name.props.numberOfLines).toBe(1);
    expect(summary.props.numberOfLines).toBe(1);
    expect(screen.getByTestId('tool-event-state-icon').props.size).toBe(17);
    expect(screen.getByTestId('tool-event-chevron').props.size).toBe(14);

    fireEvent(touch, 'pressIn');
    expect(StyleSheet.flatten(screen.getByTestId('tool-event-wrapper').props.style).opacity).toBe(0.7);
    fireEvent(touch, 'pressOut');
    expect(StyleSheet.flatten(screen.getByTestId('tool-event-wrapper').props.style).opacity).toBeUndefined();

    fireEvent.press(touch);
    expect(screen.getByTestId('tool-event-header-touch').props.accessibilityState.expanded).toBe(true);
    expect(StyleSheet.flatten(screen.getByTestId('tool-event-body').props.style).padding).toBe(12);
    const code = screen.getByText('출력 본문');
    expect(StyleSheet.flatten(code.props.style)).toMatchObject({
      fontFamily: 'Courier',
      fontSize: 13,
      lineHeight: 19,
    });
  });

  test.each([
    ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
    ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 48],
  ] as const)('%s 실제 외곽 surface는 40pt이고 인접 ToolEvent visual gap은 6pt다', (
    _label,
    dimensions,
    hitTarget,
  ) => {
    mockDimensions = dimensions;
    const screen = render(
      <View>
        <ToolEvent
          start={ev('10', 'tool_start', { tool_name: 'Read', tool_input: '첫 번째' })}
        />
        <ToolEvent
          start={ev('11', 'tool_start', { tool_name: 'Bash', tool_input: '두 번째' })}
        />
      </View>,
    );

    const slots = screen.getAllByTestId('tool-event-row-slot');
    const surfaces = screen.getAllByTestId('tool-event-wrapper');
    const firstSlot = StyleSheet.flatten(slots[0].props.style);
    const secondSlot = StyleSheet.flatten(slots[1].props.style);
    const firstSurface = StyleSheet.flatten(surfaces[0].props.style);

    expect(firstSlot.minHeight).toBe(hitTarget);
    expect(firstSurface).toMatchObject({ height: 40, borderWidth: 1 });

    const firstBottomInset = firstSlot.paddingBottom ?? firstSlot.paddingVertical ?? 0;
    const secondTopInset = secondSlot.paddingTop ?? secondSlot.paddingVertical ?? 0;
    const visualGap = firstBottomInset + (firstSlot.marginBottom ?? 0) + secondTopInset;
    expect(visualGap).toBe(6);
  });

  test('pending tool_start renders immediately before tool_result arrives', () => {
    const { getByText, queryByText } = render(
      <ToolEvent
        sessionId="sess-1"
        api={null}
        start={ev('10', 'tool_start', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_pending',
          timeline_id: 'tool:toolu_pending',
          tool_input: 'pnpm test',
        })}
      />,
    );

    expect(getByText('Bash')).toBeTruthy();
    expect(getByText('pnpm test')).toBeTruthy();
    expect(queryByText('short output')).toBeNull();
  });

  test('긴 도구명과 명령은 채팅 본문보다 작은 한 줄 ellipsis로 렌더한다', () => {
    const { getByText } = render(
      <ToolEvent
        start={ev('10', 'tool_start', {
          tool_name: 'mcp__very_long_tool_name_that_must_not_overflow',
          tool_input: '/very/long/path '.repeat(20),
        })}
      />,
    );

    const name = getByText('mcp__very_long_tool_name_that_must_not_overflow');
    const preview = getByText('/very/long/path '.repeat(20).trim());
    expect(name.props.numberOfLines).toBe(1);
    expect(name.props.ellipsizeMode).toBe('tail');
    expect(preview.props.numberOfLines).toBe(1);
    expect(preview.props.ellipsizeMode).toBe('tail');
    expect(StyleSheet.flatten(name.props.style).fontSize).toBeLessThan(17);
    expect(StyleSheet.flatten(preview.props.style).minWidth).toBe(0);
  });

  test('collapsed와 expanded 모두 wrapper 한 장만 border와 radius를 소유한다', () => {
    const screen = render(
      <ToolEvent
        start={ev('10', 'tool_start', {
          tool_name: 'Bash',
          tool_input: 'pnpm test',
        })}
      />,
    );

    const wrapper = screen.getByTestId('tool-event-wrapper');
    const header = screen.getByTestId('tool-event-header-visual');
    const wrapperStyle = StyleSheet.flatten(wrapper.props.style);
    const headerStyle = StyleSheet.flatten(header.props.style);

    expect(wrapperStyle).toMatchObject({
      borderWidth: 1,
      overflow: 'hidden',
    });
    expect(typeof wrapperStyle.borderRadius).toBe('number');
    expect(headerStyle.borderWidth).toBeUndefined();
    expect(headerStyle.borderRadius).toBeUndefined();
    expect(screen.queryByTestId('tool-event-body')).toBeNull();

    fireEvent.press(screen.getByTestId('tool-event-header-touch'));

    const body = screen.getByTestId('tool-event-body');
    const expandedWrapperStyle = StyleSheet.flatten(wrapper.props.style);
    const bodyStyle = StyleSheet.flatten(body.props.style);
    expect(expandedWrapperStyle).toMatchObject({
      borderWidth: 1,
      overflow: 'hidden',
    });
    expect(expandedWrapperStyle.height).toBeUndefined();
    expect(StyleSheet.flatten(header.props.style).height).toBe(40);
    expect(bodyStyle.borderWidth).toBeUndefined();
    expect(bodyStyle.borderRadius).toBeUndefined();
  });

  test('expanded tool loads full trace while header uses compact summary', async () => {
    const api = {
      getTimelineTrace: jest.fn(async () => ({
        type: 'tool_trace' as const,
        timeline_id: 'tool:toolu_1',
        tool_use_id: 'toolu_1',
        input: 'full input body',
        result: [{
          type: 'text',
          text: 'full output body',
          annotations: { source: 'trace' },
          extra: 9,
        }],
        progress: [
          {
            id: 11,
            parent_event_id: null,
            event_type: 'progress',
            payload: { text: 'progress chunk' },
            created_at: '2026-05-23T00:00:00Z',
          },
        ],
      })),
    };

    const { getByText, getByTestId, queryByText } = render(
      <ToolEvent
        sessionId="sess-1"
        api={api}
        start={ev('10', 'tool_start', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          timeline_id: 'tool:toolu_1',
          tool_input: 'short input',
        })}
        result={ev('12', 'tool_result', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_1',
          timeline_id: 'tool:toolu_1',
          result: 'short output',
          is_error: false,
        })}
      />,
    );

    expect(getByText('short input')).toBeTruthy();
    expect(queryByText('full output body')).toBeNull();

    fireEvent.press(getByTestId('tool-event-header-touch'));

    await waitFor(() => {
      expect(api.getTimelineTrace).toHaveBeenCalledWith('sess-1', 'tool:toolu_1');
      expect(getByText(JSON.stringify([{
        type: 'text',
        text: 'full output body',
        annotations: { source: 'trace' },
        extra: 9,
      }], null, 2))).toBeTruthy();
      expect(getByText('progress chunk')).toBeTruthy();
    });
  });

  test('trace 오류는 expanded 접근성 상태와 retry touch 의미를 유지한다', async () => {
    const api = {
      getTimelineTrace: jest.fn().mockRejectedValue(new Error('network')),
    };
    const screen = render(
      <ToolEvent
        sessionId="sess-1"
        api={api}
        start={ev('10', 'tool_start', {
          tool_name: 'Bash',
          tool_use_id: 'toolu_error',
          timeline_id: 'tool:toolu_error',
          tool_input: 'pnpm test',
        })}
        result={ev('11', 'tool_result', {
          tool_use_id: 'toolu_error',
          is_error: true,
          result: 'failed',
        })}
      />,
    );

    fireEvent.press(screen.getByTestId('tool-event-header-touch'));
    await waitFor(() => expect(screen.getByTestId('tool-event-retry-touch')).toBeTruthy());
    expect(screen.getByTestId('tool-event-retry-touch').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('tool-event-retry-touch').props.accessibilityLabel).toBe('도구 상세 다시 불러오기');
    fireEvent.press(screen.getByTestId('tool-event-retry-touch'));
    await waitFor(() => expect(api.getTimelineTrace).toHaveBeenCalledTimes(2));
  });
});

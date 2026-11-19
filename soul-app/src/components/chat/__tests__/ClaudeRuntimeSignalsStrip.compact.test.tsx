import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { ClaudeRuntimeSignalsStrip } from '../ClaudeRuntimeSignalsStrip';
import { RUNTIME_STRIP_DETAILS_MAX_HEIGHT } from '../runtimeStripOverflow';
import { useChatStore } from '../../../store/chatStore';

const SID = 'sess-runtime-signals-compact';

describe('ClaudeRuntimeSignalsStrip compact disclosure', () => {
  beforeEach(() => {
    useChatStore.setState({
      claudeRuntimeBySession: {
        [SID]: {
          updatedAt: 100,
          tasks: {},
          schedules: {},
          notifications: {
            n1: {
              notificationId: 'n1',
              source: 'system',
              message: 'runtime notification',
              updatedAt: 100,
            },
          },
          remoteTriggers: { r: { triggerId: 'r', source: 'message_origin', prompt: '원격 요청', updatedAt: 100 } },
          transcriptMirror: {
            updatedAt: 100,
            errorCount: 3,
            lastError: 'cannot extract elements from a scalar',
          },
        },
      },
    });
  });

  test('접힌 상태에서도 signal count와 error badge를 보이고 상세는 펼침 후 표시한다', () => {
    const { getByTestId, getByText, queryByText } = render(
      <ClaudeRuntimeSignalsStrip sessionId={SID} api={null} />,
    );

    expect(getByText('런타임 신호')).toBeTruthy();
    expect(getByText('5')).toBeTruthy();
    expect(getByText('오류 3')).toBeTruthy();
    expect(queryByText('cannot extract elements from a scalar')).toBeNull();

    fireEvent.press(getByText('런타임 신호'));

    expect(
      StyleSheet.flatten(getByTestId('runtime-signals-details-scroll').props.style).maxHeight,
    ).toBe(RUNTIME_STRIP_DETAILS_MAX_HEIGHT);
    expect(getByText('runtime notification')).toBeTruthy();
    expect(getByText('cannot extract elements from a scalar')).toBeTruthy();
    expect(getByText('runtime notification').props.numberOfLines).toBe(1);
    expect(getByText('cannot extract elements from a scalar').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(getByText('미러').props.style).minHeight).toBeUndefined();
    expect(getByText('원격')).toBeTruthy();
    const headerTouch = StyleSheet.flatten(
      getByTestId('runtime-signals-header-touch').props.style,
    );
    expect(headerTouch.minWidth).toBeGreaterThanOrEqual(44);
    expect(headerTouch.minHeight).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(getByTestId('runtime-signals-refresh-visual').props.style)).toMatchObject({
      width: 28,
      height: 28,
    });
  });
});

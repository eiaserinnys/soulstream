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
          remoteTriggers: {},
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

    expect(getByText('Runtime Signals')).toBeTruthy();
    expect(getByText('4')).toBeTruthy();
    expect(getByText('3 error')).toBeTruthy();
    expect(queryByText('cannot extract elements from a scalar')).toBeNull();

    fireEvent.press(getByText('Runtime Signals'));

    expect(
      StyleSheet.flatten(getByTestId('runtime-signals-details-scroll').props.style).maxHeight,
    ).toBe(RUNTIME_STRIP_DETAILS_MAX_HEIGHT);
    expect(getByText('runtime notification')).toBeTruthy();
    expect(getByText('cannot extract elements from a scalar')).toBeTruthy();
    expect(getByText('runtime notification').props.numberOfLines).toBe(1);
    expect(getByText('cannot extract elements from a scalar').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(getByText('mirror').props.style).minHeight).toBeUndefined();
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

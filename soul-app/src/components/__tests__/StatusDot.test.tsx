import React from 'react';
import { act, render } from '@testing-library/react-native';
import { Animated, AppState } from 'react-native';
import { StatusDot } from '../chat/StatusDot';

jest.mock('../../theme', () => ({
  useTokens: () => ({
    colors: {
      statusRunning: '#00ff00',
      statusCompleted: '#0000ff',
      statusError: '#ff0000',
      statusIdle: '#888888',
    },
  }),
}));

function fireAppState(state: 'active' | 'inactive' | 'background') {
  act(() => {
    (AppState as { currentState: string }).currentState = state;
    for (const listener of (globalThis as any).__appStateListeners ?? []) {
      listener(state);
    }
  });
}

describe('StatusDot', () => {
  beforeEach(() => {
    (AppState as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stops its running pulse when inactive and restarts when active', () => {
    const loops: Array<{ start: jest.Mock; stop: jest.Mock }> = [];
    jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
      loops.push(animation);
      return animation as unknown as ReturnType<typeof Animated.loop>;
    });

    const { unmount } = render(<StatusDot status="running" />);
    expect(loops).toHaveLength(1);
    expect(loops[0].start).toHaveBeenCalledTimes(1);

    fireAppState('inactive');
    expect(loops[0].stop).toHaveBeenCalled();
    expect(loops).toHaveLength(1);

    fireAppState('active');
    expect(loops).toHaveLength(2);
    expect(loops[1].start).toHaveBeenCalledTimes(1);

    unmount();
    expect(loops[1].stop).toHaveBeenCalled();
  });
});

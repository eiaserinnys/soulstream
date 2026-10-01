import React from 'react';
import { Animated, StyleSheet } from 'react-native';
import { render, within } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

jest.spyOn(Animated, 'loop').mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  reset: jest.fn(),
} as never));
jest.mock('../useSessionCardAnimation', () => ({
  useSessionCardAnimation: () => {
    const { Animated: MockAnimated } = require('react-native');
    return {
      pulse: new MockAnimated.Value(0),
      shimmer: new MockAnimated.Value(0),
      reducedMotion: true,
      appActive: true,
      animationEnabled: false,
    };
  },
}));

import { SessionCard } from '../SessionCard';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: 'session-1',
    displayName: '아주 긴 세션 제목이 한 줄에서 잘려야 합니다',
    agentName: '로젤린',
    nodeId: 'eiaserinnys',
    backend: 'codex',
    modelLabel: 'Codex - 5.6 Sol',
    status: 'completed',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:01:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://server.test' });
  useSessionStore.setState({
    catalog: {
      folders: [{ id: 'folder-1', name: '소울스트림 앱' }],
      sessions: {
        'session-1': { folderId: 'folder-1' },
        'session-2': { folderId: 'folder-1' },
      },
    },
  } as never);
});

test.each([
  ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
  ['phone large text', { width: 390, height: 844, scale: 3, fontScale: 2 }, 44],
  ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 48],
  ['iPad large text', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
] as const)('%s ordinary/delegated card는 같은 3행·min112 계약을 쓴다', (
  _label,
  dimensions,
  hitTarget,
) => {
  mockDimensions = dimensions;
  const ordinary = render(
    <SessionCard session={makeSession()} onPress={jest.fn()} />,
  );
  const delegated = render(
    <SessionCard
      session={makeSession({
        agentSessionId: 'session-2',
        callerSessionId: 'caller-session',
        userName: '서소영',
        userPortraitUrl: '/api/nodes/eiaserinnys/agents/seosoyoung/portrait',
      })}
      onPress={jest.fn()}
    />,
  );

  for (const screen of [ordinary, delegated]) {
    const card = screen.getByTestId('session-card-pressable');
    const cardStyle = StyleSheet.flatten(card.props.style);
    expect(cardStyle.minHeight).toBe(112);
    expect(cardStyle.height).toBeUndefined();
    expect(screen.getByTestId('session-card-title-row')).toBeTruthy();
    expect(screen.getByTestId('session-card-identity-row')).toBeTruthy();
    expect(screen.getByTestId('session-card-context-row')).toBeTruthy();
    expect(screen.queryByTestId('session-card-caller-row')).toBeNull();
    expect(screen.queryByTestId('session-card-caller-portrait')).toBeNull();

    const avatar = StyleSheet.flatten(screen.getByTestId('session-card-agent-avatar').props.style);
    expect(avatar).toMatchObject({ width: 44, height: 44 });
    for (const id of ['session-card-title', 'session-card-identity', 'session-card-context']) {
      const text = screen.getByTestId(id);
      expect(text.props.numberOfLines).toBe(1);
      expect(text.props.ellipsizeMode).toBe('tail');
    }
  }

  expect(delegated.getByText('로젤린 · Codex - 5.6 Sol · 요청 서소영')).toBeTruthy();
  expect(delegated.getByTestId('session-card-pressable').props.accessibilityLabel)
    .toContain('요청 서소영');

  ordinary.unmount();
  delegated.unmount();

  const review = render(
    <SessionCard
      session={makeSession({
        reviewRequired: true,
        reviewState: 'needs_review',
      })}
      onPress={jest.fn()}
    />,
  );
  expect(review.getByText('검수 필요')).toBeTruthy();
  expect(review.queryByText('완료')).toBeNull();
  expect(StyleSheet.flatten(review.getByTestId('session-card-review-ack').props.style))
    .toMatchObject({ minWidth: hitTarget, minHeight: hitTarget });
  expect(StyleSheet.flatten(review.getByTestId('session-card-status-chip').props.style))
    .toMatchObject({
      minHeight: 24,
      paddingHorizontal: 8,
      paddingVertical: 0,
      borderRadius: 8,
    });
});

test.each([
  ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }],
  ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 1 }],
] as const)('%s 상태와 시간은 같은 우측 레일, 모델 라벨은 identity 행을 쓴다', (
  _label,
  dimensions,
) => {
  mockDimensions = dimensions;
  const running = render(
    <SessionCard
      session={makeSession({ status: 'running' })}
      onPress={jest.fn()}
    />,
  );
  const review = render(
    <SessionCard
      session={makeSession({
        reviewRequired: true,
        reviewState: 'needs_review',
      })}
      onPress={jest.fn()}
    />,
  );

  for (const screen of [running, review]) {
    const rail = screen.getByTestId('session-card-right-rail');
    expect(StyleSheet.flatten(rail.props.style)).toMatchObject({
      width: 76,
      alignItems: 'flex-end',
      justifyContent: 'space-between',
    });
    expect(within(rail).getByTestId('session-card-status-chip')).toBeTruthy();
    expect(within(rail).getByTestId('session-card-time')).toBeTruthy();

    const identity = screen.getByTestId('session-card-identity-row');
    expect(within(identity).getByText('로젤린 · Codex - 5.6 Sol')).toBeTruthy();
    expect(screen.queryByTestId('session-card-backend-badge')).toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('session-card-identity').props.style),
    ).toMatchObject({ flexShrink: 1 });
    expect(
      StyleSheet.flatten(screen.getByTestId('session-card-identity').props.style).flex,
    ).toBeUndefined();
    expect(StyleSheet.flatten(
      screen.getByTestId('session-card-status-chip').props.style,
    )).toMatchObject({
      minHeight: 24,
      paddingHorizontal: 8,
      paddingVertical: 0,
      borderRadius: 8,
    });
  }

  expect(
    StyleSheet.flatten(
      running.getByTestId('session-card-pressable').props.style,
    ).minHeight,
  ).toBe(
    StyleSheet.flatten(
      review.getByTestId('session-card-pressable').props.style,
    ).minHeight,
  );
});

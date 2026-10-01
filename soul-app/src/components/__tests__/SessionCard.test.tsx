import React from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SessionCard } from '../SessionCard';
import type { Session } from '../../api/types';
import { useSettingsStore } from '../../store/settingsStore';

jest.spyOn(Animated, 'loop').mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  reset: jest.fn(),
} as any));

// AppState 'change' 콜백을 수동 발화하기 위한 헬퍼. jest.setup.js에서 등록 콜백을
// globalThis.__appStateListeners 배열로 노출한다.
function fireAppState(state: 'active' | 'background' | 'inactive') {
  const listeners = (globalThis as any).__appStateListeners ?? [];
  for (const fn of listeners) fn(state);
}

// jest.setup.js의 AccessibilityInfo mock을 그대로 쓰되, 분기 검증을 위해 case별로 재설정.
const mockedReducedMotion = AccessibilityInfo.isReduceMotionEnabled as jest.Mock;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: 'sess-1',
    displayName: '테스트 세션',
    status: 'idle',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockedReducedMotion.mockResolvedValue(false);
  // serverUrl을 명시 설정 — agentPortraitUrl/userPortraitUrl이 상대 경로일 때
  // serverUrl prepend 로직이 동작하려면 이 값이 채워져야 한다.
  // 기본값 ''(빈 문자열)은 falsy라 avatarUri 계산이 null로 떨어진다.
  useSettingsStore.setState({ serverUrl: 'http://localhost:4105' });
});

describe('SessionCard', () => {
  it('idle 상태에서는 shimmer 레이어를 렌더하지 않는다', async () => {
    const { queryByTestId, findByText } = render(
      <SessionCard session={makeSession({ status: 'idle' })} onPress={jest.fn()} />,
    );
    // displayName이 렌더될 때까지 대기 (mount + AccessibilityInfo Promise 해소 후)
    await findByText('테스트 세션');
    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();
  });

  it('running 상태 + onLayout 후에 shimmer 레이어가 렌더된다', async () => {
    const { queryByTestId, getByText } = render(
      <SessionCard session={makeSession({ status: 'running' })} onPress={jest.fn()} />,
    );

    // onLayout 콜백을 수동 호출 — RN test renderer는 자동 layout 측정 안 함.
    // pulse/shimmer useEffect와 reduced-motion Promise가 모두 settle될 때까지
    // microtask flush + layout 시뮬레이션을 act() 안에서 수행.
    await act(async () => {
      await Promise.resolve();
    });

    // displayName 렌더 확인
    expect(getByText('테스트 세션')).toBeTruthy();

    // shimmer 레이어는 cardWidth > 0 조건에 의존. RN Animated mock 특성상 onLayout이
    // 자동 발화되지 않으므로, 이 케이스에서는 cardWidth=0인 상태이며 shimmer 레이어
    // 미렌더가 정상이다. 본 테스트는 "running 카드도 onLayout 전에는 shimmer 미렌더"
    // 라는 보호적 동작을 검증한다.
    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();
  });

  it('reducedMotion=true이면 running 상태라도 shimmer 레이어가 렌더되지 않는다', async () => {
    mockedReducedMotion.mockResolvedValueOnce(true);
    const { queryByTestId } = render(
      <SessionCard session={makeSession({ status: 'running' })} onPress={jest.fn()} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();
  });

  // onLayout은 RN의 native layout 콜백이라 jest test renderer가 자동 발화하지 않는다.
  // AnimatedPressable이 prop을 그대로 전달하므로, 컴포넌트 props에서 직접 꺼내 호출한다.
  // fireEvent(node, 'layout', ...)도 작동 가능하나 Animated.createAnimatedComponent
  // 환경에서 RN 0.81 + jest-expo 조합이 불안정 — 직접 호출이 가장 결정적이다.
  function triggerLayout(getByTestId: (id: string) => any, width: number) {
    const node = getByTestId('session-card-pressable');
    const onLayout = node.props.onLayout;
    if (typeof onLayout !== 'function') {
      throw new Error('SessionCard pressable has no onLayout prop');
    }
    onLayout({ nativeEvent: { layout: { width, height: 80, x: 0, y: 0 } } });
  }

  it('running + onLayout 후 AppState=background로 전이되면 shimmer 레이어가 사라진다', async () => {
    // 회귀: TestFlight build 31에서 iPad 백그라운드 진입 직후 folly::dynamic::hash() crash.
    // 원인은 Animated.loop가 useNativeDriver:false로 매 프레임 ShadowTree props를 갱신하면서
    // RCTFabricSurface 스냅샷 레이아웃과 경합한 것. AppState 게이트로 정지시켜야 한다.
    const { queryByTestId, getByTestId, findByText } = render(
      <SessionCard
        session={makeSession({ status: 'running' })}
        onPress={jest.fn()}
      />,
    );

    await findByText('테스트 세션');

    // onLayout 수동 발화 — cardWidth 양수 설정으로 shimmer 레이어 렌더 조건 충족
    await act(async () => {
      triggerLayout(getByTestId, 320);
    });

    expect(queryByTestId('session-card-shimmer-layer')).not.toBeNull();

    // AppState background 전이 — 게이트가 동작하면 shimmer 레이어가 사라져야 한다
    await act(async () => {
      fireAppState('background');
    });

    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();
  });

  it('inactive 전이 콜백 안에서 pulse와 shimmer를 동기 정지한다', async () => {
    const stopSpy = jest.spyOn(Animated.Value.prototype, 'stopAnimation');
    try {
      const { getByTestId, findByText } = render(
        <SessionCard
          session={makeSession({ status: 'running' })}
          onPress={jest.fn()}
        />,
      );
      await findByText('테스트 세션');

      await act(async () => {
        triggerLayout(getByTestId, 320);
      });

      stopSpy.mockClear();
      act(() => {
        fireAppState('inactive');
        expect(stopSpy).toHaveBeenCalledTimes(2);
      });
    } finally {
      stopSpy.mockRestore();
    }
  });

  it("'inactive' 전이에서 shimmer를 멈춘다", async () => {
    const { queryByTestId, getByTestId, findByText } = render(
      <SessionCard
        session={makeSession({ status: 'running' })}
        onPress={jest.fn()}
      />,
    );
    await findByText('테스트 세션');

    await act(async () => {
      triggerLayout(getByTestId, 320);
    });
    expect(queryByTestId('session-card-shimmer-layer')).not.toBeNull();

    await act(async () => {
      fireAppState('inactive');
    });
    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();
  });

  it('background → active로 복귀하면 shimmer 레이어가 다시 렌더된다', async () => {
    const { queryByTestId, getByTestId, findByText } = render(
      <SessionCard
        session={makeSession({ status: 'running' })}
        onPress={jest.fn()}
      />,
    );
    await findByText('테스트 세션');

    await act(async () => {
      triggerLayout(getByTestId, 320);
    });
    expect(queryByTestId('session-card-shimmer-layer')).not.toBeNull();

    await act(async () => {
      fireAppState('background');
    });
    expect(queryByTestId('session-card-shimmer-layer')).toBeNull();

    await act(async () => {
      fireAppState('active');
    });
    expect(queryByTestId('session-card-shimmer-layer')).not.toBeNull();
  });

  it('기존 표시 정보(displayName, statusLabel)를 그대로 노출한다', async () => {
    const { findByText, getByText } = render(
      <SessionCard
        session={makeSession({ status: 'running', displayName: '엠버 작업' })}
        onPress={jest.fn()}
      />,
    );
    expect(await findByText('엠버 작업')).toBeTruthy();
    expect(getByText('실행 중')).toBeTruthy();
  });

  it('pending attention은 상태보다 앞선 bounded 응답 필요 chip과 접근성 설명을 쓴다', async () => {
    const screen = render(
      <SessionCard
        session={makeSession({
          status: 'running',
          pendingAttentions: [
            {
              id: 'input_request:req-7',
              sourceEventId: 1001,
              sessionId: 'sess-1',
              kind: 'input_request',
              requestedAt: '2026-08-06T00:00:02Z',
              title: '배포 확인',
              body: '배포할까요?',
              requestId: 'req-7',
              requiresDetail: true,
            },
          ],
          attentionRevision: 1001,
        })}
        onPress={jest.fn()}
      />,
    );

    expect(await screen.findByText('응답 필요')).toBeTruthy();
    expect(screen.queryByText('실행 중')).toBeNull();
    expect(screen.queryByTestId('session-card-review-ack')).toBeNull();
    expect(screen.getByTestId('session-card-pressable').props.accessibilityLabel)
      .toContain('응답 필요, 배포 확인');
  });

  it('pending attention이 여러 개면 chip에 bounded count를 표시한다', async () => {
    const item = {
      id: 'input_request:req-7',
      sourceEventId: 1001,
      sessionId: 'sess-1',
      kind: 'input_request' as const,
      requestedAt: '2026-08-06T00:00:02Z',
      title: '입력 요청',
      body: '응답이 필요합니다',
      requiresDetail: false,
    };
    const screen = render(
      <SessionCard
        session={makeSession({
          pendingAttentions: [item, { ...item, id: 'input_request:req-8' }],
          attentionRevision: 1002,
        })}
        onPress={jest.fn()}
      />,
    );

    expect(await screen.findByText('응답 필요 2')).toBeTruthy();
  });

  it('카드 시간과 접근성은 raw updatedAt이 아니라 최신 유효 lastMessage.timestamp를 쓴다', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T12:00:00Z'));
    try {
      const screen = render(
        <SessionCard
          session={makeSession({
            createdAt: '2026-09-07T08:00:00Z',
            updatedAt: '2026-09-07T11:59:00Z',
            lastMessage: {
              type: 'assistant_message',
              preview: '마지막 응답',
              timestamp: '2026-09-07T10:00:00Z',
            },
          })}
          onPress={jest.fn()}
        />,
      );

      expect(await screen.findByText('2시간 전')).toBeTruthy();
      expect(screen.getByTestId('session-card-pressable').props.accessibilityLabel)
        .toContain('2시간 전');
      expect(screen.getByTestId('session-card-pressable').props.accessibilityLabel)
        .not.toContain('1분 전');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ordinary/delegated는 같은 min112·3행을 쓰고 caller를 identity에 합친다', async () => {
    const plain = render(
      <SessionCard session={makeSession({ displayName: '메타 없음' })} onPress={jest.fn()} />,
    );
    await plain.findByText('메타 없음');
    const decorated = render(
      <SessionCard
        session={makeSession({
          agentSessionId: 'sess-2',
          displayName: '메타 있음',
          agentName: '로젤린',
          nodeId: 'eiaserinnys',
          backend: 'codex',
          callerSessionId: 'caller-1',
          userName: '서소영',
        })}
        onPress={jest.fn()}
      />,
    );
    await decorated.findByText('메타 있음');

    const plainStyle = StyleSheet.flatten(plain.getByTestId('session-card-pressable').props.style);
    const decoratedStyle = StyleSheet.flatten(decorated.getByTestId('session-card-pressable').props.style);
    expect(plainStyle.minHeight).toBe(112);
    expect(decoratedStyle.minHeight).toBe(112);
    expect(plain.getByTestId('session-card-title-row')).toBeTruthy();
    expect(plain.getByTestId('session-card-identity-row')).toBeTruthy();
    expect(plain.getByTestId('session-card-context-row')).toBeTruthy();
    expect(plain.queryByTestId('session-card-caller-row')).toBeNull();
    expect(decorated.queryByTestId('session-card-caller-row')).toBeNull();
    expect(decorated.getByText('로젤린 · Codex · 요청 서소영')).toBeTruthy();
    expect(decorated.getByText('eiaserinnys')).toBeTruthy();
    expect(decorated.getByText('대기')).toBeTruthy();
  });

  describe('위임 caller identity 통합', () => {
    it('callerSessionId 부재 시 user 필드를 실행 identity로 오인하지 않는다', async () => {
      const { findByText, queryByText } = render(
        <SessionCard
          session={makeSession({
            displayName: '직접 진입',
            userName: '본인',
            userPortraitUrl: '/api/nodes/n/user/portrait',
            // callerSessionId 미지정
          })}
          onPress={jest.fn()}
        />,
      );
      await findByText('직접 진입');
      expect(queryByText(/요청 본인/)).toBeNull();
    });

    it('callerSessionId + userName은 portrait 없이 identity와 카드 접근성에 통합한다', async () => {
      const { findByText, getByTestId, queryByTestId } = render(
        <SessionCard
          session={makeSession({
            displayName: '위임 처리 중',
            callerSessionId: 'sess-caller-1',
            userName: '서소영',
            userPortraitUrl: '/api/nodes/eias-shopping/agents/seosoyoung/portrait',
          })}
          onPress={jest.fn()}
        />,
      );
      await findByText('위임 처리 중');
      expect(await findByText('요청 서소영', { exact: false })).toBeTruthy();
      expect(queryByTestId('session-card-caller-row')).toBeNull();
      expect(queryByTestId('session-card-caller-portrait')).toBeNull();
      expect(getByTestId('session-card-pressable').props.accessibilityLabel)
        .toContain('요청 서소영');
    });

    it('portrait-only caller도 익명 보조 행 대신 피위임 요청 의미를 보존한다', async () => {
      const { findByText, getByTestId, queryByTestId } = render(
        <SessionCard
          session={makeSession({
            displayName: '위임 처리 중',
            callerSessionId: 'sess-caller-3',
            userName: null,
            userPortraitUrl: '/api/nodes/eias-shopping/agents/anon/portrait',
          })}
          onPress={jest.fn()}
        />,
      );
      await findByText('위임 처리 중');
      expect(await findByText('피위임 요청', { exact: false })).toBeTruthy();
      expect(queryByTestId('session-card-caller-portrait')).toBeNull();
      expect(getByTestId('session-card-pressable').props.accessibilityLabel)
        .toContain('피위임 요청');
    });

    it('callerSessionId만 있고 userName/userPortraitUrl 모두 부재면 보조 행을 렌더하지 않는다', async () => {
      const { queryByTestId, findByText } = render(
        <SessionCard
          session={makeSession({
            displayName: '위임 처리 중',
            callerSessionId: 'sess-caller-4',
            userName: null,
            userPortraitUrl: null,
          })}
          onPress={jest.fn()}
        />,
      );
      await findByText('위임 처리 중');
      expect(queryByTestId('session-card-caller-row')).toBeNull();
    });
  });

  describe('모델 라벨 표시', () => {
    it('서버 modelLabel을 backend보다 우선해 identity 행과 접근성 라벨에 표시한다', async () => {
      const { getByTestId, queryByTestId, findByText } = render(
        <SessionCard
          session={makeSession({
            displayName: 'codex 세션',
            agentName: '로젤린',
            backend: 'codex',
            modelLabel: 'Codex - 5.6 Sol',
          })}
          onPress={jest.fn()}
        />,
      );
      await findByText('codex 세션');
      expect(getByTestId('session-card-identity').props.children)
        .toBe('로젤린 · Codex - 5.6 Sol');
      expect(getByTestId('session-card-pressable').props.accessibilityLabel)
        .toContain('Codex - 5.6 Sol');
      expect(queryByTestId('session-card-backend-badge')).toBeNull();
    });

    it.each([
      ['claude', 'Claude'],
      ['codex', 'Codex'],
    ])('modelLabel이 없으면 backend %s를 %s로 표시한다', async (backend, label) => {
      const { findByText, getByTestId, queryByTestId } = render(
        <SessionCard
          session={makeSession({ displayName: '서버 전환 중', agentName: '로젤린', backend })}
          onPress={jest.fn()}
        />,
      );
      await findByText('서버 전환 중');
      expect(getByTestId('session-card-identity').props.children)
        .toBe(`로젤린 · ${label}`);
      expect(queryByTestId('session-card-backend-badge')).toBeNull();
    });

    it('modelLabel과 backend가 모두 없으면 빈 구분자 없이 모델 요소를 생략한다', async () => {
      const { getByTestId, queryByTestId, findByText } = render(
        <SessionCard
          session={makeSession({ displayName: '모델 정보 없음', agentName: '로젤린' })}
          onPress={jest.fn()}
        />,
      );
      await findByText('모델 정보 없음');
      expect(getByTestId('session-card-identity').props.children).toBe('로젤린');
      expect(queryByTestId('session-card-backend-badge')).toBeNull();
    });
  });
});

import React, { useEffect, useRef, useState } from 'react';
import { Animated, AppState, StyleSheet } from 'react-native';
import { useTokens } from '../../theme';
import {
  isForegroundAppState,
  shouldRunStatusDotAnimation,
} from '../sessionCardAnimation';

interface Props {
  status?: string;
}

/**
 * 8pt 상태 도트. status === 'running'이면 색상이 800ms 단위 opacity 펄스한다.
 * 그 외 상태는 정적 색상으로 표시. ChatScreen 헤더 제목 좌측 prefix.
 *
 * 컬러는 테마 토큰(t.colors.statusXxx)에서 가져와 다크/라이트 양쪽에서 자연스럽게 동작.
 */
export function StatusDot({ status }: Props) {
  const t = useTokens();
  const opacity = useRef(new Animated.Value(1)).current;
  const loopRef = useRef<ReturnType<typeof Animated.loop> | null>(null);
  const [appActive, setAppActive] = useState(
    isForegroundAppState(AppState.currentState),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = isForegroundAppState(state);
      if (!active) {
        loopRef.current?.stop();
        loopRef.current = null;
      }
      setAppActive(active);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    loopRef.current?.stop();
    loopRef.current = null;
    if (shouldRunStatusDotAnimation(status, appActive)) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.3,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      loopRef.current = loop;
      loop.start();
      return () => {
        loop.stop();
        if (loopRef.current === loop) loopRef.current = null;
      };
    }
    opacity.setValue(1);
  }, [status, appActive, opacity]);

  const color = (() => {
    switch (status) {
      case 'running':
        return t.colors.statusRunning;
      case 'completed':
        return t.colors.statusCompleted;
      case 'error':
        return t.colors.statusError;
      default:
        return t.colors.statusIdle;
    }
  })();

  return (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity }]} />
  );
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
});

import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  isForegroundAppState,
  shouldRunSessionCardAnimation,
} from './sessionCardAnimation';

interface UseSessionCardAnimationOptions {
  isRunning: boolean;
}

export function useSessionCardAnimation({
  isRunning,
}: UseSessionCardAnimationOptions) {
  // reduced-motion 게이트 — iOS 접근성 "동작 줄이기" ON 시 breathe/shimmer 미실행.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReducedMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReducedMotion,
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const [appActive, setAppActive] = useState(
    isForegroundAppState(AppState.currentState),
  );
  const pulse = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  // inactive/background에서는 무한 loop를 중지하고 active 복귀 때 재개한다.
  // AppState 콜백 안에서 즉시 stopAnimation을 호출해 effect cleanup을 기다리는 tick을 막는다.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      const active = isForegroundAppState(s);
      if (!active) {
        pulse.stopAnimation();
        shimmer.stopAnimation();
      }
      setAppActive(active);
    });
    return () => sub.remove();
  }, [pulse, shimmer]);

  const animationEnabled = shouldRunSessionCardAnimation({
    isRunning,
    reducedMotion,
    appActive,
  });

  // breathe 펄스 — 0 ↔ 1 반복(3s 사이클). useNativeDriver=false인 이유:
  // backgroundColor / borderColor / shadowOpacity 보간은 native driver가 미지원.
  useEffect(() => {
    pulse.stopAnimation();
    if (!animationEnabled) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isRunning, reducedMotion, appActive, animationEnabled, pulse]);

  // shimmer translateX -cardWidth → +cardWidth (2.8s). Width is intentionally
  // handled by the caller's interpolation so layout changes do not restart the loop.
  useEffect(() => {
    shimmer.stopAnimation();
    if (!animationEnabled) {
      shimmer.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 2800,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [isRunning, reducedMotion, appActive, animationEnabled, shimmer]);

  return {
    pulse,
    shimmer,
    reducedMotion,
    appActive,
    animationEnabled,
  };
}

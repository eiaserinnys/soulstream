import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { cancelAnimation, Easing, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import {
  isForegroundAppState,
  shouldRunSessionCardAnimation,
} from './sessionCardAnimation';

interface UseSessionCardAnimationOptions {
  isRunning: boolean;
  animationActive?: boolean;
}

export function useSessionCardAnimation({
  isRunning,
  animationActive = true,
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
  const pulse = useSharedValue(0);
  const shimmer = useSharedValue(0);

  // inactive/background에서는 무한 loop를 중지하고 active 복귀 때 재개한다.
  // AppState 콜백 안에서 즉시 cancelAnimation을 호출해 effect cleanup을 기다리는 tick을 막는다.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      const active = isForegroundAppState(s);
      if (!active) {
        cancelAnimation(pulse);
        cancelAnimation(shimmer);
        pulse.value = 0;
        shimmer.value = 0;
      }
      setAppActive(active);
    });
    return () => sub.remove();
  }, [pulse, shimmer]);

  const animationEnabled = shouldRunSessionCardAnimation({
    isRunning,
    reducedMotion,
    appActive,
    animationActive,
  });

  // RN Animated.timing's default is inOut(ease), not Reanimated's inOut(quad).
  // Both loops run in the UI runtime without per-frame JS callbacks.
  useEffect(() => {
    const stop = () => {
      cancelAnimation(pulse);
      cancelAnimation(shimmer);
      pulse.value = 0;
      shimmer.value = 0;
    };
    stop();
    if (animationEnabled) {
      const easing = Easing.inOut(Easing.ease);
      pulse.value = withRepeat(withTiming(1, { duration: 1500, easing }), -1, true);
      shimmer.value = withRepeat(withTiming(1, { duration: 2800, easing }), -1, false);
    }
    return stop;
  }, [animationEnabled, pulse, shimmer]);

  return {
    pulse,
    shimmer,
    reducedMotion,
    appActive,
    animationEnabled,
  };
}

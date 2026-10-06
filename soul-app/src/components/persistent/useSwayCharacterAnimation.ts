import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { isForegroundAppState } from '../sessionCardAnimation';

const SWAY_PERIOD_MS = 5800;

interface UseSwayCharacterAnimationOptions {
  motionEnabled: boolean;
  active: boolean;
  shown: boolean;
}

export function useSwayCharacterAnimation({
  motionEnabled,
  active,
  shown,
}: UseSwayCharacterAnimationOptions) {
  const [reducedMotion, setReducedMotion] = useState(true);
  const [motionPreferenceKnown, setMotionPreferenceKnown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) {
        setReducedMotion(value);
        setMotionPreferenceKnown(true);
      }
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReducedMotion(value);
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const phase = useSharedValue(0);
  const [appActive, setAppActive] = useState(isForegroundAppState(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      const isActive = isForegroundAppState(state);
      if (!isActive) {
        cancelAnimation(phase);
        phase.value = 0;
      }
      setAppActive(isActive);
    });
    return () => subscription.remove();
  }, [phase]);

  const animationEnabled = motionPreferenceKnown
    && !reducedMotion
    && motionEnabled
    && active
    && shown
    && appActive;

  useEffect(() => {
    const stop = () => {
      cancelAnimation(phase);
      phase.value = 0;
    };
    stop();
    if (animationEnabled) {
      phase.value = withRepeat(
        withTiming(Math.PI * 2, { duration: SWAY_PERIOD_MS, easing: Easing.linear }),
        -1,
        false,
      );
    }
    return stop;
  }, [animationEnabled, phase]);

  return { phase, animationEnabled };
}

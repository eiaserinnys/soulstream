import React from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useTokens } from '../../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function elapsedProgress(expiresAt: number, durationMs: number, now: number) {
  return Math.max(0, Math.min(1, (now - (expiresAt - durationMs)) / durationMs));
}

function filledSegmentCount(expiresAt: number, durationMs: number, now: number) {
  const elapsed = Math.max(0, now - (expiresAt - durationMs));
  return Math.min(5, Math.floor(elapsed / 1000) + 1);
}

export function UndoCountdownRing({ expiresAt, durationMs }: { expiresAt: number; durationMs: number }) {
  const t = useTokens();
  const size = t.foundation.typography.meta.lineHeight;
  const strokeWidth = size * 2 / 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const [reducedMotion, setReducedMotion] = React.useState(true);
  const [motionPreferenceKnown, setMotionPreferenceKnown] = React.useState(false);
  const [filledSegments, setFilledSegments] = React.useState(() => filledSegmentCount(expiresAt, durationMs, Date.now()));
  const startAt = expiresAt - durationMs;
  const progress = useSharedValue(elapsedProgress(expiresAt, durationMs, Date.now()));

  React.useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (!cancelled) {
        setReducedMotion(value);
        setMotionPreferenceKnown(true);
      }
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  React.useEffect(() => {
    if (!motionPreferenceKnown) return;
    if (reducedMotion) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const step = () => {
        const now = Date.now();
        const elapsed = Math.max(0, now - startAt);
        setFilledSegments(filledSegmentCount(expiresAt, durationMs, now));
        if (elapsed < durationMs) {
          const nextBoundary = startAt + (Math.floor(elapsed / 1000) + 1) * 1000;
          timer = setTimeout(step, Math.max(1, Math.min(nextBoundary - now, expiresAt - now)));
        }
      };
      step();
      return () => { if (timer) clearTimeout(timer); };
    }

    progress.value = elapsedProgress(expiresAt, durationMs, Date.now());
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) progress.value = 1;
    else progress.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    return () => cancelAnimation(progress);
  }, [durationMs, expiresAt, motionPreferenceKnown, progress, reducedMotion]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));
  const center = size / 2;
  const segmentLength = circumference / 5 - strokeWidth;
  const trackDashArray = reducedMotion
    ? Array.from({ length: 5 }, () => [segmentLength, strokeWidth]).flat()
    : circumference;
  const progressDashArray = reducedMotion
    ? [...Array.from({ length: filledSegments }, () => [segmentLength, strokeWidth]).flat(), 0, circumference]
    : circumference;
  const rotation = { rotation: -90 as const, originX: center, originY: center };

  return <View testID="undo-countdown-ring" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    aria-hidden style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Svg testID="undo-countdown-ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={StyleSheet.absoluteFill}>
      <Circle testID="undo-countdown-ring-track" cx={center} cy={center} r={radius} fill="none"
        stroke={t.persistentSession.line} strokeWidth={strokeWidth} strokeDasharray={trackDashArray}
        strokeLinecap={reducedMotion ? 'butt' : 'round'} {...rotation} />
      {reducedMotion
        ? <Circle testID="undo-countdown-ring-progress" cx={center} cy={center} r={radius} fill="none"
          stroke={t.colors.accent} strokeWidth={strokeWidth} strokeLinecap="butt" strokeDasharray={progressDashArray}
          strokeDashoffset={0} {...rotation} />
        : <AnimatedCircle testID="undo-countdown-ring-progress" cx={center} cy={center} r={radius} fill="none"
          stroke={t.colors.accent} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={progressDashArray}
          animatedProps={animatedProps} {...rotation} />}
    </Svg>
    <Ionicons name="time-outline" size={t.foundation.typography.label.fontSize} color={t.colors.textSecondary} />
  </View>;
}

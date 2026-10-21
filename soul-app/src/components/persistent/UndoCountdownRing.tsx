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

export function UndoCountdownRing({ expiresAt, durationMs }: { expiresAt: number; durationMs: number }) {
  const t = useTokens();
  const size = t.foundation.typography.meta.lineHeight;
  const strokeWidth = size * 2 / 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const [reducedMotion, setReducedMotion] = React.useState(true);
  const [motionPreferenceKnown, setMotionPreferenceKnown] = React.useState(false);
  const startAt = expiresAt - durationMs;
  const elapsedAtMount = Math.max(0, Date.now() - startAt);
  const initialProgress = Math.min(5, Math.floor(elapsedAtMount / 1000)) / 5;
  const progress = useSharedValue(initialProgress);

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
    const currentProgress = elapsedProgress(expiresAt, durationMs, Date.now());
    progress.value = currentProgress;
    if (reducedMotion) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const step = () => {
        const elapsed = Math.max(0, Date.now() - startAt);
        progress.value = Math.min(5, Math.floor(elapsed / 1000)) / 5;
        if (elapsed < durationMs) {
          const toNextStep = 1000 - (elapsed % 1000);
          timer = setTimeout(step, Math.min(toNextStep, durationMs - elapsed));
        }
      };
      step();
      return () => { if (timer) clearTimeout(timer); };
    }

    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining === 0) progress.value = 1;
    else progress.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    return () => cancelAnimation(progress);
  }, [durationMs, expiresAt, motionPreferenceKnown, progress, reducedMotion]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));
  const center = size / 2;

  return <View testID="undo-countdown-ring" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    aria-hidden style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Svg testID="undo-countdown-ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={StyleSheet.absoluteFill} rotation={-90} originX={center} originY={center}>
      <Circle testID="undo-countdown-ring-track" cx={center} cy={center} r={radius} fill="none"
        stroke={t.persistentSession.line} strokeWidth={strokeWidth} />
      <AnimatedCircle testID="undo-countdown-ring-progress" cx={center} cy={center} r={radius} fill="none"
        stroke={t.colors.accent} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={circumference}
        animatedProps={animatedProps} />
    </Svg>
    <Ionicons name="time-outline" size={t.foundation.typography.label.fontSize} color={t.colors.textSecondary} />
  </View>;
}

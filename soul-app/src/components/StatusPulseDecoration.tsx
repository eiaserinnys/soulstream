import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSessionCardAnimation } from './useSessionCardAnimation';
import { shouldRenderSessionCardShimmer } from './sessionCardAnimation';

export function withAlphaColor(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `${hex}${a}`;
}

export function useStatusPulseDecoration({
  isRunning,
  animationActive = true,
  cardWidth,
  successColor,
  staticBackground,
  staticBorder,
  staticShadowOpacity,
  staticElevation,
}: {
  isRunning: boolean;
  animationActive?: boolean;
  cardWidth: number;
  successColor: string;
  staticBackground: ViewStyle['backgroundColor'];
  staticBorder: ViewStyle['borderColor'];
  staticShadowOpacity: number | undefined;
  staticElevation: number | undefined;
}) {
  const { pulse, shimmer, reducedMotion, appActive, animationEnabled } = useSessionCardAnimation({
    isRunning,
    animationActive,
  });
  const backgroundRange = [withAlphaColor(successColor, 0), withAlphaColor(successColor, 0.07)];
  const borderRange = [withAlphaColor(successColor, 0.12), withAlphaColor(successColor, 0.5)];
  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: animationEnabled
      ? interpolateColor(pulse.value, [0, 1], backgroundRange, 'RGB', { gamma: 1 })
      : staticBackground,
    borderColor: animationEnabled
      ? interpolateColor(pulse.value, [0, 1], borderRange, 'RGB', { gamma: 1 })
      : staticBorder,
    shadowColor: successColor,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 14,
    shadowOpacity: animationEnabled ? interpolate(pulse.value, [0, 1], [0, 0.14]) : staticShadowOpacity,
    elevation: animationEnabled ? 4 : staticElevation,
  }));
  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(shimmer.value, [0, 1], [-cardWidth, cardWidth]) }],
  }));
  const showShimmer = shouldRenderSessionCardShimmer({
    isRunning,
    reducedMotion,
    appActive,
    cardWidth,
    animationActive,
  });
  return { animatedStyle, shimmerStyle, showShimmer, shimmerColor: withAlphaColor(successColor, 0.1) };
}

export function StatusPulseShimmer({
  style,
  borderRadius,
  color,
  testID = 'status-pulse-shimmer-layer',
}: {
  style: AnimatedStyle<ViewStyle>;
  borderRadius: number;
  color: string;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[StyleSheet.absoluteFill, { borderRadius, overflow: 'hidden', pointerEvents: 'none' }]}>
      <Animated.View style={[{ width: '100%', height: '100%' }, style]}>
        <LinearGradient
          colors={['transparent', color, 'transparent']}
          locations={[0.3, 0.5, 0.7]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

export function StatusPulseDecorationLayer({
  cardWidth,
  color,
  borderRadius,
  testID,
}: {
  cardWidth: number;
  color: string;
  borderRadius: number;
  testID: string;
}) {
  const decoration = useStatusPulseDecoration({
    isRunning: true,
    cardWidth,
    successColor: color,
    staticBackground: withAlphaColor(color, 0.07),
    staticBorder: withAlphaColor(color, 0.12),
    staticShadowOpacity: 0,
    staticElevation: 0,
  });
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          decoration.animatedStyle,
          { borderRadius, borderWidth: StyleSheet.hairlineWidth },
        ]}
      />
      {decoration.showShimmer ? (
        <StatusPulseShimmer
          testID={testID}
          borderRadius={borderRadius}
          color={decoration.shimmerColor}
          style={decoration.shimmerStyle}
        />
      ) : null}
    </>
  );
}

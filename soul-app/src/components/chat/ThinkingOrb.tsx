/**
 * thinking-orbs by Jakub Antalik, MIT.
 * Parameters and the `orbits` algorithm are ported from thinking-orbs@0.2.0;
 * only CanvasRenderingContext2D.arc() is replaced by fixed React Native dot views.
 */

import React, { memo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  SOURCE_WORKING_20_PRESET,
  THINKING_ORB_SIZE,
  WORKING_ORB_DOTS,
  WORKING_ORB_MAX_RADIUS,
  calculateWorkingOrbDot,
  type WorkingOrbDotDescriptor,
} from './thinkingOrbGeometry';

interface ThinkingOrbProps {
  inkColor: string;
  surfaceColor: string;
}

interface ThinkingOrbDotProps extends ThinkingOrbProps {
  descriptor: WorkingOrbDotDescriptor;
  sourceTime: SharedValue<number>;
}

const DOT_BOX_SIZE = WORKING_ORB_MAX_RADIUS * 2;

const ThinkingOrbDot = memo(function ThinkingOrbDot({
  descriptor,
  sourceTime,
  inkColor,
  surfaceColor,
}: ThinkingOrbDotProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const frame = calculateWorkingOrbDot(
      sourceTime.value,
      descriptor.orbitIndex,
      descriptor.kind,
      descriptor.dotIndex,
    );

    return {
      opacity: frame.opacity,
      zIndex: frame.z,
      backgroundColor: interpolateColor(
        frame.white,
        [0, 1],
        [inkColor, surfaceColor],
      ),
      transform: [
        { translateX: frame.x - DOT_BOX_SIZE / 2 },
        { translateY: frame.y - DOT_BOX_SIZE / 2 },
        { scale: frame.radius / WORKING_ORB_MAX_RADIUS },
      ],
    };
  }, [descriptor, inkColor, sourceTime, surfaceColor]);

  return (
    <Animated.View
      testID={`thinking-orb-dot-${descriptor.id}`}
      style={[styles.dot, animatedStyle]}
    />
  );
});

export const ThinkingOrb = memo(function ThinkingOrb({
  inkColor,
  surfaceColor,
}: ThinkingOrbProps) {
  const sourceTime = useSharedValue(0);

  useFrameCallback(({ timestamp }) => {
    'worklet';
    sourceTime.value =
      (timestamp / 1000) * SOURCE_WORKING_20_PRESET.speed;
  });

  return (
    <Animated.View
      testID="thinking-orb"
      pointerEvents="none"
      accessible={false}
      style={styles.orb}
    >
      {WORKING_ORB_DOTS.map((descriptor) => (
        <ThinkingOrbDot
          key={descriptor.id}
          descriptor={descriptor}
          sourceTime={sourceTime}
          inkColor={inkColor}
          surfaceColor={surfaceColor}
        />
      ))}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  orb: {
    width: THINKING_ORB_SIZE,
    height: THINKING_ORB_SIZE,
    overflow: 'hidden',
  },
  dot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: DOT_BOX_SIZE,
    height: DOT_BOX_SIZE,
    borderRadius: WORKING_ORB_MAX_RADIUS,
  },
});

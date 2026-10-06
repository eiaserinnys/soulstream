import React, { useState } from 'react';
import { View, type ImageSourcePropType } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSwayCharacterAnimation } from './useSwayCharacterAnimation';

const MAX_SWAY_DEGREES = 2.7;
const stillImage: ImageSourcePropType = require('../../../assets/characters/seosoyoung/still.png');

export interface SwayCharacterProps {
  width: number;
  height: number;
  shown: boolean;
  motionEnabled: boolean;
  active: boolean;
}

export function SwayCharacter({
  width,
  height,
  shown,
  motionEnabled,
  active,
}: SwayCharacterProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const { phase } = useSwayCharacterAnimation({ motionEnabled, active, shown: shown && !imageFailed });
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ skewX: `${MAX_SWAY_DEGREES * Math.sin(phase.value)}deg` }],
  }));

  if (!shown || imageFailed) return null;

  return <View
    pointerEvents="none"
    accessible={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    style={{ width, height }}
  >
    <Animated.Image
      source={stillImage}
      resizeMode="contain"
      onError={() => setImageFailed(true)}
      style={[{ width: '100%', height: '100%', transformOrigin: '50% 100%' }, animatedStyle]}
    />
  </View>;
}

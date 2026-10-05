import React from 'react';
import { View } from 'react-native';
import { useUIStore } from '../../store/uiStore';

export function HomeComposerSpacer({ enabled, precedingGap, testID }: {
  enabled: boolean;
  precedingGap: number;
  testID?: string;
}) {
  const height = useUIStore((state) => enabled ? state.floatingComposerBottomInset : 0);
  if (height <= 0) return null;

  return <View
    testID={testID}
    pointerEvents="none"
    accessible={false}
    style={{ height, marginTop: -precedingGap, flexShrink: 0 }}
  />;
}

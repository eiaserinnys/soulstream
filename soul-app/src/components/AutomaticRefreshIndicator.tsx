import React from 'react';
import { ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native';
import { useTokens } from '../theme';

/** The daily screen's small progress glyph. The containing frame owns its corner. */
export function AutomaticRefreshIndicator({ style, testID }: { style?: StyleProp<ViewStyle>; testID?: string }) {
  const t = useTokens();
  return <ActivityIndicator
    testID={testID}
    size="small"
    color={t.colors.accent}
    pointerEvents="none"
    accessibilityRole="progressbar"
    accessibilityLabel="자동 갱신 중"
    accessibilityState={{ busy: true }}
    style={[{ position: 'absolute' }, style]}
  />;
}

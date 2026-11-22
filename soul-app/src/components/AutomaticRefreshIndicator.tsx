import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';
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
    style={[{ position: 'absolute', overflow: 'hidden' }, style]}
  />;
}

/** A stable space for the same glyph in a row of controls. */
export function AutomaticRefreshSlot({ active, testID, indicatorTestID }: { active: boolean; testID?: string; indicatorTestID?: string }) {
  const t = useTokens();
  return <View testID={testID} pointerEvents="none" style={{ width: t.iconSize.prominent, height: t.iconSize.prominent, position: 'relative', flexShrink: 0 }}>
    {active ? <AutomaticRefreshIndicator testID={indicatorTestID} style={{ top: 0, right: 0 }} /> : null}
  </View>;
}

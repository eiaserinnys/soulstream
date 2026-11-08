import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTokens } from '../../theme';
import type { SurfaceRoleName } from '../../theme/surfaceRoles';
import { AppGlassCard } from '../AppGlassCard';

/** Long text stays in a regular foreground view above the native glass layer. */
export function PlannerForegroundCard({ children, testID, glassTestID, foregroundTestID, style, cornerRadius, role = 'glassCard' }: {
  children: React.ReactNode;
  testID?: string;
  glassTestID?: string;
  foregroundTestID?: string;
  style?: StyleProp<ViewStyle>;
  cornerRadius?: number;
  role?: SurfaceRoleName;
}) {
  const t = useTokens();
  const styles = useMemo(() => StyleSheet.create({
    frame: { position: 'relative', borderRadius: t.foundation.radius.card },
    glass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 0 },
    foreground: { position: 'relative', zIndex: 1 },
  }), [t]);
  return (
    <View testID={testID} style={[styles.frame, style]}>
      <AppGlassCard testID={glassTestID} role={role} cornerRadius={cornerRadius} style={styles.glass} />
      <View testID={foregroundTestID} style={styles.foreground}>{children}</View>
    </View>
  );
}

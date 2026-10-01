import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';

export function makeSettingsStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    flex: { flex: 1, ...roles.canvas.tokenStyle },
    container: {
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.xl,
      paddingTop: t.spacing.lg,
    },
    title: {
      ...t.foundation.typography.navigation,
      color: t.colors.textPrimary,
      marginBottom: t.spacing.xxl,
    },
  });
}

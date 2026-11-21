import type { ViewStyle } from 'react-native';
import type { DesignTokens } from '../theme';

export function getDefaultTabBarStyle(colors: DesignTokens['colors']): ViewStyle {
  return {
    backgroundColor: 'transparent',
    borderTopColor: colors.border,
    overflow: 'hidden',
  };
}

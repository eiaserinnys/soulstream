import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { AppGlassCard } from '../AppGlassCard';
import type { SurfaceRoleName } from '../../theme/surfaceRoles';

export function SettingsSurface({
  flattened,
  role,
  style,
  children,
}: {
  flattened: boolean;
  role: SurfaceRoleName;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return flattened
    ? <View style={style}>{children}</View>
    : <AppGlassCard role={role} style={style}>{children}</AppGlassCard>;
}

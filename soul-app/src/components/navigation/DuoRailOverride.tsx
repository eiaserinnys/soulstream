import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';
import { useActiveDuoRailOverride } from '../../navigation/phoneRailActions';
import { RailCapsule, RailCapsuleItem } from './RailCapsule';

export function DuoRailOverride() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const actions = useActiveDuoRailOverride();
  if (!actions?.length) return null;
  return <View testID="duo-rail-override-host" pointerEvents="box-none" style={{ position: 'absolute', right: 0, bottom: Math.max(insets.bottom, t.uiSpacing.xxl), width: insets.right, alignItems: 'center' }}>
    <RailCapsule testID="duo-rail-override" compact={actions.length >= 7 || height < 500}>
      {actions.map(action => <RailCapsuleItem key={action.id} testID={`duo-rail-action-${action.id}`} label={action.label}
        selected={action.selected} badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
        <Ionicons name={action.icon} size={t.iconSize.standard} color={action.selected ? t.colors.accent : t.colors.textMuted} />
      </RailCapsuleItem>)}
    </RailCapsule>
  </View>;
}

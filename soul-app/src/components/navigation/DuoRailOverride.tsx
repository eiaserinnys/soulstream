import React, { useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';
import { useActiveDuoRailOverride } from '../../navigation/phoneRailActions';
import { DUO_RAIL_END_INSET, getDuoRailTopOffset, splitDuoRailBackAction } from '../../navigation/duoSideBand';
import { RAIL_CAPSULE_WIDTH, RailCapsule, RailCapsuleItem } from './RailCapsule';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { duoRailLayout } from '../../navigation/duoRailLayout';

export function DuoRailOverride({ topOffset, bandWidth }: { topOffset?: number; bandWidth?: number }) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const railTopOffset = topOffset ?? getDuoRailTopOffset(width, height);
  const railBandWidth = bandWidth ?? insets.right;
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const actions = useActiveDuoRailOverride();
  if (!actions?.length) return null;
  const { backAction, mainActions } = splitDuoRailBackAction(actions);
  const bottom = Math.max(keyboardOverlap, insets.bottom, t.uiSpacing.xxl);
  const menu = mainActions.find(action => action.kind === 'menu') ?? null;
  const layout = duoRailLayout({ exit: backAction?.disabled ? null : backAction,
    screen: mainActions.filter(action => action.kind !== 'menu' && action.kind !== 'rare'), nav: [],
    rare: mainActions.filter(action => action.kind === 'rare'), menu, windowHeight: height, topStart: railTopOffset,
    bottomReserve: Math.max(insets.bottom, t.uiSpacing.xxl), keyboardOverlap,
    tokens: { spacingXs: t.spacing.xs, uiSpacingXs: t.uiSpacing.xs, uiSpacingSm: t.uiSpacing.sm, hitTargetMin: t.hitTarget.min } });
  const renderAction = (action: typeof actions[number]) => <RailCapsuleItem key={action.id} testID={`duo-rail-action-${action.id}`} label={action.label}
        selected={action.selected} badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
        <Ionicons name={action.icon} size={t.iconSize.standard} color={action.selected ? t.colors.accent : t.colors.textMuted} />
      </RailCapsuleItem>;
  return <AppKeyboardAvoidingView pointerEvents="box-none" onOverlapChange={setKeyboardOverlap} style={StyleSheet.absoluteFill}>
  <View testID="duo-rail-override-host" pointerEvents="box-none" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: railBandWidth, alignItems: 'center', paddingRight: DUO_RAIL_END_INSET }}>
    {layout.exit ? <View style={{ position: 'absolute', top: railTopOffset, left: 0, right: DUO_RAIL_END_INSET, alignItems: 'center' }}>
      <RailCapsule testID={layout.screen.length ? 'duo-rail-back-capsule' : 'duo-rail-override'} compact={layout.compact}>{renderAction(layout.exit)}</RailCapsule>
    </View> : null}
    {layout.screen.length ? <View testID="duo-rail-override-lower" style={{ position: 'absolute', bottom, left: 0, right: DUO_RAIL_END_INSET, alignItems: 'center' }}>
      <RailCapsule testID="duo-rail-override" compact={layout.compact}>
        {layout.screen.map(renderAction)}
      </RailCapsule>
    </View> : null}
  </View></AppKeyboardAvoidingView>;
}

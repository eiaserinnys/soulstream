import React, { useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';
import { useActiveDuoRailOverride } from '../../navigation/phoneRailActions';
import { DUO_RAIL_END_INSET, getDuoRailTopOffset, splitDuoRailBackAction } from '../../navigation/duoSideBand';
import { RAIL_ITEM_HEIGHT, RailCapsule, RailCapsuleItem, RailCapsuleViewport } from './RailCapsule';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';

export function DuoRailOverride() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const actions = useActiveDuoRailOverride();
  if (!actions?.length) return null;
  const { backAction, mainActions } = splitDuoRailBackAction(actions);
  const compact = actions.length >= 7 || height < 500;
  const bottom = Math.max(keyboardOverlap, insets.bottom, t.uiSpacing.xxl);
  const lowerMaxHeight = backAction && keyboardOverlap > 0
    ? Math.max(0, height - bottom - getDuoRailTopOffset(width, height)
      - (compact ? t.hitTarget.min + 2 * t.spacing.xxs : RAIL_ITEM_HEIGHT + 2 * t.spacing.xs) - t.uiSpacing.xs)
    : undefined;
  const renderAction = (action: typeof actions[number]) => <RailCapsuleItem key={action.id} testID={`duo-rail-action-${action.id}`} label={action.label}
        selected={action.selected} badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
        <Ionicons name={action.icon} size={t.iconSize.standard} color={action.selected ? t.colors.accent : t.colors.textMuted} />
      </RailCapsuleItem>;
  return <AppKeyboardAvoidingView pointerEvents="box-none" onOverlapChange={setKeyboardOverlap} style={StyleSheet.absoluteFill}>
  <View testID="duo-rail-override-host" pointerEvents="box-none" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: insets.right, alignItems: 'center', paddingRight: DUO_RAIL_END_INSET }}>
    {backAction ? <View style={{ position: 'absolute', top: getDuoRailTopOffset(width, height) }}>
      <RailCapsule testID={mainActions.length ? 'duo-rail-back-capsule' : 'duo-rail-override'} compact={compact}>{renderAction(backAction)}</RailCapsule>
    </View> : null}
    {mainActions.length ? <View testID="duo-rail-override-lower" style={{ position: 'absolute', bottom }}>
      <RailCapsuleViewport testID="duo-rail-override-scroll" maxHeight={lowerMaxHeight}><RailCapsule testID="duo-rail-override" compact={compact}>{mainActions.map(renderAction)}</RailCapsule></RailCapsuleViewport>
    </View> : null}
  </View></AppKeyboardAvoidingView>;
}

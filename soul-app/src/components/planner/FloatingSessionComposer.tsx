import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { useUIStore } from '../../store/uiStore';
import { TodayCardComposer } from './TodayCardComposer';
import type { ApiClient } from '../../api/client';

/** Hosts choose placement; the existing composer owns every visual and action. */
export function FloatingSessionComposer({ api, style, onCoveredHeightChange, onSessionCreated }: {
  api: ApiClient | null;
  style?: StyleProp<ViewStyle>;
  onCoveredHeightChange(height: number): void;
  onSessionCreated?(sessionId: string): void;
}) {
  const t = useTokens();
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const collapse = () => { if (Platform.OS === 'ios') Keyboard.dismiss(); setExpanded(false); };
  useEffect(() => () => onCoveredHeightChange(0), [onCoveredHeightChange]);
  return <View testID="home-session-composer-dock" pointerEvents="box-none" style={style}
    onLayout={event => { onCoveredHeightChange(event.nativeEvent.layout.height + t.uiSpacing.md); }}>
    {opened || Platform.OS !== 'ios' ? <View style={Platform.OS === 'ios' && !expanded ? { display: 'none' } : undefined}>
      <TodayCardComposer api={api} autoFocus={Platform.OS === 'ios' && expanded} onCollapse={Platform.OS === 'ios' ? collapse : undefined}
        onCreated={sessionId => { collapse(); if (onSessionCreated) onSessionCreated(sessionId); else useUIStore.getState().openSessionAtEvent(sessionId); }} />
    </View> : null}
    {Platform.OS === 'ios' && !expanded ? <View pointerEvents="box-none" style={{ alignItems: 'flex-end' }}>
        <GlassButton testID="home-session-composer-trigger" surfaceTestID="home-session-composer-trigger-surface"
          accessibilityLabel="새 대화" variant="primary" borderRadius={t.foundation.radius.round}
          contentStyle={{ paddingHorizontal: t.uiSpacing.lg, gap: t.uiSpacing.xs }} onPress={() => { setOpened(true); setExpanded(true); }}>
          <Ionicons name="add" size={t.iconSize.standard} color={t.colors.accentText} />
          <Text style={{ ...t.foundation.typography.body, fontWeight: '600', color: t.colors.accentText }}>새 대화</Text>
        </GlassButton>
      </View> : null}
  </View>;
}

import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTokens } from '../../theme';
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
  useEffect(() => () => onCoveredHeightChange(0), [onCoveredHeightChange]);
  return <View testID="home-session-composer-dock" style={style}
    onLayout={event => { onCoveredHeightChange(event.nativeEvent.layout.height + t.uiSpacing.md); }}>
    <TodayCardComposer api={api} onCreated={onSessionCreated} />
  </View>;
}

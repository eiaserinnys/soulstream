import React, { forwardRef, useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { useTokens } from '../theme';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle, type FolderCardDisplay } from '../components/planner/CardBoardWorkspace';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { FloatingSessionComposer } from '../components/planner/FloatingSessionComposer';
import { usePhoneRailMode } from '../navigation/tabContract';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function PhoneHomeComposerHost({ api, bottomOffset, onCoveredHeightChange, onSessionCreated }: {
  api: ApiClient | null; bottomOffset: number; onCoveredHeightChange(height: number): void; onSessionCreated?(sessionId: string): void;
}) {
  const t = useTokens();
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  return <AppKeyboardAvoidingView testID="card-home-screen" pointerEvents="box-none"
    behavior={Platform.OS === 'ios' ? 'padding' : undefined} onOverlapChange={setKeyboardOverlap} style={StyleSheet.absoluteFill}>
    <FloatingSessionComposer api={api} onCoveredHeightChange={onCoveredHeightChange} onSessionCreated={onSessionCreated}
      style={{ position: 'absolute', left: t.uiSpacing.lg, right: t.uiSpacing.lg,
        bottom: keyboardOverlap > 0 ? keyboardOverlap + t.uiSpacing.md : bottomOffset }} />
  </AppKeyboardAvoidingView>;
}

export const CardHomeScreen = forwardRef<CardBoardWorkspaceHandle, {
  onOpen(id: string): void; onSessionCreated?(id: string): void;
  externalHeader?: boolean; cardDisplay?: FolderCardDisplay; api?: ApiClient | null;
}>(function CardHomeScreen({ onOpen, onSessionCreated, externalHeader, cardDisplay: controlledDisplay, api: injectedApi }, ref) {
  const t = useTokens();
  const railMode = usePhoneRailMode();
  const insets = useSafeAreaInsets();
  const bottomOffset = railMode ? Math.max(insets.bottom, t.uiSpacing.md) : t.uiSpacing.md;
  const setFloatingComposerBottomInset = useUIStore((state) => state.setFloatingComposerBottomInset);
  const onCoveredHeightChange = useCallback((height: number) => {
    setFloatingComposerBottomInset(height + (bottomOffset - t.uiSpacing.md));
  }, [setFloatingComposerBottomInset, bottomOffset, t.uiSpacing.md]);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => injectedApi !== undefined ? injectedApi : serverUrl ? createApiClient(serverUrl) : null, [injectedApi, serverUrl]);
  const cardDisplay = useCardDisplay();
  return <View testID="card-home-content" collapsable={false}
    style={{ flex: 1, minHeight: 0, position: 'relative', backgroundColor: t.colors.background }}>
    <View style={{ flex: 1, minHeight: 0 }}>
      <CardBoardWorkspace ref={ref} api={api} cardDisplay={controlledDisplay ?? cardDisplay} externalHeader={externalHeader} onOpen={onOpen} reserveHomeComposerSpace />
    </View>
    <PhoneHomeComposerHost api={api} bottomOffset={bottomOffset} onCoveredHeightChange={onCoveredHeightChange} onSessionCreated={onSessionCreated} />
  </View>;
});

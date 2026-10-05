import React, { forwardRef, useMemo } from 'react';
import { Platform, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { useTokens } from '../theme';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle, type FolderCardDisplay } from '../components/planner/CardBoardWorkspace';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { FloatingSessionComposer } from '../components/planner/FloatingSessionComposer';

export const CardHomeScreen = forwardRef<CardBoardWorkspaceHandle, {
  onOpen(id: string): void; onSessionCreated?(id: string): void;
  externalHeader?: boolean; cardDisplay?: FolderCardDisplay; api?: ApiClient | null;
}>(function CardHomeScreen({ onOpen, onSessionCreated, externalHeader, cardDisplay: controlledDisplay, api: injectedApi }, ref) {
  const t = useTokens();
  const setFloatingComposerBottomInset = useUIStore((state) => state.setFloatingComposerBottomInset);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => injectedApi !== undefined ? injectedApi : serverUrl ? createApiClient(serverUrl) : null, [injectedApi, serverUrl]);
  const cardDisplay = useCardDisplay();
  return <AppKeyboardAvoidingView testID="card-home-screen" style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View testID="card-home-content" style={{ flex: 1, position: 'relative' }}>
      <CardBoardWorkspace ref={ref} api={api} cardDisplay={controlledDisplay ?? cardDisplay} externalHeader={externalHeader} onOpen={onOpen} reserveHomeComposerSpace />
      <FloatingSessionComposer api={api} style={{ position: 'absolute', left: t.uiSpacing.lg, right: t.uiSpacing.lg, bottom: t.uiSpacing.md }}
        onCoveredHeightChange={setFloatingComposerBottomInset} onSessionCreated={onSessionCreated} />
    </View>
  </AppKeyboardAvoidingView>;
});

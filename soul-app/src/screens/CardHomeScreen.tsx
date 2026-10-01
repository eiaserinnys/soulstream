import React, { forwardRef, useMemo } from 'react';
import { Platform } from 'react-native';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle, type FolderCardDisplay } from '../components/planner/CardBoardWorkspace';
import { useCardDisplay } from '../hooks/useCardDisplay';

export const CardHomeScreen = forwardRef<CardBoardWorkspaceHandle, { onOpen(id: string): void; externalHeader?: boolean; cardDisplay?: FolderCardDisplay }>(function CardHomeScreen({ onOpen, externalHeader, cardDisplay: controlledDisplay }, ref) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const cardDisplay = useCardDisplay();
  return <AppKeyboardAvoidingView testID="card-home-screen" style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <CardBoardWorkspace ref={ref} api={api} cardDisplay={controlledDisplay ?? cardDisplay} externalHeader={externalHeader} onOpen={onOpen} />
  </AppKeyboardAvoidingView>;
});

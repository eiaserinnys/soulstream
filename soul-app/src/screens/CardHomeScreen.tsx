import React, { useMemo } from 'react';
import { Platform } from 'react-native';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';

export function CardHomeScreen({ onOpen }: { onOpen(id: string): void }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <AppKeyboardAvoidingView testID="card-home-screen" style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <CardBoardWorkspace api={api} cardDisplay={{ includeCompleted: true, onChange: () => {} }} onOpen={onOpen} />
  </AppKeyboardAvoidingView>;
}

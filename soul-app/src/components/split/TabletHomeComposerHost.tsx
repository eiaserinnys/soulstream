import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useUIStore } from '../../store/uiStore';
import { useTokens } from '../../theme';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { FloatingSessionComposer } from '../planner/FloatingSessionComposer';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';

/** An absolute sibling of the panel row, shared by both tablet orientations. */
export function TabletHomeComposerHost() {
  const t = useTokens();
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const visible = useUIStore(state => state.activeSection.kind === 'daily'
    && (state.mainPaneViews.global ?? 'board') === 'board'
    && !state.folderOverlayVisible && !state.settingsVisible && !state.cardBoardExpanded);
  const setInset = useUIStore(state => state.setFloatingComposerBottomInset);
  if (!visible) return null;
  return <AppKeyboardAvoidingView testID="tablet-home-composer-host" pointerEvents="box-none"
    behavior="padding" style={StyleSheet.absoluteFill}>
    <View pointerEvents="box-none" style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: t.uiSpacing.md }}>
      <FloatingSessionComposer api={api} style={{ width: '60%' }} onCoveredHeightChange={setInset}
        onSessionCreated={id => useUIStore.getState().openSessionOverlay(id)} />
    </View>
  </AppKeyboardAvoidingView>;
}

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, View, type AlertButton } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from '../navigation/TabNavigator';
import { ThreePaneLayout } from '../components/split/ThreePaneLayout';
import { TwoPaneWithDrawer } from '../components/split/TwoPaneWithDrawer';
import { useDeviceType } from '../theme';
import { useTokens } from '../theme';
import { useSessionStore } from '../store/sessionStore';
import { entryShellCatalogSessions, entryShellFolders, entryShellSessions } from './fixtures';
import { AppModalSurface } from '../components/AppModalSurface';
import { GroupedGlassRow, GroupedGlassSheet } from '../components/planner/GroupedGlassSheet';
import { ENTRY_SHELL_ALERT_EVENT, installEntryShellPublicHarness, type EntryShellAlertRequest } from './fixture-client';

function EntryShellAlertHarness() {
  const t = useTokens();
  const [request, setRequest] = useState<EntryShellAlertRequest | null>(null);
  const selectedButton = useRef<AlertButton | undefined>(undefined);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const removeHarness = installEntryShellPublicHarness();
    const receive = (event: Event) => setRequest((event as CustomEvent<EntryShellAlertRequest>).detail);
    window.addEventListener(ENTRY_SHELL_ALERT_EVENT, receive);
    return () => {
      window.removeEventListener(ENTRY_SHELL_ALERT_EVENT, receive);
      removeHarness();
    };
  }, []);
  return <AppModalSurface visible={request !== null} modalId="modal_card_assignment" variant="compact"
    onRequestClose={() => { selectedButton.current = undefined; setRequest(null); }}
    onDismiss={() => {
      const button = selectedButton.current;
      selectedButton.current = undefined;
      button?.onPress?.();
    }}>
    <ScrollView testID="entry-shell-os-alert-harness" contentContainerStyle={{ padding: t.cardLayout.padding, gap: t.uiSpacing.sm }}>
      <Text style={t.foundation.typography.section}>공개 검수용 시스템 메뉴 대체</Text>
      {request?.title ? <Text style={t.foundation.typography.body}>{request.title}</Text> : null}
      {request?.message ? <Text style={t.foundation.typography.body}>{request.message}</Text> : null}
      <GroupedGlassSheet>
        {(request?.buttons ?? []).map((button, index) => <GroupedGlassRow key={`${button.text ?? '취소'}-${index}`} compact
          testID={`entry-shell-os-menu-${index}`} accessibilityLabel={button.text ?? '취소'} onPress={() => {
            selectedButton.current = button;
            setRequest(null);
          }}>
          <Text style={t.foundation.typography.body}>{button.text ?? '취소'}</Text>
        </GroupedGlassRow>)}
      </GroupedGlassSheet>
    </ScrollView>
  </AppModalSurface>;
}

/** Real phone tab/stack/home and tablet split tree. Metro injects fixture transport. */
export function ReviewEntryShell() {
  const device = useDeviceType();
  useLayoutEffect(() => {
    if (device === 'phone') return;
    const reviewFolders = useSessionStore.getState().catalog.folders.filter(folder => !folder.id.startsWith('public-shell-folder-'));
    useSessionStore.getState().setCatalog({ folders: [...reviewFolders, ...entryShellFolders], sessions: entryShellCatalogSessions });
    useSessionStore.getState().setSessions(entryShellSessions);
  }, [device]);
  return <View style={{ flex: 1 }}><NavigationContainer>{device === 'phone' ? <TabNavigator />
    : device === 'tabletLandscape' ? <ThreePaneLayout /> : <TwoPaneWithDrawer />}</NavigationContainer>
    <EntryShellAlertHarness />
  </View>;
}

import { AdaptiveNavigationHost } from '../navigation/AdaptiveNavigationHost';
import { LayoutContinuityProvider } from '../navigation/LayoutContinuityContext';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, View, type AlertButton } from 'react-native';
import { PersistentSessionProvider } from '../navigation/PersistentSessionContext';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { useDeviceType } from '../theme';
import { useTokens } from '../theme';
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
  const t = useTokens();
  return <View style={{ flex: 1 }}><PersistentSessionProvider><LayoutContinuityProvider>
    <ContentLinkProvider><AdaptiveNavigationHost device={device} /></ContentLinkProvider>
  </LayoutContinuityProvider></PersistentSessionProvider>
    <EntryShellAlertHarness />
  </View>;
}

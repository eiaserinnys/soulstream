import React, { useCallback, useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createApiClient } from '../api/client';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { MarkdownDocumentContent } from '../components/planner/MarkdownDocumentContent';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens, type DesignTokens } from '../theme';
import { openPhoneChat } from './phoneSessionNavigation';
import { usePhoneRailMode } from './tabContract';
import { useDuoSideBand } from './duoSideBand';

export type MarkdownDocumentRouteParams = { documentId: string };

export function getDefaultTabBarStyle(colors: DesignTokens['colors']): ViewStyle {
  return {
    backgroundColor: 'transparent',
    borderTopColor: colors.border,
    overflow: 'hidden',
  };
}

function PhoneDetailScreenFrame({ navigation, children }: { navigation: any; children: React.ReactNode }) {
  const t = useTokens();
  const railMode = usePhoneRailMode();
  const duo = useDuoSideBand();
  useFocusEffect(useCallback(() => {
    if (duo) return;
    const tabs = navigation.getParent();
    tabs?.setOptions({ tabBarStyle: { ...getDefaultTabBarStyle(t.colors), display: 'none' } });
    return () => {
      const state = navigation.getState?.();
      const index = state?.index ?? ((state?.routes?.length ?? 0) - 1);
      const topRoute = state?.routes?.[index]?.name;
      if (topRoute === 'CardDetail' || topRoute === 'MarkdownDocument') return;
      tabs?.setOptions({ tabBarStyle: getDefaultTabBarStyle(t.colors) });
    };
  }, [navigation, t.colors, duo]));
  return <SafeAreaView edges={railMode ? ['top', 'left'] : ['top', 'left', 'right']} style={{ flex: 1, paddingTop: t.uiSpacing.md }}>{children}</SafeAreaView>;
}

export function PhoneCardDetail({ route, navigation }: {
  route: { params: { cardId: string } };
  navigation: any;
}) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const visible = useIsFocused();
  return <PhoneDetailScreenFrame navigation={navigation}>
    <CardDetailContent visible={visible} api={api} cardId={route.params.cardId} onClose={() => navigation.goBack()}
      onOpenSession={(id) => openPhoneChat(navigation, id)} />
  </PhoneDetailScreenFrame>;
}

export function PhoneMarkdownDocument({ route, navigation }: {
  route: { params: MarkdownDocumentRouteParams };
  navigation: any;
}) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const visible = useIsFocused();
  return <PhoneDetailScreenFrame navigation={navigation}>
    <MarkdownDocumentContent visible={visible} api={api} documentId={route.params.documentId}
      onClose={() => navigation.goBack()} />
  </PhoneDetailScreenFrame>;
}

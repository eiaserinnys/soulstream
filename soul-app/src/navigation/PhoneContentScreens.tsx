import React, { useCallback, useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MarkdownDocument } from '../api/boardItemEndpoints';
import { createApiClient } from '../api/client';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { MarkdownDocumentContent } from '../components/planner/MarkdownDocumentContent';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens, type DesignTokens } from '../theme';
import { openPhoneChat } from './phoneSessionNavigation';

export type MarkdownDocumentRouteParams = { documentId: string; initialDocument?: MarkdownDocument };

export function getDefaultTabBarStyle(colors: DesignTokens['colors']): ViewStyle {
  return {
    backgroundColor: 'transparent',
    borderTopColor: colors.border,
    overflow: 'hidden',
  };
}

function PhoneDetailScreenFrame({ navigation, children }: { navigation: any; children: React.ReactNode }) {
  const t = useTokens();
  useFocusEffect(useCallback(() => {
    const tabs = navigation.getParent();
    tabs?.setOptions({ tabBarStyle: { ...getDefaultTabBarStyle(t.colors), display: 'none' } });
    return () => { tabs?.setOptions({ tabBarStyle: getDefaultTabBarStyle(t.colors) }); };
  }, [navigation, t.colors]));
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>{children}</SafeAreaView>;
}

export function PhoneCardDetail({ route, navigation }: {
  route: { params: { cardId: string } };
  navigation: any;
}) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <PhoneDetailScreenFrame navigation={navigation}>
    <CardDetailContent api={api} cardId={route.params.cardId} onClose={() => navigation.goBack()}
      onOpenSession={(id) => openPhoneChat(navigation, id)} />
  </PhoneDetailScreenFrame>;
}

export function PhoneMarkdownDocument({ route, navigation }: {
  route: { params: MarkdownDocumentRouteParams };
  navigation: any;
}) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <PhoneDetailScreenFrame navigation={navigation}>
    <MarkdownDocumentContent api={api} documentId={route.params.documentId}
      initialDocument={route.params.initialDocument} onClose={() => navigation.goBack()} />
  </PhoneDetailScreenFrame>;
}

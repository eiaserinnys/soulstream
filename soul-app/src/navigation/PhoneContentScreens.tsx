import React, { useCallback, useMemo, useRef } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createApiClient } from '../api/client';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { MarkdownDocumentContent } from '../components/planner/MarkdownDocumentContent';
import { PasReportWindowBound } from '../components/pasReport/PasReportWindowBound';
import type { PasReportWindowHandle } from '../components/pasReport/PasReportWindow';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { openPhoneChat } from './phoneSessionNavigation';
import { getDefaultTabBarStyle } from './tabBarStyle';
import { usePhoneRailMode } from './tabContract';
import { useDuoSideBand } from './duoSideBand';

export type MarkdownDocumentRouteParams = { documentId: string };
export type PasReportWindowRouteParams = { startCardId: string | null };

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
      if (topRoute === 'CardDetail' || topRoute === 'MarkdownDocument' || topRoute === 'PasReportWindow') return;
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

/** PAS 결재형 보고 창(#1871). PAS 화면 스택 위에 push되고, 카드 패널 열기는 기존 CardDetail 화면으로 간다. */
export function PhonePasReportWindow({ route, navigation }: {
  route: { params: PasReportWindowRouteParams };
  navigation: any;
}) {
  const windowRef = useRef<PasReportWindowHandle>(null);
  const closing = useRef(false);
  // 뒤로 가기(안드로이드 하드웨어 뒤로, iOS 가장자리 끌기)는 열린 것 하나씩(서랍, 답변 미루기 펼침, 입력창, 보고 창 순) 닫는다.
  useFocusEffect(useCallback(() => navigation.addListener('beforeRemove', (event: { preventDefault(): void }) => {
    if (closing.current) return;
    if (windowRef.current?.back()) event.preventDefault();
  }), [navigation]));
  return <PhoneDetailScreenFrame navigation={navigation}>
    <PasReportWindowBound ref={windowRef} startCardId={route.params.startCardId}
      onClose={() => { closing.current = true; navigation.goBack(); }}
      onOpenCard={cardId => navigation.navigate('CardDetail', { cardId })} />
  </PhoneDetailScreenFrame>;
}

import React, { useEffect, useMemo } from 'react';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, TouchableWithoutFeedback, View, useWindowDimensions } from 'react-native';
import { createApiClient } from '../api/client';
import { SplitLayout } from '../components/split/SplitLayout';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { MarkdownDocumentContent } from '../components/planner/MarkdownDocumentContent';
import { openPlannerSessionWorkspace } from '../lib/planner-folder-workspace';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { useSettingsStore } from '../store/settingsStore';
import { usePersistentSessionHost } from './PersistentSessionContext';
import { AppGlassCard } from '../components/AppGlassCard';
import { FOLDER_WORKSPACE_BACKDROP_COLOR, getCardDetailPaneWidth, getFolderWorkspaceOverlayWidth } from '../lib/folder-workspace-layout';
import { createSurfaceRoles, useTokens } from '../theme';

export type TabletStackParamList = {
  Main: undefined;
  PersistentSession: undefined;
  CardDetail: { cardId: string };
  MarkdownDocument: { documentId: string };
};
const Stack = createNativeStackNavigator<TabletStackParamList>();

function TabletMain({ navigation }: NativeStackScreenProps<TabletStackParamList, 'Main'>) {
  const host = usePersistentSessionHost();
  useEffect(() => {
    // 좁은 iPad 창에서 돌아와도 Main을 먼저 마운트해 기존 스트림을 유지한다.
    if (host.store.getState().visible) navigation.navigate('PersistentSession');
  }, [host.store, navigation]);
  return <SplitLayout />;
}

function TabletPersistentSession({ navigation }: NativeStackScreenProps<TabletStackParamList, 'PersistentSession'>) {
  const host = usePersistentSessionHost();
  return <PersistentSessionScreen active={useIsFocused()}
    onHome={() => { host.store.getState().leave(); navigation.goBack(); }} />;
}

function TabletCardDetail({ route, navigation }: NativeStackScreenProps<TabletStackParamList, 'CardDetail'>) {
  const host = usePersistentSessionHost();
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <TabletDetailScreenFrame navigation={navigation} testID="persistent-tablet-card-sheet" accessibilityLabel="카드 상세 닫기">
    <CardDetailContent inline api={api} cardId={route.params.cardId} onClose={() => navigation.goBack()}
      onOpenSession={sessionId => { host.store.getState().leave(); navigation.popTo('Main'); void openPlannerSessionWorkspace(sessionId); }} />
  </TabletDetailScreenFrame>;
}

function TabletMarkdownDocument({ route, navigation }: NativeStackScreenProps<TabletStackParamList, 'MarkdownDocument'>) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <TabletDetailScreenFrame navigation={navigation} testID="persistent-tablet-document-sheet" accessibilityLabel="문서 닫기">
    <MarkdownDocumentContent api={api} documentId={route.params.documentId}
      onClose={() => navigation.goBack()} />
  </TabletDetailScreenFrame>;
}

function TabletDetailScreenFrame({ navigation, testID, accessibilityLabel, children }: {
  navigation: { goBack(): void };
  testID: string;
  accessibilityLabel: string;
  children: React.ReactNode;
}) {
  const t = useTokens();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const sheetWidth = getCardDetailPaneWidth(getFolderWorkspaceOverlayWidth(width));
  return <View style={{ flex: 1, display: focused ? 'flex' : 'none' }}>
    <TouchableWithoutFeedback onPress={() => navigation.goBack()} accessibilityLabel={accessibilityLabel}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: FOLDER_WORKSPACE_BACKDROP_COLOR }]} />
    </TouchableWithoutFeedback>
    <SafeAreaView edges={['top', 'bottom', 'right']} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: sheetWidth }}>
      <AppGlassCard role="glassSoft" testID={testID} style={{ flex: 1, borderRadius: t.foundation.radius.panel }}>
        <View style={{ flex: 1, backgroundColor: createSurfaceRoles(t).glassCard.tokenStyle.backgroundColor }}>
          {children}
        </View>
      </AppGlassCard>
    </SafeAreaView>
  </View>;
}

export function TabletNavigator() {
  const t = useTokens();
  return <Stack.Navigator initialRouteName="Main" screenOptions={{ headerShown: false, contentStyle: createSurfaceRoles(t).canvas.tokenStyle }}>
    <Stack.Screen name="Main" component={TabletMain} />
    <Stack.Screen name="PersistentSession" component={TabletPersistentSession} />
    <Stack.Screen name="CardDetail" component={TabletCardDetail} options={{ presentation: 'transparentModal' }} />
    <Stack.Screen name="MarkdownDocument" component={TabletMarkdownDocument} options={{ presentation: 'transparentModal' }} />
  </Stack.Navigator>;
}

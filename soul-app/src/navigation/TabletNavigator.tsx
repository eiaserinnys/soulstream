import React, { useEffect, useMemo } from 'react';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createApiClient } from '../api/client';
import { SplitLayout } from '../components/split/SplitLayout';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { openPlannerSessionWorkspace } from '../lib/planner-folder-workspace';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { useSettingsStore } from '../store/settingsStore';
import { usePersistentSessionHost } from './PersistentSessionContext';

export type TabletStackParamList = {
  Main: undefined;
  PersistentSession: undefined;
  CardDetail: { cardId: string };
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
    onHome={() => { host.store.getState().leave(); navigation.goBack(); }}
    onOpenCard={cardId => navigation.navigate('CardDetail', { cardId })}
    onOpenSession={sessionId => { host.store.getState().leave(); navigation.popTo('Main'); void openPlannerSessionWorkspace(sessionId); }} />;
}

function TabletCardDetail({ route, navigation }: NativeStackScreenProps<TabletStackParamList, 'CardDetail'>) {
  const host = usePersistentSessionHost();
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
    <CardDetailContent api={api} cardId={route.params.cardId} onClose={() => navigation.goBack()}
      onOpenSession={sessionId => { host.store.getState().leave(); navigation.popTo('Main'); void openPlannerSessionWorkspace(sessionId); }} />
  </SafeAreaView>;
}

export function TabletNavigator() {
  return <Stack.Navigator initialRouteName="Main" screenOptions={{ headerShown: false }}>
    <Stack.Screen name="Main" component={TabletMain} />
    <Stack.Screen name="PersistentSession" component={TabletPersistentSession} />
    <Stack.Screen name="CardDetail" component={TabletCardDetail} />
  </Stack.Navigator>;
}

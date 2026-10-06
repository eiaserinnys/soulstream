import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { usePersistentSessionHost, usePersistentSessionScene, PersistentSessionPortrait } from './PersistentSessionContext';
import { usePhoneConversationKeyboard } from './usePhoneConversationKeyboard';
import { openPhoneChat } from './phoneSessionNavigation';

export function PhonePersistentSession({ navigation }: { navigation: any }) {
  const host = usePersistentSessionHost();
  const focused = useIsFocused();
  usePhoneConversationKeyboard(navigation);
  const home = useCallback(() => {
    host.store.getState().leave();
    navigation.getParent()?.navigate('DailyTab');
  }, [host.store, navigation]);
  useFocusEffect(useCallback(() => navigation.addListener('beforeRemove', (event: any) => {
    const state = host.store.getState();
    event.preventDefault();
    if (state.scene === 'cards') state.swipe('right');
    else home();
  }), [host.store, home, navigation]));
  return <PersistentSessionScreen active={focused} onHome={home}
    onOpenCard={cardId => navigation.navigate('CardDetail', { cardId })}
    onOpenSession={sessionId => { host.store.getState().leave(); openPhoneChat(navigation, sessionId); }} />;
}

export function PersistentPhoneTabIcon({ color, size, active }: { color: string; size: number; active: boolean }) {
  const host = usePersistentSessionHost();
  const scene = usePersistentSessionScene(state => state.scene);
  return <View testID="persistent-phone-tab-portrait" style={{ width: size, height: size,
    borderRadius: size / 2, borderWidth: StyleSheet.hairlineWidth, borderColor: color }}>
    <PersistentSessionPortrait session={host.portrait} size={size} />
    {active && scene === 'cards' ? <View testID="persistent-phone-tab-list" pointerEvents="none"
      style={{ position: 'absolute', inset: 0 }}>
      <Ionicons name="list-outline" color={color} size={size} />
    </View> : null}
  </View>;
}

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GLASS_BUTTON_BORDER_WIDTH } from '../components/GlassSurface';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { usePersistentSessionHost, usePersistentSessionScene, PersistentSessionPortrait } from './PersistentSessionContext';
import { usePhoneConversationKeyboard } from './usePhoneConversationKeyboard';

export function PhonePersistentSession({ navigation }: { navigation: any }) {
  const host = usePersistentSessionHost();
  const focused = useIsFocused();
  const [cardDetailOpen, setCardDetailOpen] = useState(false);
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
  useFocusEffect(useCallback(() => {
    setCardDetailOpen(false);
  }, []));
  const openCard = useCallback((cardId: string) => {
    setCardDetailOpen(true);
    navigation.navigate('CardDetail', { cardId });
  }, [navigation]);
  return <PersistentSessionScreen active={focused} chatActive={focused || cardDetailOpen}
    onOpenPhoneCard={openCard} onHome={home} />;
}

export function PersistentPhoneTabIcon({ color, size, active }: { color: string; size: number; active: boolean }) {
  const host = usePersistentSessionHost();
  const scene = usePersistentSessionScene(state => state.scene);
  if (host.loading) return <ActivityIndicator testID="persistent-entry-loading" size="small" color={color} />;
  if (!host.portrait) return <Ionicons testID="persistent-phone-tab-fallback" name="person-circle-outline" size={size} color={color} />;
  return <View testID="persistent-phone-tab-portrait" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <PersistentSessionPortrait session={host.portrait} size={size - GLASS_BUTTON_BORDER_WIDTH * 2} />
    <View testID="persistent-phone-tab-ring" pointerEvents="none" style={{ position: 'absolute', inset: 0,
      borderRadius: size / 2, borderWidth: active ? GLASS_BUTTON_BORDER_WIDTH : 0, borderColor: color }} />
    {active && scene === 'cards' ? <View testID="persistent-phone-tab-list" pointerEvents="none"
      style={{ position: 'absolute', inset: 0 }}>
      <Ionicons name="list-outline" color={color} size={size} />
    </View> : null}
  </View>;
}

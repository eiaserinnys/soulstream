import React from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { useTokens } from '../theme';
import { PersistentSessionPortrait, useOptionalPersistentSessionHost, usePersistentSessionHost } from './PersistentSessionContext';
import type { TabletStackParamList } from './TabletNavigator';

function ConnectedEntry() {
  const t = useTokens();
  const host = usePersistentSessionHost();
  const navigation = useNavigation<NativeStackNavigationProp<TabletStackParamList>>();
  return <LiquidGlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round}
    testID="tablet-persistent-entry" accessibilityLabel="영구 세션 열기"
    onPress={() => void host.requestEntry(() => navigation.navigate('PersistentSession'))}>
    <PersistentSessionPortrait session={host.portrait} size={t.iconSize.navigation} />
  </LiquidGlassButton>;
}
export function TabletPersistentEntry() {
  return useOptionalPersistentSessionHost() ? <ConnectedEntry /> : null;
}

import React from 'react';
import { ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { useTokens } from '../theme';
import { PersistentSessionPortrait, useOptionalPersistentSessionHost, usePersistentSessionHost } from './PersistentSessionContext';
import type { TabletStackParamList } from './TabletNavigator';
import { RailCapsuleItem } from '../components/navigation/RailCapsule';

function ConnectedEntry({ rail }: { rail: boolean }) {
  const t = useTokens();
  const host = usePersistentSessionHost();
  const navigation = useNavigation<NativeStackNavigationProp<TabletStackParamList>>();
  const onPress = () => void host.requestEntry(() => navigation.navigate('PersistentSession'));
  const portrait = host.loading ? <ActivityIndicator testID="persistent-entry-loading" color={t.colors.accent} />
    : <PersistentSessionPortrait session={host.portrait} size={t.iconSize.navigation} />;
  if (rail) return <RailCapsuleItem testID="tablet-persistent-entry" label="영구 세션 열기" onPress={onPress}>
    {portrait}
  </RailCapsuleItem>;
  return <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round}
    testID="tablet-persistent-entry" accessibilityLabel="영구 세션 열기"
    onPress={onPress}>
    {portrait}
  </LiquidGlassButton>;
}
export function TabletPersistentEntry({ rail = false }: { rail?: boolean } = {}) {
  return useOptionalPersistentSessionHost() ? <ConnectedEntry rail={rail} /> : null;
}

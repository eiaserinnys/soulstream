import React, { useLayoutEffect, useRef } from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DailyStackParamList } from './TabNavigator';
import { useTokens } from '../theme';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { CardHomeScreen } from '../screens/CardHomeScreen';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { CompletedCardsToggle } from '../components/planner/CompletedCardsToggle';
import type { CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { openPhoneChat } from './phoneSessionNavigation';

/** Home actions use the existing native root header slots. */
export function PhoneCardHome({ navigation }: NativeStackScreenProps<DailyStackParamList, 'Daily'>) {
  const t = useTokens();
  const boardRef = useRef<CardBoardWorkspaceHandle>(null);
  const cardDisplay = useCardDisplay();
  useLayoutEffect(() => { navigation.setOptions({
    headerTitleAlign: 'left',
    headerLeft: () => null,
    headerRight: () => <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
      <CompletedCardsToggle {...cardDisplay} />
      <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel="드래프트 카드 추가" onPress={() => boardRef.current?.openCreate()}>
      <Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
    </LiquidGlassButton>
      <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel="기존 데일리 기록" onPress={() => navigation.navigate('DailyHistory')}>
        <Ionicons name="today-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
      </LiquidGlassButton>
    </View>,
  }); }, [navigation, t, cardDisplay.includeCompleted, cardDisplay.onChange]);
  return <CardHomeScreen ref={boardRef} externalHeader cardDisplay={cardDisplay} onOpen={(cardId) => navigation.navigate('CardDetail', { cardId })}
    onSessionCreated={id => { openPhoneChat(navigation, id); }} />;
}

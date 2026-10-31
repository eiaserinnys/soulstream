import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DailyStackParamList } from './TabNavigator';
import { useTokens } from '../theme';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { CardHomeScreen } from '../screens/CardHomeScreen';
import { CompletedCardsToggle } from '../components/planner/CompletedCardsToggle';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { openPhoneChat } from './phoneSessionNavigation';
import { useDuoSideBand } from './duoSideBand';
import { usePhoneConversationKeyboard } from './usePhoneConversationKeyboard';
import { useRegisterPhoneRailActions, type PhoneRailAction } from './phoneRailActions';
import { DuoSafeTop } from './DuoSafeTop';

/** Home actions use the existing native root header slots. */
export function PhoneCardHome({ navigation }: NativeStackScreenProps<DailyStackParamList, 'Daily'>) {
  usePhoneConversationKeyboard(navigation);
  const t = useTokens();
  const boardRef = useRef<CardBoardWorkspaceHandle>(null);
  const cardDisplay = useCardDisplay();
  const duo = useDuoSideBand();
  const railActions = useMemo<PhoneRailAction[]>(() => [
    { id: 'create', label: '드래프트 카드 추가', icon: 'add-outline', onPress: () => boardRef.current?.openCreate() },
    { id: 'completed', label: '완료·취소 숨김', icon: cardDisplay.includeCompleted ? 'eye-outline' : 'eye-off-outline',
      selected: !cardDisplay.includeCompleted, onPress: () => cardDisplay.onChange(!cardDisplay.includeCompleted) },
  ], [cardDisplay.includeCompleted, cardDisplay.onChange]);
  useRegisterPhoneRailActions('DailyTab', duo, railActions);
  useLayoutEffect(() => { navigation.setOptions({
    headerTitleAlign: 'left',
    headerLeft: () => null,
    headerRight: () => <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
      <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round}
        accessibilityLabel="드래프트 카드 추가" onPress={() => boardRef.current?.openCreate()}>
        <Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
      </LiquidGlassButton>
      <CompletedCardsToggle {...cardDisplay} />
    </View>,
  }); }, [navigation, t, cardDisplay.includeCompleted, cardDisplay.onChange]);
  return <DuoSafeTop><CardHomeScreen ref={boardRef} externalHeader cardDisplay={cardDisplay} onOpen={(cardId) => navigation.navigate('CardDetail', { cardId })}
    onSessionCreated={id => { openPhoneChat(navigation, id); }} /></DuoSafeTop>;
}

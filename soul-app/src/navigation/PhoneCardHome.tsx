import React, { useLayoutEffect, useMemo, useRef } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DailyStackParamList } from './TabNavigator';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { CardHomeScreen } from '../screens/CardHomeScreen';
import { CardBoardHeaderActions, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { openPhoneChat } from './phoneSessionNavigation';
import { useDuoSideBand } from './duoSideBand';
import { DuoRailOverlayContext } from './tabContract';
import { usePhoneConversationKeyboard } from './usePhoneConversationKeyboard';
import { useRegisterPhoneRailActions, type PhoneRailAction } from './phoneRailActions';
import { DuoSafeTop } from './DuoSafeTop';

/** Home actions use the existing native root header slots. */
export function PhoneCardHome({ navigation }: NativeStackScreenProps<DailyStackParamList, 'Daily'>) {
  usePhoneConversationKeyboard(navigation);
  const boardRef = useRef<CardBoardWorkspaceHandle>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const cardDisplay = useCardDisplay();
  const duo = useDuoSideBand();
  const railOverlayWidth = React.useContext(DuoRailOverlayContext);
  const railActions = useMemo<PhoneRailAction[]>(() => [
    { id: 'create', label: '드래프트 카드 추가', icon: 'add-outline', onPress: () => boardRef.current?.openCreate() },
    { id: 'completed', label: '완료·취소 숨김', menuLabel: cardDisplay.includeCompleted ? '완료 카드 숨기기' : '완료 카드 보이기', icon: cardDisplay.includeCompleted ? 'eye-outline' : 'eye-off-outline',
      selected: !cardDisplay.includeCompleted, onPress: () => cardDisplay.onChange(!cardDisplay.includeCompleted) },
  ], [cardDisplay.includeCompleted, cardDisplay.onChange]);
  useRegisterPhoneRailActions('DailyTab', duo, railActions);
  useLayoutEffect(() => { navigation.setOptions({
    headerTitleAlign: 'left',
    headerLeft: () => null,
    headerRight: () => <CardBoardHeaderActions cardDisplay={cardDisplay} refreshing={refreshing}
      slotTestID="phone-card-header-refresh-slot" onCreate={() => boardRef.current?.openCreate()} />,
  }); }, [navigation, cardDisplay.includeCompleted, cardDisplay.onChange, refreshing]);
  return <DuoSafeTop><CardHomeScreen ref={boardRef} externalHeader cardDisplay={cardDisplay} railOverlayWidth={railOverlayWidth} onAutoRefreshChange={setRefreshing} externalHeaderHidden={duo} onOpen={(cardId) => navigation.navigate('CardDetail', { cardId })}
    onSessionCreated={id => { openPhoneChat(navigation, id); }} /></DuoSafeTop>;
}

import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, SafeAreaView, StyleSheet, Keyboard, Platform, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import type { ChatStackParamList } from '../navigation/TabNavigator';
import { getDefaultTabBarStyle } from '../navigation/TabNavigator';
import { useSessionStore } from '../store/sessionStore';
import { StatusDot } from '../components/chat/StatusDot';
import { RootSectionHeaderTitle } from '../components/navigation/RootSectionHeaderTitle';
import { ChatBody } from '../components/chat/ChatBody';
import { getSessionDisplayName } from '../lib/session-display-name';
import { useTokens, type DesignTokens } from '../theme';
import { useSettingsStore } from '../store/settingsStore';
import { createApiClient } from '../api/client';
import { usePlannerContextMenus } from '../hooks/usePlannerContextMenus';
import { SessionSuccessionHost } from '../components/planner/SessionSuccessionHost';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import {
  openPhoneFeed,
  openPreviousPhonePanel,
  openPhoneSearch,
} from '../navigation/phoneSessionNavigation';
import { usePhonePanelHistory } from '../navigation/phonePanelHistory';
import { useSearchStore } from '../store/searchStore';
import { LiquidGlassButton } from '../components/LiquidGlassButton';

type Props = NativeStackScreenProps<ChatStackParamList, 'Chat'>;

/**
 * 폰 TabNavigator 안에서 사용되는 채팅 화면.
 * 메시지 본문·입력·SSE 처리는 모두 ChatBody에 위임하고, 이 화면은 react-navigation
 * 헤더(상태 도트 + 세션 이름)만 담당한다.
 *
 * 빌드 26: 키보드 등장 시 탭 바 숨김을 v22 패턴(useFocusEffect + Keyboard 리스너)으로
 * 복원. 빌드 22~25에서 시도한 TabBarWithKeyboardHide(시작 시점 등록)는 iOS 26.3.1 +
 * RN New Arch에서 KeyboardObserver TurboModule 부팅 race로 부팅 크래시를 유발했다.
 *
 * 태블릿 split 레이아웃에서는 ChatPane이 같은 ChatBody를 다른 인라인 헤더로 감싸 쓴다.
 */
export function ChatScreen({ route, navigation }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const panelHistory = usePhonePanelHistory();
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const menus = usePlannerContextMenus(api);
  const isFocused = useIsFocused();

  // 키보드 등장 시 탭 바를 숨겨 KAV의 effective bottom = 화면 바닥이 되게 한다.
  // tabBarHideOnKeyboard는 iPad iOS 18+에서 hide 애니메이션 잔존 버그(둥근 상단 edge가
  // 키보드 위에 남음)가 있어 사용하지 않는다. 대신 useFocusEffect 안에서 Keyboard
  // 리스너로 tabBarStyle.display를 동적 토글하여 같은 UX를 얻으면서 잔존 edge를 피한다.
  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      const visible = getDefaultTabBarStyle(t.colors);
      const hidden = { ...visible, display: 'none' as const };
      // iOS는 keyboardWill* 가 키보드 애니메이션과 동기. Android는 Will* 미지원이라 Did* 사용.
      const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
      const showSub = Keyboard.addListener(showEvt, () => {
        parent?.setOptions({ tabBarStyle: hidden });
      });
      const hideSub = Keyboard.addListener(hideEvt, () => {
        parent?.setOptions({ tabBarStyle: visible });
      });
      return () => {
        showSub.remove();
        hideSub.remove();
        // 탭 전환·블러 시 탭 바를 보이는 상태로 복원 (키보드 떠 있는 상태에서 탭 이동 케이스).
        parent?.setOptions({ tabBarStyle: visible });
      };
    }, [navigation, t.colors])
  );

  const sessionId = route.params?.sessionId;
  React.useEffect(() => {
    if (sessionId) useSearchStore.getState().rememberSession(sessionId);
  }, [sessionId]);
  const focusEventId = route.params?.focusEventId ?? null;
  const focusTargetRef = useRef({ sessionId, eventId: focusEventId });
  focusTargetRef.current = { sessionId, eventId: focusEventId };
  const handleFocusEventHandled = useCallback((handledSessionId: string, handledEventId: number) => {
    const current = focusTargetRef.current;
    if (current.sessionId !== handledSessionId || current.eventId !== handledEventId) return;
    navigation.setParams({ focusEventId: undefined });
  }, [navigation]);
  const storyOpenRequestId = route.params?.storyOpenRequestId ?? null;
  const session = useSessionStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined
  );

  // native title이 제목의 단일 소유자다. 상태 도트는 별도 left action으로 유지한다.
  React.useLayoutEffect(() => {
    if (!sessionId) {
      navigation.setOptions({
        title: '챗',
        headerTitle: () => <RootSectionHeaderTitle section="ChatTab" />,
        headerLeft: undefined,
        headerRight: undefined,
      });
      return;
    }
    const name = getSessionDisplayName(session, sessionId);
    navigation.setOptions({
      title: name,
      headerTitle: undefined,
      headerLeft: () => (
        <View style={styles.headerLeft}>
          <LiquidGlassButton
            iconOnly
            testID="chat-back-button"
            accessibilityLabel="이전 패널로 돌아가기"
            accessibilityHint="채팅을 열기 전에 보던 화면으로 돌아갑니다"
            contentStyle={styles.headerBackAction}
            onPress={() =>
              openPreviousPhonePanel(navigation, panelHistory.getReturnTab())
            }
          >
            <Ionicons
              name="arrow-back"
              color={t.colors.textPrimary}
              size={t.iconSize.navigation}
            />
          </LiquidGlassButton>
          <StatusDot status={session?.status} />
        </View>
      ),
      headerRight: () => (
        <TouchableOpacity
          onPress={() => menus.openSessionMenu({ sessionId })}
          accessibilityRole="button"
          accessibilityLabel="세션 메뉴"
          style={styles.headerMenu}
        >
          <Text style={styles.headerMenuText}>•••</Text>
        </TouchableOpacity>
      ),
    });
  }, [menus.openSessionMenu, navigation, panelHistory, session, sessionId, styles, t]);

  if (!sessionId) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>피드에서 세션을 선택하세요</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="피드로 이동"
            style={styles.emptyAction}
            onPress={() => openPhoneFeed(navigation)}
          >
            <Text style={styles.emptyActionText}>피드로 이동</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="세션 검색"
            style={[styles.emptyAction, styles.emptySecondaryAction]}
            onPress={() => openPhoneSearch(navigation)}
          >
            <Text style={styles.emptySecondaryActionText}>세션 검색</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <ChatBody
        sessionId={sessionId}
        active={isFocused}
        focusEventId={focusEventId}
        storyOpenRequestId={storyOpenRequestId}
        onFocusEventHandled={handleFocusEventHandled}
        onStoryOpenRequestHandled={() =>
          navigation.setParams({ storyOpenRequestId: undefined })
        }
      />
      <SessionSuccessionHost
        api={api}
        request={menus.sessionSuccession}
        onClose={menus.closeSessionSuccession}
        onCreated={(createdSessionId) => navigation.navigate('Chat', {
          sessionId: createdSessionId,
        })}
      />
    </>
  );
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.spacing.xxl,
    },
    emptyIcon: { fontSize: t.iconSize.hero, marginBottom: t.spacing.md },
    emptyTitle: {
      color: c.textPrimary,
      fontSize: t.chatFontSize.screenTitle,
      fontWeight: '600',
      textAlign: 'center',
      marginBottom: t.spacing.lg,
    },
    emptyAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.controlHeight.button,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radius.lg,
      backgroundColor: c.accent,
    },
    emptyActionText: {
      color: c.accentText,
      fontSize: t.chatFontSize.body,
      fontWeight: '700',
    },
    emptySecondaryAction: {
      marginTop: t.spacing.sm,
      backgroundColor: c.secondaryAction,
    },
    emptySecondaryActionText: {
      color: c.secondaryActionText,
      fontSize: t.chatFontSize.body,
      fontWeight: '700',
    },
    headerMenu: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    headerBackAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerMenuText: { color: c.accent, fontSize: t.chatFontSize.body, fontWeight: '700' },
  });
}

import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef } from './src/navigation/navigationRef';
import { initPushNotifications } from './src/services/pushNotifications';
import { useTokens } from './src/theme';
import { UsageWidgetCredentialSync } from './src/widgets/usageWidgetBridge';
import { AppNoticeBanner } from './src/components/AppNoticeBanner';
import { useNavigationViewUsageEvents } from './src/navigation/useNavigationViewUsageEvents';
import { recordStaticNavigationRoute } from './src/lib/session-diagnostics';

/**
 * NavigationContainer에 동적 테마를 주입하기 위한 내부 컴포넌트.
 * useTokens()는 settingsStore.appearance + 시스템 colorScheme을 따라 컬러 팔레트를 반환하므로,
 * 사용자가 외양 모드를 바꾸면 NavigationContainer가 새로운 colors로 다시 그려진다.
 */
function ThemedNavigationRoot() {
  const t = useTokens();
  const c = t.colors;
  const { recordNavigationView, snapshotNavigationView } = useNavigationViewUsageEvents();
  const snapshotAuthenticatedNavigation = React.useCallback(
    () => snapshotNavigationView(navigationRef.getRootState()),
    [snapshotNavigationView],
  );

  return (
    <>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          const state = navigationRef.getRootState();
          recordNavigationView(state, true);
          recordStaticNavigationRoute(state);
        }}
        onStateChange={(state) => {
          recordNavigationView(state, false);
          recordStaticNavigationRoute(state);
        }}
        theme={{
          dark: t.mode === 'dark',
          colors: {
            primary: c.accent,
            background: c.background,
            card: c.surface,
            text: c.textPrimary,
            border: c.border,
            notification: c.error,
          },
          fonts: {
            regular: { fontFamily: 'System', fontWeight: '400' },
            medium: { fontFamily: 'System', fontWeight: '500' },
            bold: { fontFamily: 'System', fontWeight: '700' },
            heavy: { fontFamily: 'System', fontWeight: '800' },
          },
        }}
      >
        <RootNavigator onUiUsageEventsEnabled={snapshotAuthenticatedNavigation} />
      </NavigationContainer>
      <AppNoticeBanner />
      {/* 시스템 상태 바(시계·배터리)도 모드에 맞춘다 — light 모드에선 검정 글자, dark 모드에선 흰 글자. */}
      <StatusBar style={t.mode === 'dark' ? 'light' : 'dark'} />
    </>
  );
}

export default function App() {
  // 빌드 20: 푸시 알림 핸들러를 1회 등록 (포그라운드에서도 배너 표시).
  // 모듈 최상단 side effect 대신 useEffect로 감싸 RN module cache 안전성 확보.
  useEffect(() => {
    initPushNotifications();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <UsageWidgetCredentialSync />
        <ThemedNavigationRoot />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  View,
  ActivityIndicator,
  ImageBackground,
  StyleSheet,
  AppState,
  Linking,
  type AppStateStatus,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { createApiClient } from '../api/client';
import { SettingsScreen } from '../screens/SettingsScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { navigationRef } from './navigationRef';
import {
  ensurePushRegistered,
  deregisterFromServer,
} from '../services/pushNotifications';
import { useTokens } from '../theme';
import { useDeviceType } from '../theme/useDeviceType';
import { openNotificationSession } from './notificationSessionRoute';
import {
  hasUIStoreHydrationFailed,
  subscribeUIStoreHydrationFailure,
  useUIStore,
} from '../store/uiStore';
import { resolveBackgroundImageSource } from '../lib/wallpaper-source';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../lib/auth-scope';
import { AuthenticatedAppSubtree } from './AuthenticatedAppSubtree';
import { useUsageWidgetDeepLink } from '../widgets/usageWidgetDeepLink';
import { recordUiUsageEvent } from '../lib/ui-usage-events';
import {
  cancelPlannerSessionWorkspaceOpen,
  openPlannerSessionWorkspace,
} from '../lib/planner-folder-workspace';
import {
  cancelPhoneSearchSessionOpen,
  openPhoneSearchSessionFromRoot,
  type PhoneRootNavigation,
} from './phoneSessionNavigation';
import { parseSessionSearchIntentUrl, type SessionSearchIntent } from './sessionSearchIntent';

type PendingSessionSearchIntent = {
  readonly id: number;
  readonly intent: SessionSearchIntent;
};

/**
 * 앱 진입점 내비게이터.
 *
 * serverUrl 없음                     → SettingsScreen
 * serverUrl 있음 + authEnabled       → LoginScreen (PKCE OAuth, jwt 없음)
 * serverUrl 있음 + jwt 저장됨        → TabNavigator
 *
 * authDone은 로컬 state가 아닌 `useAuthStore`의 jwt 파생 값으로 관리한다.
 * 현재 인증 scope의 401은 transient authRejected도 세워 설정 조회 결과와 무관하게
 * LoginScreen으로 복귀한다. 이 신호는 JWT와 함께 영속하지 않는다.
 *
 * OAuth 진행: LoginScreen이 expo-auth-session(SFSafariViewController)으로 Google
 * id_token을 받아 백엔드 `/api/auth/google/native`에 POST → JWT를 받아 authStore에 저장.
 * 저장 직후 jwt 파생이 true가 되어 이 컴포넌트가 TabNavigator로 자동 전환한다.
 */
export function RootNavigator({
  onUiUsageEventsEnabled,
}: {
  onUiUsageEventsEnabled?: () => void;
}) {
  const tokens = useTokens();
  const device = useDeviceType();
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const applyUserPreferences = useSettingsStore((s) => s.applyUserPreferences);
  const completedSessionSearchIntentId = useUIStore(
    (s) => s.completedSessionSearchIntentId,
  );
  const jwt = useAuthStore((s) => s.jwt);
  const authRejected = useAuthStore((s) => s.authRejected);
  const authScopeGeneration = useAuthScopeGeneration();
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [pendingSessionIntent, setPendingSessionIntent] =
    useState<PendingSessionSearchIntent | null>(null);
  const [sessionIntentNavigationCheck, setSessionIntentNavigationCheck] = useState(0);
  const [sessionIntentRetryGeneration, setSessionIntentRetryGeneration] = useState(0);
  const [uiStoreHydrated, setUiStoreHydrated] = useState(
    () => useUIStore.persist.hasHydrated() || hasUIStoreHydrationFailed(),
  );
  const nextSessionIntentId = useRef(0);

  // 빌드 20: 푸시 토큰 등록·해제 추적용. serverUrl이 바뀌면 이전 URL을 deregister.
  const prevServerRef = useRef<string | null>(null);

  const authDone = !!jwt;
  const usageDestinationReady = Boolean(
    serverUrl && authChecked && (authDone || (!authRequired && !authRejected)),
  );
  useUsageWidgetDeepLink(device, usageDestinationReady);

  useEffect(() => {
    const refresh = () => setUiStoreHydrated(
      useUIStore.persist.hasHydrated() || hasUIStoreHydrationFailed(),
    );
    const unsubscribeStart = useUIStore.persist.onHydrate(refresh);
    const unsubscribeFinish = useUIStore.persist.onFinishHydration(refresh);
    const unsubscribeFailure = subscribeUIStoreHydrationFailure(refresh);
    refresh();
    return () => {
      unsubscribeStart();
      unsubscribeFinish();
      unsubscribeFailure();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const urlEventReceived = { current: false };
    const receive = (value: string | null, source: 'initial' | 'event') => {
      if (!value) return;
      const parsed = parseSessionSearchIntentUrl(value);
      if (source === 'event' && parsed) urlEventReceived.current = true;
      if (!parsed) return;
      const id = ++nextSessionIntentId.current;
      cancelPhoneSearchSessionOpen();
      cancelPlannerSessionWorkspaceOpen();
      useUIStore.getState().setSessionSearchIntentId(null);
      if (parsed.kind === 'invalid') {
        setPendingSessionIntent(null);
        Alert.alert(
          '세션 링크를 열 수 없습니다',
          parsed.reason === 'invalid_event'
            ? '이벤트 번호가 잘못되었습니다.'
            : '세션 번호가 비어 있습니다.',
        );
        return;
      }
      setPendingSessionIntent({
        id,
        intent: parsed.intent,
      });
    };
    void Linking.getInitialURL().then((value) => {
      if (active && !urlEventReceived.current) receive(value, 'initial');
    });
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url, 'event'));
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!pendingSessionIntent || completedSessionSearchIntentId !== pendingSessionIntent.id) {
      return;
    }
    useUIStore.getState().clearSessionSearchIntent(pendingSessionIntent.id);
    setPendingSessionIntent((current) =>
      current?.id === pendingSessionIntent.id ? null : current,
    );
  }, [completedSessionSearchIntentId, pendingSessionIntent]);

  useEffect(() => {
    if (!pendingSessionIntent || !usageDestinationReady) return;
    if (completedSessionSearchIntentId === pendingSessionIntent.id) return;
    if (!navigationRef.isReady()) {
      const timer = setTimeout(
        () => setSessionIntentNavigationCheck((value) => value + 1),
        100,
      );
      return () => clearTimeout(timer);
    }
    if (device !== 'phone' && !uiStoreHydrated) return;

    let active = true;
    const { id, intent } = pendingSessionIntent;
    const offerPhoneIntentRetry = () => {
      if (!active || nextSessionIntentId.current !== id) return;
      Alert.alert(
        '폴더 연결을 확인하지 못했습니다',
        '세션을 열지 못했습니다. 잠시 후 다시 시도할 수 있습니다.',
        [
          { text: '닫기', style: 'cancel' },
          {
            text: '다시 시도',
            onPress: () => {
              if (nextSessionIntentId.current === id) {
                setSessionIntentRetryGeneration((current) => current + 1);
              }
            },
          },
        ],
      );
    };
    const open = device === 'phone'
      ? openPhoneSearchSessionFromRoot(
          navigationRef as unknown as PhoneRootNavigation,
          intent.sessionId,
          intent.eventId,
          offerPhoneIntentRetry,
        )
      : openPlannerSessionWorkspace(
          intent.sessionId,
          intent.eventId,
          undefined,
          'search',
          id,
        );
    void open.then((opened) => {
      if (!active || !opened) return;
      setPendingSessionIntent((current) => current?.id === id ? null : current);
    });
    return () => {
      active = false;
    };
  }, [
    authScopeGeneration,
    completedSessionSearchIntentId,
    device,
    pendingSessionIntent,
    sessionIntentRetryGeneration,
    sessionIntentNavigationCheck,
    uiStoreHydrated,
    usageDestinationReady,
  ]);

  useEffect(() => {
    useUIStore.getState().refreshTodayDate();
    let wasBackgrounded = false;
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        wasBackgrounded = true;
        return;
      }
      if (next === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        useUIStore.getState().refreshTodayDate();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!serverUrl || !jwt) return;
    let cancelled = false;
    const scope = captureAuthScope();
    createApiClient(serverUrl, { authScope: scope })
      .getUserPreferences()
      .then((response) => {
        if (!cancelled && isAuthScopeCurrent(scope)) {
          applyUserPreferences(response.preferences);
        }
      })
      .catch(() => {
        // Offline and single-node fallback: AsyncStorage settings remain active.
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, jwt, authScopeGeneration, applyUserPreferences]);

  // 빌드 20: 푸시 알림 탭 핸들러 — phone(navigation params)/tablet(uiStore) 양쪽 처리.
  // 레이아웃 모드가 바뀌면 현재 모드에 맞는 listener로 교체한다.
  useEffect(() => {
    const scope = captureAuthScope();
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (!isAuthScopeCurrent(scope)) return;
        const data = response.notification.request.content.data as
          | { sessionId?: string }
          | undefined;
        const sid = data?.sessionId;
        if (!sid) return;
        const navigated = device !== 'phone' || navigationRef.isReady();
        recordUiUsageEvent({
          type: 'notification_open',
          target: { kind: 'session', id: sid },
          entry: 'notification',
          attrs: { surface: 'push', navigated },
        });
        openNotificationSession(device, sid, (sessionId) => {
          // phone TabNavigator — navigationRef로 ChatTab 진입.
          // React Navigation의 nested navigator + 외부 ref navigate는 타입 시스템이
          // 직접 표현 못 하는 known limitation이라 any 캐스트 사용 (런타임은 정상).
          if (navigationRef.isReady()) {
            (navigationRef as any).navigate('ChatTab', {
              screen: 'Chat',
              params: { sessionId, usageEntry: 'notification' },
            });
          }
        });
      },
    );
    return () => sub.remove();
  }, [authScopeGeneration, device]);

  // 빌드 20: jwt + serverUrl이 모두 갖춰지면 푸시 토큰 register.
  // serverUrl이 바뀌었으면 이전 서버에서 명시 deregister 후 새 서버에 register
  // (stale token 방지 — settings.serverUrl이 갱신된 후엔 이전 URL을 알 수 없으므로).
  useEffect(() => {
    if (!jwt || !serverUrl) return;
    const prev = prevServerRef.current;
    (async () => {
      if (prev && prev !== serverUrl) {
        await deregisterFromServer(prev);
      }
      await ensurePushRegistered();
      prevServerRef.current = serverUrl;
    })();
  }, [jwt, serverUrl]);

  useEffect(() => {
    if (!serverUrl) {
      setAuthChecked(false);
      setAuthRequired(false);
      return;
    }
    let cancelled = false;
    setAuthChecked(false);
    setAuthRequired(false);

    createApiClient(serverUrl)
      .getAuthConfig()
      .then(({ authEnabled }) => {
        if (cancelled) return;
        setAuthRequired(authEnabled);
        setAuthChecked(true);
      })
      .catch(() => {
        // 인증 확인 실패 → 바이패스
        if (cancelled) return;
        setAuthRequired(false);
        setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  // 서버 URL 없음 → 설정 화면
  if (!serverUrl) {
    return (
      <AppWallpaperBackground serverUrl={serverUrl} wallpaper={wallpaper} jwt={jwt}>
        <SettingsScreen showTitle />
      </AppWallpaperBackground>
    );
  }

  // 현재 scope의 401은 auth config가 아직 끝나지 않았거나 실패해도 로그인 복귀를 고정한다.
  if (authRejected && !authDone) {
    return (
      <AppWallpaperBackground serverUrl={serverUrl} wallpaper={wallpaper} jwt={jwt}>
        <LoginScreen />
      </AppWallpaperBackground>
    );
  }

  // 인증 확인 중
  if (!authChecked) {
    return (
      <AppWallpaperBackground serverUrl={serverUrl} wallpaper={wallpaper} jwt={jwt}>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <ActivityIndicator color={tokens.colors.accent} />
        </View>
      </AppWallpaperBackground>
    );
  }

  // 인증 필요 + 아직 완료 안 됨 → PKCE 로그인 화면
  if (authRequired && !authDone) {
    return (
      <AppWallpaperBackground serverUrl={serverUrl} wallpaper={wallpaper} jwt={jwt}>
        <LoginScreen />
      </AppWallpaperBackground>
    );
  }

  return (
    <AppWallpaperBackground serverUrl={serverUrl} wallpaper={wallpaper} jwt={jwt}>
      <AuthenticatedAppSubtree
        generation={authScopeGeneration}
        device={device}
        onUiUsageEventsEnabled={onUiUsageEventsEnabled}
      />
    </AppWallpaperBackground>
  );
}

function AppWallpaperBackground({
  serverUrl,
  wallpaper,
  jwt,
  children,
}: {
  serverUrl: string;
  wallpaper: { mode: string; customImage?: string };
  jwt: string | null;
  children: ReactNode;
}) {
  const tokens = useTokens();
  const source = resolveBackgroundImageSource(
    serverUrl,
    wallpaper.customImage,
    jwt,
  );
  const backgroundColor = resolveWallpaperColor(wallpaper.mode, tokens);
  if (wallpaper.mode === 'photo' && source) {
    return (
      <ImageBackground
        source={source}
        resizeMode="cover"
        style={[styles.wallpaperRoot, { backgroundColor }]}
        imageStyle={styles.wallpaperImage}
      >
        {children}
      </ImageBackground>
    );
  }
  return <View style={[styles.wallpaperRoot, { backgroundColor }]}>{children}</View>;
}

function resolveWallpaperColor(
  mode: string,
  tokens: ReturnType<typeof useTokens>,
): string {
  if (mode === 'metal') {
    return tokens.mode === 'light' ? '#eef2f7' : '#111827';
  }
  if (mode === 'bokeh') {
    return tokens.mode === 'light' ? '#f6f8ff' : '#101522';
  }
  return tokens.colors.background;
}

const styles = StyleSheet.create({
  wallpaperRoot: {
    flex: 1,
  },
  wallpaperImage: {
    opacity: 0.42,
  },
});

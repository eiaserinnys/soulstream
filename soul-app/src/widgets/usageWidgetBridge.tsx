import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { measureDiagnosticOperation } from '../lib/session-diagnostics-api';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';

export const USAGE_WIDGET_APP_GROUP = 'group.me.eiaserinnys.soulstream';
export const USAGE_WIDGET_KIND = 'UsageWidget';
export const USAGE_WIDGET_SERVER_URL_KEY = 'usageWidget.serverURL';
export const USAGE_WIDGET_AUTH_TOKEN_KEY = 'usageWidget.authToken';
export const USAGE_WIDGET_LAST_SYNC_AT_KEY = 'usageWidget.lastSyncAt';

interface ExtensionStorageNativeModule {
  setString: (key: string, value: string, appGroup: string) => void;
  remove: (key: string, appGroup: string) => void;
  get: (key: string, appGroup: string) => string | null | undefined;
  reloadWidget: (kind: string) => void;
}

export interface UsageWidgetBridgeDiagnostics {
  hydrated: boolean;
  nativeModuleAvailable: boolean;
  serverURLRecorded: boolean;
  authTokenRecorded: boolean;
  lastSyncAt: string | null;
  error: string | null;
}

type UsageWidgetBridgeStore = UsageWidgetBridgeDiagnostics & {
  reset: () => void;
};

const initialDiagnostics: UsageWidgetBridgeDiagnostics = {
  hydrated: false,
  nativeModuleAvailable: false,
  serverURLRecorded: false,
  authTokenRecorded: false,
  lastSyncAt: null,
  error: null,
};

export const useUsageWidgetBridgeDiagnostics = create<UsageWidgetBridgeStore>()(
  (set) => ({
    ...initialDiagnostics,
    reset: () => set(initialDiagnostics),
  }),
);

function resolveNativeModule(): ExtensionStorageNativeModule | null {
  if (Platform.OS !== 'ios') return null;
  return requireOptionalNativeModule<ExtensionStorageNativeModule>('ExtensionStorage');
}

function hasStoredValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function warnBridge(message: string) {
  if (__DEV__) console.warn(`[UsageWidgetBridge] ${message}`);
}

export function syncUsageWidgetCredentials({
  serverUrl,
  jwt,
  now = new Date(),
}: {
  serverUrl: string;
  jwt: string | null;
  now?: Date;
}): Omit<UsageWidgetBridgeDiagnostics, 'hydrated'> {
  const nativeModule = resolveNativeModule();
  if (!nativeModule) {
    const error = 'ExtensionStorage 네이티브 모듈을 찾지 못했습니다.';
    warnBridge(error);
    return {
      nativeModuleAvailable: false,
      serverURLRecorded: false,
      authTokenRecorded: false,
      lastSyncAt: null,
      error,
    };
  }

  const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, '');
  const normalizedToken = jwt?.trim() ?? '';
  const lastSyncAt = now.toISOString();

  try {
    if (normalizedServerUrl) {
      nativeModule.setString(
        USAGE_WIDGET_SERVER_URL_KEY,
        normalizedServerUrl,
        USAGE_WIDGET_APP_GROUP,
      );
    } else {
      nativeModule.remove(USAGE_WIDGET_SERVER_URL_KEY, USAGE_WIDGET_APP_GROUP);
    }
    if (normalizedToken) {
      nativeModule.setString(
        USAGE_WIDGET_AUTH_TOKEN_KEY,
        normalizedToken,
        USAGE_WIDGET_APP_GROUP,
      );
    } else {
      nativeModule.remove(USAGE_WIDGET_AUTH_TOKEN_KEY, USAGE_WIDGET_APP_GROUP);
    }
    nativeModule.setString(
      USAGE_WIDGET_LAST_SYNC_AT_KEY,
      lastSyncAt,
      USAGE_WIDGET_APP_GROUP,
    );
    nativeModule.reloadWidget(USAGE_WIDGET_KIND);

    const serverURLRecorded = hasStoredValue(
      nativeModule.get(USAGE_WIDGET_SERVER_URL_KEY, USAGE_WIDGET_APP_GROUP),
    );
    const authTokenRecorded = hasStoredValue(
      nativeModule.get(USAGE_WIDGET_AUTH_TOKEN_KEY, USAGE_WIDGET_APP_GROUP),
    );
    const storedLastSyncAt = nativeModule.get(
      USAGE_WIDGET_LAST_SYNC_AT_KEY,
      USAGE_WIDGET_APP_GROUP,
    ) ?? null;
    const writeVerified = serverURLRecorded === Boolean(normalizedServerUrl)
      && authTokenRecorded === Boolean(normalizedToken)
      && storedLastSyncAt === lastSyncAt;
    const error = writeVerified ? null : 'App Group 기록을 다시 읽어 확인하지 못했습니다.';
    if (error) warnBridge(error);

    return {
      nativeModuleAvailable: true,
      serverURLRecorded,
      authTokenRecorded,
      lastSyncAt: storedLastSyncAt,
      error,
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'App Group 기록에 실패했습니다.';
    warnBridge(error);
    return {
      nativeModuleAvailable: true,
      serverURLRecorded: false,
      authTokenRecorded: false,
      lastSyncAt: null,
      error,
    };
  }
}

/**
 * SecureStore와 AsyncStorage hydration 뒤 현재 값을 App Group에 반영한다.
 * 로그인·토큰 회전·서버 변경뿐 아니라 실제 background 복귀에도 같은 경로를 재실행한다.
 */
export function UsageWidgetCredentialSync() {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const [hydrated, setHydrated] = useState(
    () => useAuthStore.persist.hasHydrated() && useSettingsStore.persist.hasHydrated(),
  );

  useEffect(() => {
    const refreshHydration = () => {
      const nextHydrated = useAuthStore.persist.hasHydrated()
        && useSettingsStore.persist.hasHydrated();
      setHydrated(nextHydrated);
      useUsageWidgetBridgeDiagnostics.setState({ hydrated: nextHydrated });
    };
    const unsubscribeAuth = useAuthStore.persist.onFinishHydration(refreshHydration);
    const unsubscribeSettings = useSettingsStore.persist.onFinishHydration(refreshHydration);
    refreshHydration();
    return () => {
      unsubscribeAuth();
      unsubscribeSettings();
    };
  }, []);

  const synchronize = useCallback(() => {
    if (!hydrated) return;
    const result = measureDiagnosticOperation(
      'usage_widget',
      30,
      () => syncUsageWidgetCredentials({ serverUrl, jwt }),
    );
    useUsageWidgetBridgeDiagnostics.setState({ hydrated: true, ...result });
  }, [hydrated, jwt, serverUrl]);

  useEffect(() => {
    synchronize();
  }, [synchronize]);

  useEffect(() => {
    let wasBackgrounded = AppState.currentState !== 'active';
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        wasBackgrounded = true;
        return;
      }
      if (nextState === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        synchronize();
      }
    });
    return () => subscription.remove();
  }, [synchronize]);

  return null;
}

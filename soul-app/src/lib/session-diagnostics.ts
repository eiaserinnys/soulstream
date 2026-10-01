import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import {
  dispatchEasObserveEvents,
  logEasObserveEvent,
} from './install-eas-observe-crash-reporting';
import {
  bindSessionDiagnosticsSink,
  recordStoreUpdateCount,
} from './session-diagnostics-api';
import type { DiagnosticSource } from './session-diagnostics-core';
import { NativeSessionDiagnostics } from '../../modules/soul-app-session-diagnostics/src';
import { useAppNoticeStore } from '../store/appNoticeStore';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useClaudeRuntimeListLifecycleStore } from '../store/claudeRuntimeListLifecycleStore';
import { useNodeConnectivityStore } from '../store/nodeConnectivityStore';
import { usePlannerStore } from '../store/plannerStore';
import { useSearchStore } from '../store/searchStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { useUsageWidgetBridgeDiagnostics } from '../widgets/usageWidgetBridge';
import {
  SessionDiagnosticsRuntime,
  type DiagnosticsAppState,
  type FrameRateSnapshot,
} from './session-diagnostics-runtime';

let runtime: SessionDiagnosticsRuntime | null = null;
let startupCalled = false;
let lastRouteSource: DiagnosticSource | null = null;

export function startSessionDiagnostics(): void {
  if (startupCalled || Platform.OS !== 'ios') return;
  startupCalled = true;

  runtime = new SessionDiagnosticsRuntime({
    storage: AsyncStorage,
    native: NativeSessionDiagnostics,
    observe: {
      logEvent: logEasObserveEvent,
      dispatchEvents: dispatchEasObserveEvents,
    },
    appVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? 'unknown',
    // The Expo config's ios.buildNumber can remain the checked-in seed when
    // EAS remote versioning is enabled. Constants.platform.ios.buildNumber is
    // read from this installed binary's CFBundleVersion.
    buildNumber: Constants.platform?.ios?.buildNumber
      ?? Constants.expoConfig?.ios?.buildNumber
      ?? 'unknown',
    createId: () => Crypto.randomUUID().toLowerCase(),
    getFrameRateMetrics: readFrameRateMetrics,
    getSessionCounts: readSessionCounts,
  });

  bindSessionDiagnosticsSink(runtime);
  subscribeToStores();
  runtime.setAppState(toDiagnosticsAppState(AppState.currentState));
  AppState.addEventListener('change', (next: AppStateStatus) => {
    runtime?.setAppState(toDiagnosticsAppState(next));
  });

  void runtime.initialize().then(() => {
    const enabled = process.env.EXPO_PUBLIC_SESSION_DIAGNOSTICS_VERIFY === '1';
    void runtime?.recordInternalVerification(enabled);
  }).catch(() => {
    // Diagnostic setup is optional and cannot interrupt the app entry path.
  });
}

export function recordStaticNavigationRoute(state: unknown): void {
  const routeName = activeRouteName(state);
  const source = classifyRoute(routeName);
  if (source === lastRouteSource) return;
  lastRouteSource = source;
  runtime?.recordRoute(source);
}

function subscribeToStores(): void {
  useSessionStore.subscribe(() => recordStoreUpdateCount('session'));
  useChatStore.subscribe(() => recordStoreUpdateCount('chat'));
  useAuthStore.subscribe(() => recordStoreUpdateCount('auth'));
  useSettingsStore.subscribe(() => recordStoreUpdateCount('settings'));
  useUIStore.subscribe(() => recordStoreUpdateCount('ui'));
  usePlannerStore.subscribe(() => recordStoreUpdateCount('planner_store'));
  useNodeConnectivityStore.subscribe(() => recordStoreUpdateCount('nodes'));
  useSearchStore.subscribe(() => recordStoreUpdateCount('search'));
  useAppNoticeStore.subscribe(() => recordStoreUpdateCount('other'));
  useClaudeRuntimeListLifecycleStore.subscribe(() => recordStoreUpdateCount('other'));
  useUsageWidgetBridgeDiagnostics.subscribe(() => recordStoreUpdateCount('usage_widget'));
}

function readSessionCounts(): { feedCount: number; runningCount: number } {
  const state = useSessionStore.getState();
  return {
    feedCount: state.feedSessionIds.length,
    runningCount: Object.values(state.sessions).filter((session) => session.status === 'running').length,
  };
}

async function readFrameRateMetrics(): Promise<FrameRateSnapshot> {
  const observe = require('expo-observe') as {
    AppMetrics?: {
      getFrameRateMetricsAsync?: () => Promise<FrameRateSnapshot>;
    };
  };
  const read = observe.AppMetrics?.getFrameRateMetricsAsync;
  if (typeof read !== 'function') throw new Error('Frame metrics API is unavailable');
  return read.call(observe.AppMetrics);
}

function activeRouteName(state: unknown): string {
  let cursor: unknown = state;
  let routeName = '';
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isRecord(cursor) || !Array.isArray(cursor.routes)) break;
    const index = typeof cursor.index === 'number' ? cursor.index : cursor.routes.length - 1;
    const route = cursor.routes[index];
    if (!isRecord(route)) break;
    routeName = typeof route.name === 'string' ? route.name : routeName;
    cursor = route.state;
  }
  return routeName;
}

function classifyRoute(name: string): DiagnosticSource {
  const route = name.toLowerCase();
  if (route.includes('chat')) return 'chat';
  if (route.includes('search')) return 'search';
  if (route.includes('planner') || route.includes('task')) return 'planner';
  if (route.includes('setting')) return 'settings';
  if (route.includes('session') || route.includes('folder') || route.includes('feed')) return 'feed';
  return 'other';
}

function toDiagnosticsAppState(state: AppStateStatus): DiagnosticsAppState {
  if (state === 'active' || state === 'inactive' || state === 'background') return state;
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

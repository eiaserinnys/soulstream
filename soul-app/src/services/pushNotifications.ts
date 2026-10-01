import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';

/**
 * Expo Push 알림 통합.
 *
 * - 디바이스 1개당 token 1개를 획득하여 settings.serverUrl에 register.
 * - serverUrl 변경 시 RootNavigator가 이전 URL을 deregisterFromServer에 명시 전달.
 * - 멀티 오케스트레이터 지원: 사용자가 본 적 있는 모든 serverUrl을 추적하여,
 *   token 회전 시 모든 등록 서버에 다시 register.
 * - iOS 시뮬레이터·권한 거부·register 실패 모두 silent skip (앱 정상 동작).
 */

const DEVICE_ID_KEY = 'push.deviceId';
const TOKEN_KEY = 'push.expoToken';
// 본 디바이스가 register한 적 있는 serverUrl 목록 (string[]). 토큰 회전 시 모두에 재등록.
const REGISTERED_SERVERS_KEY = 'push.registeredServers';

/**
 * 알림 핸들러 등록. App.tsx에서 1회 호출 (모듈 최상단 side effect 회피).
 * 포그라운드에서도 배너·사운드 표시 — Apple 기본은 포그라운드 알림 무음.
 */
export function initPushNotifications(): void {
  Notifications.setNotificationHandler({
    // SDK 53+: shouldShowBanner / shouldShowList가 분리됨. shouldShowAlert는 deprecated.
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function getOrCreateDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    const model = Device.modelName ?? 'ios';
    const rand = Math.random().toString(36).slice(2, 8);
    id = `${model}-${Date.now()}-${rand}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * 권한 요청 + token 획득 + 현재 settings.serverUrl에 register.
 *
 * - Device.isDevice=false (시뮬레이터) → 즉시 return (push 자체 불가)
 * - 권한 거부 → 즉시 return (silent — 사용자에게 안내 안 함, UX 결정)
 * - 서버 register 실패 → console.warn 후 swallow (다음 앱 시작 시 재시도됨)
 */
export async function ensurePushRegistered(): Promise<void> {
  if (!Device.isDevice) return;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let granted = existing === 'granted';
    if (!granted) {
      const { status } = await Notifications.requestPermissionsAsync();
      granted = status === 'granted';
    }
    if (!granted) return;

    // EAS 빌드에서는 Constants.expoConfig?.extra?.eas?.projectId 또는
    // Constants.easConfig?.projectId 둘 중 하나로 들어온다 — 양쪽을 모두 시도.
    const projectId =
      (Constants.expoConfig as any)?.extra?.eas?.projectId ??
      (Constants as any).easConfig?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const newToken = tokenData.data;
    const oldToken = await AsyncStorage.getItem(TOKEN_KEY);
    const tokenChanged = newToken !== oldToken;
    const currentServer = useSettingsStore.getState().serverUrl;
    if (!currentServer) return;

    const registeredJson = await AsyncStorage.getItem(REGISTERED_SERVERS_KEY);
    const registered: string[] = registeredJson ? JSON.parse(registeredJson) : [];
    const needsRegister = tokenChanged || !registered.includes(currentServer);
    if (!needsRegister) return;

    const deviceId = await getOrCreateDeviceId();
    const api = createApiClient(currentServer);
    await api.registerPushToken({ token: newToken, deviceId });

    const nextRegistered = registered.includes(currentServer)
      ? registered
      : [...registered, currentServer];
    const writes: [string, string][] = [];
    if (tokenChanged) writes.push([TOKEN_KEY, newToken]);
    if (nextRegistered !== registered) {
      writes.push([REGISTERED_SERVERS_KEY, JSON.stringify(nextRegistered)]);
    }
    if (writes.length > 0) await AsyncStorage.multiSet(writes);
  } catch (err) {
    // Push는 부가 기능이다. 권한·token·storage·server 중 어느 경계가 실패해도
    // 앱 진입을 막지 않고, 정본 ledger를 앞서 쓰지 않아 다음 호출에서 재시도한다.
    console.warn('[push] registration skipped:', err);
  }
}

/**
 * 특정 serverUrl에서 명시적으로 deregister.
 *
 * RootNavigator가 settings.serverUrl 변경 직전 이전 URL을 인자로 호출.
 * settings.serverUrl이 이미 변경된 후 호출하면 안 됨 (deregisterFromCurrentServer가
 * 아닌 deregisterFromServer를 명시 인자로 받는 이유 — stale token 방지).
 */
export async function deregisterFromServer(serverUrl: string): Promise<void> {
  const deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId || !serverUrl) return;
  try {
    const api = createApiClient(serverUrl);
    await api.deregisterPushToken(deviceId);
  } catch (err) {
    console.warn('[push] deregister failed:', err);
  }
  // 등록 목록에서 제거
  const registeredJson = await AsyncStorage.getItem(REGISTERED_SERVERS_KEY);
  const registered: string[] = registeredJson ? JSON.parse(registeredJson) : [];
  const next = registered.filter((s) => s !== serverUrl);
  await AsyncStorage.setItem(REGISTERED_SERVERS_KEY, JSON.stringify(next));
}

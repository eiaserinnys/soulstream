import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'iPhone' }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'project' } } } },
}));
jest.mock('../../api/client', () => ({ createApiClient: jest.fn() }));

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { createApiClient } from '../../api/client';
import { ensurePushRegistered } from '../pushNotifications';
import { useSettingsStore } from '../../store/settingsStore';

const registerPushToken = jest.fn();

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  Object.defineProperty(Device, 'isDevice', { value: true, configurable: true });
  (createApiClient as jest.Mock).mockReturnValue({ registerPushToken });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'token-a' });
  registerPushToken.mockResolvedValue(undefined);
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
});

test('simulator and denied permission stop before token or server work', async () => {
  Object.defineProperty(Device, 'isDevice', { value: false, configurable: true });
  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();

  Object.defineProperty(Device, 'isDevice', { value: true, configurable: true });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });
  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registerPushToken).not.toHaveBeenCalled();
});

test.each([
  ['permission', () => (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error('permission'))],
  ['token', () => (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValueOnce(new Error('token'))],
] as const)('%s failure is isolated and remains retryable', async (_label, fail) => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  fail();
  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();

  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(registerPushToken).toHaveBeenCalledTimes(1);
});

test('failed registration does not advance token or server ledger and next call retries', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  registerPushToken.mockRejectedValueOnce(new Error('offline'));

  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(await AsyncStorage.getItem('push.expoToken')).toBeNull();
  expect(await AsyncStorage.getItem('push.registeredServers')).toBeNull();

  await expect(ensurePushRegistered()).resolves.toBeUndefined();
  expect(registerPushToken).toHaveBeenCalledTimes(2);
  expect(await AsyncStorage.getItem('push.expoToken')).toBe('token-a');
  expect(JSON.parse((await AsyncStorage.getItem('push.registeredServers'))!))
    .toEqual(['https://soul.test']);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('server registration resolves before token and server ledger advance', async () => {
  let releaseRegistration!: () => void;
  let reportRegistrationStarted!: () => void;
  const registrationStarted = new Promise<void>((resolve) => {
    reportRegistrationStarted = resolve;
  });
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  registerPushToken.mockImplementationOnce(() => {
    reportRegistrationStarted();
    return registrationGate;
  });

  const pending = ensurePushRegistered();
  await registrationStarted;

  expect(await AsyncStorage.getItem('push.expoToken')).toBeNull();
  expect(await AsyncStorage.getItem('push.registeredServers')).toBeNull();

  releaseRegistration();
  await pending;
  expect(await AsyncStorage.getItem('push.expoToken')).toBe('token-a');
  expect(JSON.parse((await AsyncStorage.getItem('push.registeredServers'))!))
    .toEqual(['https://soul.test']);
});

test('already granted permission never opens the OS prompt', async () => {
  await ensurePushRegistered();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(registerPushToken).toHaveBeenCalledTimes(1);
});

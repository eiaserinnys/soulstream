import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../authStore';
import { useSettingsStore } from '../settingsStore';

const tokenFor = (email: string) => {
  const payload = Buffer.from(JSON.stringify({ email, sub: email, name: '사용자', picture: '', exp: 2_000_000_000 })).toString('base64url');
  return `header.${payload}.signature`;
};

beforeEach(async () => {
  await AsyncStorage.removeItem('soul-app-settings');
  useAuthStore.setState({ jwt: tokenFor('first@example.com') });
  useSettingsStore.setState({
    serverUrl: 'https://soul-one.test',
    serverType: 'soul-server',
    nodeId: 'node-one',
    appearance: 'system',
    wallpaper: { mode: 'bokeh' },
    persistentSessionDevicePrefs: {},
  } as never);
});

test('stores device preferences by server and decoded account email', async () => {
  const store = useSettingsStore.getState();
  store.setPersistentSessionOpenOnStart('https://soul-one.test', 'first@example.com', true);
  store.setPersistentSessionLastSessionId('https://soul-one.test', 'first@example.com', 'pas-one');
  store.setPersistentSessionOpenOnStart('https://soul-two.test', 'first@example.com', false);
  store.setPersistentSessionOpenOnStart('https://soul-one.test', 'second@example.com', true);

  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com'))
    .toEqual({ openOnStart: true, lastSessionId: 'pas-one' });
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-two.test', 'first@example.com'))
    .toEqual({ openOnStart: false, lastSessionId: null });
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'second@example.com'))
    .toEqual({ openOnStart: true, lastSessionId: null });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = JSON.parse((await AsyncStorage.getItem('soul-app-settings'))!);
  expect(Object.keys(stored.state.persistentSessionDevicePrefs)).toHaveLength(3);
  expect(JSON.stringify(stored.state)).not.toContain('setPersistentSessionOpenOnStart');
});

test('defaults to closed and keeps device preferences outside server user preferences', async () => {
  const store = useSettingsStore.getState();
  expect(store.getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com'))
    .toEqual({ openOnStart: false, lastSessionId: null });

  store.setPersistentSessionOpenOnStart('https://soul-one.test', 'first@example.com', true);
  const devicePrefs = useSettingsStore.getState().persistentSessionDevicePrefs;
  store.applyUserPreferences({ appearance: 'dark', wallpaper: { mode: 'plain' } });
  expect(useSettingsStore.getState().persistentSessionDevicePrefs).toEqual(
    devicePrefs,
  );
  expect(useSettingsStore.getState().appearance).toBe('dark');
});

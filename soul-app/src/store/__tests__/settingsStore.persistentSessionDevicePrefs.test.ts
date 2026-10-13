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
  store.setPersistentSessionWeeklyUsageNodeSelection('https://soul-one.test', ' FIRST@example.com ',
    { configuredNodeId: 'node-a', selectedNodeId: 'node-b' });
  store.setPersistentSessionOpenOnStart('https://soul-two.test', 'first@example.com', false);
  store.setPersistentSessionOpenOnStart('https://soul-one.test', 'second@example.com', true);

  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com'))
    .toEqual({ openOnStart: true, lastSessionId: 'pas-one', collapsedTaskGroups: ['todo'], showWeeklyUsage: false,
      weeklyUsageNodeSelection: { configuredNodeId: 'node-a', selectedNodeId: 'node-b' } });
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-two.test', 'first@example.com'))
    .toEqual({ openOnStart: false, lastSessionId: null, collapsedTaskGroups: ['todo'], showWeeklyUsage: false, weeklyUsageNodeSelection: null });
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'second@example.com'))
    .toEqual({ openOnStart: true, lastSessionId: null, collapsedTaskGroups: ['todo'], showWeeklyUsage: false, weeklyUsageNodeSelection: null });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = JSON.parse((await AsyncStorage.getItem('soul-app-settings'))!);
  expect(Object.keys(stored.state.persistentSessionDevicePrefs)).toHaveLength(3);
  expect(JSON.stringify(stored.state)).not.toContain('setPersistentSessionOpenOnStart');
});

test('defaults to closed and keeps device preferences outside server user preferences', async () => {
  const store = useSettingsStore.getState();
  expect(store.getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com'))
    .toEqual({ openOnStart: false, lastSessionId: null, collapsedTaskGroups: ['todo'], showWeeklyUsage: false, weeklyUsageNodeSelection: null });

  store.setPersistentSessionOpenOnStart('https://soul-one.test', 'first@example.com', true);
  store.setPersistentSessionShowWeeklyUsage('https://soul-one.test', 'first@example.com', true);
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com').showWeeklyUsage).toBe(true);
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-two.test', 'first@example.com').showWeeklyUsage).toBe(false);
  const devicePrefs = useSettingsStore.getState().persistentSessionDevicePrefs;
  store.applyUserPreferences({ appearance: 'dark', wallpaper: { mode: 'plain' } });
  expect(useSettingsStore.getState().persistentSessionDevicePrefs).toEqual(
    devicePrefs,
  );
  expect(useSettingsStore.getState().appearance).toBe('dark');
});

test('persists weekly node selection, restores it, and reads older device preference objects', async () => {
  const serverUrl = 'https://soul-one.test';
  const email = 'first@example.com';
  const key = JSON.stringify([serverUrl, email]);
  const getPreference = () => useSettingsStore.getState().getPersistentSessionDevicePreference(serverUrl, email);

  useSettingsStore.getState().setPersistentSessionOpenOnStart(serverUrl, email, true);
  useSettingsStore.getState().setPersistentSessionShowWeeklyUsage(serverUrl, email, true);
  useSettingsStore.getState().setPersistentSessionWeeklyUsageNodeSelection(serverUrl, email,
    { configuredNodeId: 'node-a', selectedNodeId: 'node-c' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let stored = JSON.parse((await AsyncStorage.getItem('soul-app-settings'))!);
  expect(stored.state.persistentSessionDevicePrefs[key]).toMatchObject({
    openOnStart: true,
    showWeeklyUsage: true,
    weeklyUsageNodeSelection: { configuredNodeId: 'node-a', selectedNodeId: 'node-c' },
  });

  const persistedValue = await AsyncStorage.getItem('soul-app-settings');
  useSettingsStore.setState({ persistentSessionDevicePrefs: {} });
  await AsyncStorage.setItem('soul-app-settings', persistedValue!);
  await useSettingsStore.persist.rehydrate();
  expect(getPreference().weeklyUsageNodeSelection).toEqual({ configuredNodeId: 'node-a', selectedNodeId: 'node-c' });

  stored = JSON.parse((await AsyncStorage.getItem('soul-app-settings'))!);
  delete stored.state.persistentSessionDevicePrefs[key].weeklyUsageNodeSelection;
  await AsyncStorage.setItem('soul-app-settings', JSON.stringify(stored));
  await useSettingsStore.persist.rehydrate();
  expect(getPreference().weeklyUsageNodeSelection).toBeNull();
  expect(getPreference().showWeeklyUsage).toBe(true);
});

test('persists collapsed task groups by server and account and restores them after rehydration', async () => {
  const getPreference = () => useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul-one.test', 'first@example.com');
  expect(getPreference().collapsedTaskGroups).toEqual(['todo']);

  const store = useSettingsStore.getState() as any;
  store.setPersistentSessionCollapsedTaskGroups('https://soul-one.test', 'first@example.com', ['blocked', 'todo']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = JSON.parse((await AsyncStorage.getItem('soul-app-settings'))!);
  const key = JSON.stringify(['https://soul-one.test', 'first@example.com']);
  expect(stored.state.persistentSessionDevicePrefs[key].collapsedTaskGroups).toEqual(['blocked', 'todo']);

  const persistedValue = await AsyncStorage.getItem('soul-app-settings');
  useSettingsStore.setState({ persistentSessionDevicePrefs: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await AsyncStorage.setItem('soul-app-settings', persistedValue!);
  await useSettingsStore.persist.rehydrate();
  expect(getPreference().collapsedTaskGroups).toEqual(['blocked', 'todo']);
});

import { useSettingsStore } from '../settingsStore';
import AsyncStorage from '@react-native-async-storage/async-storage';

beforeEach(() => {
  useSettingsStore.setState({
    serverUrl: '',
    serverType: 'soul-server',
    nodeId: '',
    appearance: 'system',
    wallpaper: { mode: 'bokeh' },
  });
});

describe('settingsStore user preferences', () => {
  it('preserves separate global and folder completion preferences after storage rehydration', async () => {
    const settings = useSettingsStore.getState();
    expect(settings.cardIncludeCompleted ?? {}).toEqual({});
    settings.setCardIncludeCompleted('global', true);
    settings.setCardIncludeCompleted('folder-1', false);
    // Exercise the same persisted storage that app restart reads.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stored = await AsyncStorage.getItem('soul-app-settings');
    expect(JSON.parse(stored!).state.cardIncludeCompleted).toEqual({ global: true, 'folder-1': false });
    useSettingsStore.setState({ cardIncludeCompleted: {} });
    await AsyncStorage.setItem('soul-app-settings', stored!);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().cardIncludeCompleted).toEqual({ global: true, 'folder-1': false });
  });
  it('applies normalized server appearance and wallpaper snapshots', () => {
    useSettingsStore.getState().applyUserPreferences({
      appearance: 'dark',
      wallpaper: { mode: 'photo', customImage: '/api/user/background?v=1' },
    });

    expect(useSettingsStore.getState().appearance).toBe('dark');
    expect(useSettingsStore.getState().wallpaper).toEqual({
      mode: 'photo',
      customImage: '/api/user/background?v=1',
    });
  });

  it('drops custom image when switching to a non-photo wallpaper mode', () => {
    useSettingsStore.getState().setWallpaper({
      mode: 'photo',
      customImage: 'file:///tmp/bg.jpg',
    });
    useSettingsStore.getState().setWallpaperMode('plain');

    expect(useSettingsStore.getState().wallpaper).toEqual({ mode: 'plain' });

    useSettingsStore.getState().applyUserPreferences({
      appearance: 'light',
      wallpaper: { mode: 'plain' },
    });
    expect(useSettingsStore.getState().wallpaper).toEqual({ mode: 'plain' });
  });
});

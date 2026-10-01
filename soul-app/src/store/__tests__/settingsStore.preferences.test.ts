import { useSettingsStore } from '../settingsStore';

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

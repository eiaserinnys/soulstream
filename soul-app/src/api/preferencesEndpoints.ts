import type { ApiRequestContext } from './clientCore';
import { appendNativeUploadFile, type NativeUploadFile } from './nativeUpload';
import type { WallpaperMode, WallpaperSettings } from '../../../packages/soul-ui/src/lib/wallpaper-settings';
import {
  normalizeAppearance,
  normalizeUserPreferencesResponse,
  type Appearance,
  type UserPreferencesResponse,
} from '../../../packages/soul-ui/src/lib/user-preferences-envelope';

export interface UserPreferencesSnapshot {
  appearance: Appearance;
  wallpaper: WallpaperSettings;
}

const WALLPAPER_MODES = new Set<WallpaperMode>([
  'bokeh',
  'metal',
  'photo',
  'plain',
]);

export const DEFAULT_USER_PREFERENCES: UserPreferencesSnapshot = {
  appearance: 'system',
  wallpaper: { mode: 'bokeh' },
};

export function createPreferencesEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    getUserPreferences: (): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> =>
      authFetch(`${base}/api/user/preferences`)
        .then((r) => readJson<unknown>(r, 'getUserPreferences'))
        .then((value) => normalizeUserPreferencesResponse(value, normalizeUserPreferences)),

    putUserPreferences: (
      preferences: UserPreferencesSnapshot,
      options: { clearBackground?: boolean } = {},
    ): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> =>
      authFetch(`${base}/api/user/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...normalizeUserPreferences(preferences),
          clearBackground: Boolean(options.clearBackground),
        }),
      })
        .then((r) => readJson<unknown>(r, 'putUserPreferences'))
        .then((value) => normalizeUserPreferencesResponse(value, normalizeUserPreferences)),

    uploadUserBackground: (file: NativeUploadFile): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> => {
      const formData = new FormData();
      appendNativeUploadFile(formData, 'file', file);
      return authFetch(`${base}/api/user/background`, {
        method: 'POST',
        body: formData,
      })
        .then((r) => readJson<unknown>(r, 'uploadUserBackground'))
        .then((value) => normalizeUserPreferencesResponse(value, normalizeUserPreferences));
    },

    deleteUserBackground: (): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> =>
      authFetch(`${base}/api/user/background`, { method: 'DELETE' })
        .then((r) => readJson<unknown>(r, 'deleteUserBackground'))
        .then((value) => normalizeUserPreferencesResponse(value, normalizeUserPreferences)),
  };
}

export function normalizeUserPreferences(value: unknown): UserPreferencesSnapshot {
  if (!value || typeof value !== 'object') return DEFAULT_USER_PREFERENCES;
  const source = value as Partial<UserPreferencesSnapshot>;
  return {
    appearance: normalizeAppearance(source.appearance),
    wallpaper: normalizeAppWallpaperSettings(source.wallpaper),
  };
}

export function normalizeAppWallpaperSettings(value: unknown): WallpaperSettings {
  if (!value || typeof value !== 'object') return DEFAULT_USER_PREFERENCES.wallpaper;
  const source = value as Partial<WallpaperSettings>;
  const mode = WALLPAPER_MODES.has(source.mode as WallpaperMode)
    ? (source.mode as WallpaperMode)
    : 'bokeh';
  const customImage =
    typeof source.customImage === 'string' && isAllowedImageUri(source.customImage)
      ? source.customImage
      : undefined;
  return customImage ? { mode, customImage } : { mode };
}

function isAllowedImageUri(value: string): boolean {
  return (
    value.startsWith('/api/user/background') ||
    value.startsWith('/wallpapers/') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value.startsWith('data:image/')
  );
}

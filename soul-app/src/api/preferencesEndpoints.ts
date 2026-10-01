import type { ApiRequestContext } from './clientCore';
import { appendNativeUploadFile, type NativeUploadFile } from './nativeUpload';

export type Appearance = 'system' | 'light' | 'dark';
export type WallpaperMode = 'bokeh' | 'metal' | 'photo' | 'plain';

export interface WallpaperSettings {
  mode: WallpaperMode;
  customImage?: string;
}

export interface UserPreferencesSnapshot {
  appearance: Appearance;
  wallpaper: WallpaperSettings;
}

export interface UserPreferencesResponse extends UserPreferencesSnapshot {
  email: string;
  preferences: UserPreferencesSnapshot;
  hasBackground: boolean;
  backgroundUrl: string | null;
  updatedAt: string | null;
}

const APPEARANCES = new Set<Appearance>(['system', 'light', 'dark']);
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
    getUserPreferences: (): Promise<UserPreferencesResponse> =>
      authFetch(`${base}/api/user/preferences`)
        .then((r) => readJson<unknown>(r, 'getUserPreferences'))
        .then(normalizeUserPreferencesResponse),

    putUserPreferences: (
      preferences: UserPreferencesSnapshot,
      options: { clearBackground?: boolean } = {},
    ): Promise<UserPreferencesResponse> =>
      authFetch(`${base}/api/user/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...normalizeUserPreferences(preferences),
          clearBackground: Boolean(options.clearBackground),
        }),
      })
        .then((r) => readJson<unknown>(r, 'putUserPreferences'))
        .then(normalizeUserPreferencesResponse),

    uploadUserBackground: (file: NativeUploadFile): Promise<UserPreferencesResponse> => {
      const formData = new FormData();
      appendNativeUploadFile(formData, 'file', file);
      return authFetch(`${base}/api/user/background`, {
        method: 'POST',
        body: formData,
      })
        .then((r) => readJson<unknown>(r, 'uploadUserBackground'))
        .then(normalizeUserPreferencesResponse);
    },

    deleteUserBackground: (): Promise<UserPreferencesResponse> =>
      authFetch(`${base}/api/user/background`, { method: 'DELETE' })
        .then((r) => readJson<unknown>(r, 'deleteUserBackground'))
        .then(normalizeUserPreferencesResponse),
  };
}

export function normalizeUserPreferences(value: unknown): UserPreferencesSnapshot {
  if (!value || typeof value !== 'object') return DEFAULT_USER_PREFERENCES;
  const source = value as Partial<UserPreferencesSnapshot>;
  return {
    appearance: APPEARANCES.has(source.appearance as Appearance)
      ? (source.appearance as Appearance)
      : 'system',
    wallpaper: normalizeWallpaperSettings(source.wallpaper),
  };
}

export function normalizeUserPreferencesResponse(value: unknown): UserPreferencesResponse {
  const source =
    value && typeof value === 'object'
      ? (value as Partial<UserPreferencesResponse>)
      : {};
  const preferences = normalizeUserPreferences(source.preferences ?? source);
  return {
    email: typeof source.email === 'string' ? source.email : '',
    preferences,
    appearance: preferences.appearance,
    wallpaper: preferences.wallpaper,
    hasBackground: Boolean(source.hasBackground),
    backgroundUrl:
      typeof source.backgroundUrl === 'string' ? source.backgroundUrl : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

export function normalizeWallpaperSettings(value: unknown): WallpaperSettings {
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
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value.startsWith('data:image/')
  );
}

import {
  DEFAULT_WALLPAPER_SETTINGS,
  normalizeWallpaperSettings,
  type WallpaperSettings,
} from "./wallpaper-settings";
import type { Appearance } from "../hooks/useTheme";

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

export const DEFAULT_USER_PREFERENCES: UserPreferencesSnapshot = {
  appearance: "system",
  wallpaper: DEFAULT_WALLPAPER_SETTINGS,
};

const CACHE_PREFIX = "soul-user-preferences:";
const APPEARANCES = new Set<Appearance>(["system", "light", "dark"]);

export function normalizeUserPreferences(value: unknown): UserPreferencesSnapshot {
  if (!value || typeof value !== "object") return DEFAULT_USER_PREFERENCES;
  const source = value as Partial<UserPreferencesSnapshot>;
  return {
    appearance: APPEARANCES.has(source.appearance as Appearance) ? source.appearance as Appearance : "system",
    wallpaper: normalizeWallpaperSettings(source.wallpaper),
  };
}

export function normalizeUserPreferencesResponse(value: unknown): UserPreferencesResponse {
  const source = value && typeof value === "object" ? value as Partial<UserPreferencesResponse> : {};
  const preferences = normalizeUserPreferences(source.preferences ?? source);
  return {
    email: typeof source.email === "string" ? source.email : "",
    preferences,
    appearance: preferences.appearance,
    wallpaper: preferences.wallpaper,
    hasBackground: Boolean(source.hasBackground),
    backgroundUrl: typeof source.backgroundUrl === "string" ? source.backgroundUrl : null,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

export function readCachedUserPreferences(email: string): UserPreferencesSnapshot | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKey(email));
    return raw ? normalizeUserPreferences(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedUserPreferences(email: string, preferences: UserPreferencesSnapshot): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(cacheKey(email), JSON.stringify(normalizeUserPreferences(preferences)));
  } catch {
    // Locked-down storage should not break dashboard rendering.
  }
}

export async function fetchUserPreferences(): Promise<UserPreferencesResponse> {
  const response = await fetch("/api/user/preferences", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`User preferences fetch failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json());
}

export async function saveUserPreferences(
  preferences: UserPreferencesSnapshot,
  options: { clearBackground?: boolean } = {},
): Promise<UserPreferencesResponse> {
  const response = await fetch("/api/user/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      ...normalizeUserPreferences(preferences),
      clearBackground: Boolean(options.clearBackground),
    }),
  });
  if (!response.ok) throw new Error(`User preferences save failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json());
}

export async function uploadUserBackground(file: Blob): Promise<UserPreferencesResponse> {
  const formData = new FormData();
  formData.append("file", file, file instanceof File ? file.name : "wallpaper.jpg");
  const response = await fetch("/api/user/background", {
    method: "POST",
    credentials: "same-origin",
    body: formData,
  });
  if (!response.ok) throw new Error(`User background upload failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json());
}

export async function deleteUserBackground(): Promise<UserPreferencesResponse> {
  const response = await fetch("/api/user/background", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`User background delete failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json());
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

function cacheKey(email: string): string {
  return `${CACHE_PREFIX}${email.trim().toLowerCase()}`;
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

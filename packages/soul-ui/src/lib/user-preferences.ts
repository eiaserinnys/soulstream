import {
  DEFAULT_WALLPAPER_SETTINGS,
  normalizeWallpaperSettings,
  type WallpaperSettings,
} from "./wallpaper-settings";
import {
  DEFAULT_LIQUID_GLASS_SETTINGS,
  normalizeLiquidGlassSettings,
  type LiquidGlassSettings,
} from "./glass-settings";
import {
  normalizeAppearance,
  normalizeUserPreferencesResponse,
  type Appearance,
  type UserPreferencesResponse,
} from "./user-preferences-envelope";
import {
  DEFAULT_CHAT_FONT_SIZE,
  normalizeChatFontSize,
  type ChatFontSize,
} from "./chat-typography";

export interface UserPreferencesSnapshot {
  language?: "ko" | "en";
  appearance: Appearance;
  wallpaper: WallpaperSettings;
  glass: LiquidGlassSettings;
  chatFontSize: ChatFontSize;
}

export const DEFAULT_USER_PREFERENCES: UserPreferencesSnapshot = {
  appearance: "system",
  wallpaper: DEFAULT_WALLPAPER_SETTINGS,
  glass: DEFAULT_LIQUID_GLASS_SETTINGS,
  chatFontSize: DEFAULT_CHAT_FONT_SIZE,
};

const CACHE_PREFIX = "soul-user-preferences:";

export function normalizeUserPreferences(value: unknown): UserPreferencesSnapshot {
  if (!value || typeof value !== "object") return DEFAULT_USER_PREFERENCES;
  const source = value as Partial<UserPreferencesSnapshot>;
  return {
    ...(source.language === "ko" || source.language === "en" ? { language: source.language } : {}),
    appearance: normalizeAppearance(source.appearance),
    wallpaper: normalizeWallpaperSettings(source.wallpaper),
    glass: normalizeLiquidGlassSettings(source.glass),
    chatFontSize: normalizeChatFontSize(source.chatFontSize),
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

export async function fetchUserPreferences(): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> {
  const response = await fetch("/api/user/preferences", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`User preferences fetch failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json(), normalizeUserPreferences);
}

export async function saveUserPreferences(
  preferences: UserPreferencesSnapshot,
  options: { clearBackground?: boolean } = {},
): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> {
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
  return normalizeUserPreferencesResponse(await response.json(), normalizeUserPreferences);
}

export async function uploadUserBackground(file: Blob): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> {
  const formData = new FormData();
  formData.append("file", file, file instanceof File ? file.name : "wallpaper.jpg");
  const response = await fetch("/api/user/background", {
    method: "POST",
    credentials: "same-origin",
    body: formData,
  });
  if (!response.ok) throw new Error(`User background upload failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json(), normalizeUserPreferences);
}

export async function deleteUserBackground(): Promise<UserPreferencesResponse<UserPreferencesSnapshot>> {
  const response = await fetch("/api/user/background", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`User background delete failed: ${response.status}`);
  return normalizeUserPreferencesResponse(await response.json(), normalizeUserPreferences);
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

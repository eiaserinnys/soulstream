import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  dataUrlToBlob,
  fetchUserPreferences,
  normalizeUserPreferences,
  readCachedUserPreferences,
  saveUserPreferences,
  uploadUserBackground,
  writeCachedUserPreferences,
  type UserPreferencesSnapshot,
} from "../lib/user-preferences";
import {
  normalizeWallpaperSettings,
  type WallpaperSettings,
} from "../lib/wallpaper-settings";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  setAppearancePreference,
  useAppearancePreference,
} from "./useTheme";

export function useUserPreferencesSync(email: string | null | undefined): void {
  const { i18n } = useTranslation();
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const language = i18n.resolvedLanguage === "ko" ? "ko" : "en";
  const accountKey = useMemo(() => normalizeEmail(email), [email]);
  const [appearance] = useAppearancePreference();
  const wallpaper = useDashboardStore((state) => state.wallpaper);
  const liquidGlass = useDashboardStore((state) => state.liquidGlass);
  const chatFontSize = useDashboardStore((state) => state.chatFontSize);
  const setWallpaper = useDashboardStore((state) => state.setWallpaper);
  const setUploadedBackgroundUrl = useDashboardStore((state) => state.setUploadedBackgroundUrl);
  const setLiquidGlass = useDashboardStore((state) => state.setLiquidGlass);
  const setChatFontSize = useDashboardStore((state) => state.setChatFontSize);
  const hydratedAccountRef = useRef<string | null>(null);
  const appliedSnapshotKeyRef = useRef<string | null>(null);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    hydratedAccountRef.current = null;
    appliedSnapshotKeyRef.current = null;
    if (!accountKey) return;

    let cancelled = false;
    const cached = readCachedUserPreferences(accountKey);
    if (cached) {
      applySnapshot(cached, setWallpaper, setLiquidGlass, setChatFontSize, appliedSnapshotKeyRef, i18nRef.current);
      hydratedAccountRef.current = accountKey;
    }

    fetchUserPreferences()
      .then((response) => {
        if (cancelled) return;
        setUploadedBackgroundUrl(response.backgroundUrl);
        applySnapshot(response.preferences, setWallpaper, setLiquidGlass, setChatFontSize, appliedSnapshotKeyRef, i18nRef.current);
        writeCachedUserPreferences(accountKey, response.preferences);
        hydratedAccountRef.current = accountKey;
      })
      .catch(() => {
        if (!cancelled) {
          hydratedAccountRef.current = accountKey;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountKey, setChatFontSize, setLiquidGlass, setUploadedBackgroundUrl, setWallpaper]);

  useEffect(() => {
    if (!accountKey || hydratedAccountRef.current !== accountKey) return;

    const snapshot = normalizeUserPreferences({
      appearance,
      language,
      wallpaper: wallpaperForServer(wallpaper),
      glass: liquidGlass,
      chatFontSize,
    });
    const snapshotKey = stableSnapshotKey(snapshot);
    if (appliedSnapshotKeyRef.current === snapshotKey) return;

    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    const timer = window.setTimeout(() => {
      writeCachedUserPreferences(accountKey, snapshot);
      persistSnapshot(snapshot)
        .then((response) => {
          if (saveSeqRef.current !== saveSeq) return;
          setUploadedBackgroundUrl(response.backgroundUrl);
          applySnapshot(response.preferences, setWallpaper, setLiquidGlass, setChatFontSize, appliedSnapshotKeyRef, i18nRef.current);
          writeCachedUserPreferences(accountKey, response.preferences);
        })
        .catch(() => {
          // Offline fallback: local account cache remains authoritative.
        });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [accountKey, appearance, chatFontSize, language, liquidGlass, wallpaper, setChatFontSize, setLiquidGlass, setUploadedBackgroundUrl, setWallpaper]);
}

async function persistSnapshot(snapshot: UserPreferencesSnapshot) {
  const customImage = snapshot.wallpaper.customImage;
  if (snapshot.wallpaper.mode === "photo" && customImage?.startsWith("data:image/")) {
    const uploaded = await uploadUserBackground(await dataUrlToBlob(customImage));
    return saveUserPreferences({
      appearance: snapshot.appearance,
      language: snapshot.language,
      glass: snapshot.glass,
      chatFontSize: snapshot.chatFontSize,
      wallpaper: uploaded.preferences.wallpaper,
    });
  }

  return saveUserPreferences(snapshot);
}

function applySnapshot(
  snapshot: UserPreferencesSnapshot,
  setWallpaper: (settings: WallpaperSettings) => void,
  setLiquidGlass: (settings: UserPreferencesSnapshot["glass"]) => void,
  setChatFontSize: (fontSize: UserPreferencesSnapshot["chatFontSize"]) => void,
  appliedSnapshotKeyRef: { current: string | null },
  i18n: ReturnType<typeof import("@soulstream/i18n").createI18n>,
) {
  const normalized = normalizeUserPreferences({ ...snapshot, language: snapshot.language ?? (i18n.resolvedLanguage === "ko" ? "ko" : "en") });
  if (snapshot.language && snapshot.language !== i18n.resolvedLanguage) void i18n.changeLanguage(snapshot.language);
  appliedSnapshotKeyRef.current = stableSnapshotKey(normalized);
  setAppearancePreference(normalized.appearance);
  setWallpaper(normalized.wallpaper);
  setLiquidGlass(normalized.glass);
  setChatFontSize(normalized.chatFontSize);
}

function wallpaperForServer(wallpaper: WallpaperSettings): WallpaperSettings {
  const normalized = normalizeWallpaperSettings(wallpaper);
  if (normalized.mode !== "photo") {
    return { mode: normalized.mode };
  }
  return normalized;
}

function stableSnapshotKey(snapshot: UserPreferencesSnapshot): string {
  return JSON.stringify(normalizeUserPreferences(snapshot));
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

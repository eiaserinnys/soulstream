import { useEffect, useMemo, useRef } from "react";
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
  const accountKey = useMemo(() => normalizeEmail(email), [email]);
  const [appearance] = useAppearancePreference();
  const wallpaper = useDashboardStore((state) => state.wallpaper);
  const setWallpaper = useDashboardStore((state) => state.setWallpaper);
  const hydratedAccountRef = useRef<string | null>(null);
  const appliedSnapshotKeyRef = useRef<string | null>(null);
  const hasServerBackgroundRef = useRef(false);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    hydratedAccountRef.current = null;
    appliedSnapshotKeyRef.current = null;
    hasServerBackgroundRef.current = false;
    if (!accountKey) return;

    let cancelled = false;
    const cached = readCachedUserPreferences(accountKey);
    if (cached) {
      applySnapshot(cached, setWallpaper, appliedSnapshotKeyRef);
      hydratedAccountRef.current = accountKey;
    }

    fetchUserPreferences()
      .then((response) => {
        if (cancelled) return;
        hasServerBackgroundRef.current = response.hasBackground;
        applySnapshot(response.preferences, setWallpaper, appliedSnapshotKeyRef);
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
  }, [accountKey, setWallpaper]);

  useEffect(() => {
    if (!accountKey || hydratedAccountRef.current !== accountKey) return;

    const snapshot = normalizeUserPreferences({
      appearance,
      wallpaper: wallpaperForServer(wallpaper),
    });
    const snapshotKey = stableSnapshotKey(snapshot);
    if (appliedSnapshotKeyRef.current === snapshotKey) return;

    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    const timer = window.setTimeout(() => {
      writeCachedUserPreferences(accountKey, snapshot);
      persistSnapshot(snapshot, hasServerBackgroundRef.current)
        .then((response) => {
          if (saveSeqRef.current !== saveSeq) return;
          hasServerBackgroundRef.current = response.hasBackground;
          applySnapshot(response.preferences, setWallpaper, appliedSnapshotKeyRef);
          writeCachedUserPreferences(accountKey, response.preferences);
        })
        .catch(() => {
          // Offline and single-node fallback: local account cache remains authoritative.
        });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [accountKey, appearance, wallpaper, setWallpaper]);
}

async function persistSnapshot(
  snapshot: UserPreferencesSnapshot,
  hasServerBackground: boolean,
) {
  const customImage = snapshot.wallpaper.customImage;
  if (snapshot.wallpaper.mode === "photo" && customImage?.startsWith("data:image/")) {
    const uploaded = await uploadUserBackground(await dataUrlToBlob(customImage));
    return saveUserPreferences({
      appearance: snapshot.appearance,
      wallpaper: uploaded.wallpaper,
    });
  }

  return saveUserPreferences(snapshot, {
    clearBackground: hasServerBackground && snapshot.wallpaper.mode !== "photo",
  });
}

function applySnapshot(
  snapshot: UserPreferencesSnapshot,
  setWallpaper: (settings: WallpaperSettings) => void,
  appliedSnapshotKeyRef: { current: string | null },
) {
  const normalized = normalizeUserPreferences(snapshot);
  appliedSnapshotKeyRef.current = stableSnapshotKey(normalized);
  setAppearancePreference(normalized.appearance);
  setWallpaper(normalized.wallpaper);
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

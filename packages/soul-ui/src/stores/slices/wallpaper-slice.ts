import type { StateCreator } from "zustand";
import {
  fileToWallpaperDataUrl,
  normalizeWallpaperSettings,
  readWallpaperSettings,
  writeWallpaperSettings,
  type WallpaperMode,
  type WallpaperSettings,
} from "../../lib/wallpaper-settings";
import type { DashboardActions, DashboardState } from "../dashboard-store-types";

export type WallpaperSlice = Pick<DashboardState, "wallpaper"> &
  Pick<DashboardActions, "setWallpaper" | "setWallpaperMode" | "setWallpaperCustomImage">;

export const createWallpaperSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  WallpaperSlice
> = (set, get) => ({
  wallpaper: readWallpaperSettings(),

  setWallpaper: (wallpaper: WallpaperSettings) => {
    const next = normalizeWallpaperSettings(wallpaper);
    writeWallpaperSettings(next);
    set({ wallpaper: next });
  },

  setWallpaperMode: (mode: WallpaperMode) => {
    const current = get().wallpaper;
    const next = normalizeWallpaperSettings(
      mode === "photo" ? { ...current, mode } : { mode },
    );
    writeWallpaperSettings(next);
    set({ wallpaper: next });
  },

  setWallpaperCustomImage: async (file: File) => {
    const customImage = await fileToWallpaperDataUrl(file);
    const next = normalizeWallpaperSettings({ mode: "photo", customImage });
    writeWallpaperSettings(next);
    set({ wallpaper: next });
  },
});

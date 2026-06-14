export const WALLPAPER_STORAGE_KEY = "soul-wallpaper";
export const MAX_WALLPAPER_DATA_URL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WALLPAPER_PHOTO_URL =
  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=70&auto=format";

export type WallpaperMode = "bokeh" | "metal" | "photo" | "plain";

export interface WallpaperSettings {
  mode: WallpaperMode;
  customImage?: string;
}

const WALLPAPER_MODES = new Set<WallpaperMode>(["bokeh", "metal", "photo", "plain"]);

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = { mode: "bokeh" };

export function normalizeWallpaperSettings(value: unknown): WallpaperSettings {
  if (!value || typeof value !== "object") return DEFAULT_WALLPAPER_SETTINGS;
  const source = value as Partial<WallpaperSettings>;
  const mode = WALLPAPER_MODES.has(source.mode as WallpaperMode)
    ? source.mode as WallpaperMode
    : "bokeh";
  const customImage = typeof source.customImage === "string" && isAllowedWallpaperImage(source.customImage)
    ? source.customImage
    : undefined;
  return customImage ? { mode, customImage } : { mode };
}

function isAllowedWallpaperImage(value: string): boolean {
  return (
    value.startsWith("data:image/")
    || value.startsWith("/api/user/background")
    || value.startsWith("https://")
    || value.startsWith("http://")
  );
}

export function readWallpaperSettings(storage: Storage | undefined = getLocalStorage()): WallpaperSettings {
  if (!storage) return DEFAULT_WALLPAPER_SETTINGS;
  try {
    const raw = storage.getItem(WALLPAPER_STORAGE_KEY);
    return raw ? normalizeWallpaperSettings(JSON.parse(raw)) : DEFAULT_WALLPAPER_SETTINGS;
  } catch {
    return DEFAULT_WALLPAPER_SETTINGS;
  }
}

export function writeWallpaperSettings(
  settings: WallpaperSettings,
  storage: Storage | undefined = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WALLPAPER_STORAGE_KEY, JSON.stringify(normalizeWallpaperSettings(settings)));
  } catch {
    // Locked-down storage should not break dashboard rendering.
  }
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export async function fileToWallpaperDataUrl(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  if (byteLength(dataUrl) <= MAX_WALLPAPER_DATA_URL_BYTES) return dataUrl;
  return resizeWallpaperDataUrl(dataUrl, MAX_WALLPAPER_DATA_URL_BYTES);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read wallpaper image"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Wallpaper image did not produce a data URL"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function resizeWallpaperDataUrl(dataUrl: string, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      let width = image.naturalWidth;
      let height = image.naturalHeight;
      let quality = 0.82;
      let result = dataUrl;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const scale = Math.min(1, Math.sqrt(maxBytes / Math.max(1, byteLength(result))));
        width = Math.max(640, Math.floor(width * scale));
        height = Math.max(360, Math.floor(height * scale));
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas 2D context is unavailable"));
          return;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        result = canvas.toDataURL("image/jpeg", quality);
        if (byteLength(result) <= maxBytes) {
          resolve(result);
          return;
        }
        quality = Math.max(0.55, quality - 0.08);
      }

      resolve(result);
    };
    image.onerror = () => reject(new Error("Failed to decode wallpaper image"));
    image.src = dataUrl;
  });
}

function byteLength(value: string): number {
  return new Blob([value]).size;
}

import type { CSSProperties } from "react";
import {
  DEFAULT_WALLPAPER_PHOTO_URL,
  type WallpaperSettings,
} from "../lib/wallpaper-settings";
import { WALLPAPER_BOKEH_SPOTS } from "../lib/webgl-glass-wallpaper";
import { useDashboardStore } from "../stores/dashboard-store";

const BOKEH_ANIMATION = [
  { d: "46s", del: "0s" },
  { d: "38s", del: "-12s" },
  { d: "52s", del: "-25s" },
  { d: "60s", del: "-8s" },
  { d: "34s", del: "-19s" },
  { d: "44s", del: "-30s" },
];

interface WallpaperLayerProps {
  settings?: WallpaperSettings;
}

export function WallpaperLayer({ settings }: WallpaperLayerProps) {
  const storedSettings = useDashboardStore((state) => state.wallpaper);
  const wallpaper = settings ?? storedSettings;
  const photoUrl = wallpaper.customImage ?? DEFAULT_WALLPAPER_PHOTO_URL;
  const style = { "--wallpaper-photo-url": `url("${photoUrl}")` } as CSSProperties;

  return (
    <div
      aria-hidden="true"
      className="wallpaper-layer"
      data-wallpaper-mode={wallpaper.mode}
      style={style}
    >
      <div className="wallpaper-wall wallpaper-wall-light" />
      <div className="wallpaper-wall wallpaper-wall-dark" />
      <div className="wallpaper-bokeh">
        {WALLPAPER_BOKEH_SPOTS.map((spot, index) => (
          <i
            key={index}
            style={{
              "--x": `${spot.x * 100}%`,
              "--y": `${spot.y * 100}%`,
              "--s": `${spot.size}px`,
              "--d": BOKEH_ANIMATION[index]?.d ?? "44s",
              "--del": BOKEH_ANIMATION[index]?.del ?? "0s",
              "--dx": `${spot.dx}px`,
              "--dy": `${spot.dy}px`,
            } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

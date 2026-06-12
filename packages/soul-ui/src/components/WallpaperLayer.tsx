import type { CSSProperties } from "react";
import {
  DEFAULT_WALLPAPER_PHOTO_URL,
  type WallpaperSettings,
} from "../lib/wallpaper-settings";
import { useDashboardStore } from "../stores/dashboard-store";

const BOKEH_SPOTS = [
  { x: "8%", y: "18%", s: "260px", d: "46s", del: "0s", dx: "140px", dy: "90px" },
  { x: "30%", y: "72%", s: "180px", d: "38s", del: "-12s", dx: "-110px", dy: "70px" },
  { x: "55%", y: "10%", s: "140px", d: "52s", del: "-25s", dx: "90px", dy: "120px" },
  { x: "72%", y: "60%", s: "300px", d: "60s", del: "-8s", dx: "-150px", dy: "-80px" },
  { x: "88%", y: "24%", s: "120px", d: "34s", del: "-19s", dx: "70px", dy: "100px" },
  { x: "45%", y: "88%", s: "200px", d: "44s", del: "-30s", dx: "120px", dy: "-90px" },
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
        {BOKEH_SPOTS.map((spot, index) => (
          <i
            key={index}
            style={{
              "--x": spot.x,
              "--y": spot.y,
              "--s": spot.s,
              "--d": spot.d,
              "--del": spot.del,
              "--dx": spot.dx,
              "--dy": spot.dy,
            } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

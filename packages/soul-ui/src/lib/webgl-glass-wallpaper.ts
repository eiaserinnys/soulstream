import { DEFAULT_WALLPAPER_PHOTO_URL, type WallpaperSettings } from "./wallpaper-settings";

export type WallpaperTheme = "dark" | "light";

export const WALLPAPER_BOKEH_SPOTS = [
  { x: 0.08, y: 0.18, size: 260, dx: 140, dy: 90 },
  { x: 0.30, y: 0.72, size: 180, dx: -110, dy: 70 },
  { x: 0.55, y: 0.10, size: 140, dx: 90, dy: 120 },
  { x: 0.72, y: 0.60, size: 300, dx: -150, dy: -80 },
  { x: 0.88, y: 0.24, size: 120, dx: 70, dy: 100 },
  { x: 0.45, y: 0.88, size: 200, dx: 120, dy: -90 },
] as const;

export interface WallpaperRenderInput {
  width: number;
  height: number;
  settings: WallpaperSettings;
  theme: WallpaperTheme;
  photoImage?: CanvasImageSource | null;
}

export function resolveWallpaperPhotoUrl(settings: WallpaperSettings): string {
  return settings.customImage ?? DEFAULT_WALLPAPER_PHOTO_URL;
}

export function drawDashboardWallpaper(
  context: CanvasRenderingContext2D,
  input: WallpaperRenderInput,
): void {
  const mode = input.settings.mode;
  context.clearRect(0, 0, input.width, input.height);

  if (mode === "photo") {
    drawPhotoWallpaper(context, input);
    return;
  }
  if (mode === "plain") {
    context.fillStyle = input.theme === "dark" ? "#0D0F15" : "#F4F5F8";
    context.fillRect(0, 0, input.width, input.height);
    return;
  }
  if (mode === "metal") {
    drawMetalWallpaper(context, input.width, input.height, input.theme);
    return;
  }

  drawWallWallpaper(context, input.width, input.height, input.theme);
  drawBokeh(context, input.width, input.height, input.theme);
}

export function loadWallpaperPhotoImage(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function drawPhotoWallpaper(
  context: CanvasRenderingContext2D,
  input: WallpaperRenderInput,
): void {
  context.fillStyle = "#0E1014";
  context.fillRect(0, 0, input.width, input.height);
  if (input.photoImage) {
    drawImageCover(context, input.photoImage, input.width, input.height);
  } else {
    drawPhotoFallback(context, input.width, input.height);
  }
  context.fillStyle = "rgba(10, 12, 18, 0.34)";
  context.fillRect(0, 0, input.width, input.height);
}

function drawWallWallpaper(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: WallpaperTheme,
): void {
  const background = context.createLinearGradient(0, 0, 0, height);
  if (theme === "dark") {
    background.addColorStop(0, "#0D0F15");
    background.addColorStop(1, "#0B0D12");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    fillRadialEllipse(context, width * 0.16, -height * 0.18, 1536, 1056, "#1B2334", 0.8);
    fillRadialEllipse(context, width * 0.90, height * 1.14, 1248, 864, "#251F22", 0.76);
    return;
  }

  background.addColorStop(0, "#F4F5F8");
  background.addColorStop(1, "#EEF0F4");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  fillRadialEllipse(context, width * 0.18, -height * 0.16, 1600, 1024, "#DEE6F2", 0.9);
  fillRadialEllipse(context, width * 0.88, height * 1.12, 1280, 896, "#EAE6DE", 0.86);
}

function drawMetalWallpaper(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: WallpaperTheme,
): void {
  const background = context.createLinearGradient(0, 0, 0, height);
  if (theme === "dark") {
    background.addColorStop(0, "#121419");
    background.addColorStop(1, "#0E1014");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    drawMetalLines(context, width, height, ["#15171C", "#101218", "#13151A"]);
    fillRadialEllipse(context, width * 0.5, -height * 0.3, 1920, 1280, "rgba(150, 160, 180, 0.10)", 1);
    return;
  }

  background.addColorStop(0, "#ECEDEF");
  background.addColorStop(1, "#E4E6E9");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  drawMetalLines(context, width, height, ["#E9EAEC", "#E2E4E7", "#E7E8EB"]);
  fillRadialEllipse(context, width * 0.5, -height * 0.3, 1920, 1280, "rgba(255, 255, 255, 0.70)", 1);
}

function drawBokeh(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: WallpaperTheme,
): void {
  const colorA = theme === "dark" ? "rgba(190, 205, 230, 0.16)" : "rgba(255, 255, 255, 0.75)";
  const colorB = theme === "dark" ? "rgba(170, 190, 220, 0.07)" : "rgba(220, 228, 240, 0.35)";

  // Stage 1 mirrors the CSS bokeh layout as a static frame. The DOM layer keeps
  // animating, so the refracted texture can drift slightly until a later stage
  // adds low-frequency texture refresh.
  for (const spot of WALLPAPER_BOKEH_SPOTS) {
    const size = spot.size;
    const cx = width * spot.x + size / 2;
    const cy = height * spot.y + size / 2;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    gradient.addColorStop(0, colorA);
    gradient.addColorStop(0.45, colorB);
    gradient.addColorStop(0.7, "rgba(0, 0, 0, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, size / 2, 0, Math.PI * 2);
    context.fill();
  }
}

function drawPhotoFallback(context: CanvasRenderingContext2D, width: number, height: number): void {
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#243B6B");
  sky.addColorStop(1, "#0E1622");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  fillRadialEllipse(context, width * 0.72, height * 0.28, 420, 420, "#FFE7A8", 0.62);

  for (let row = 0; row < 7; row += 1) {
    const y = height * 0.5 + row * Math.max(28, height * 0.04);
    context.fillStyle = `rgba(${20 + row * 18}, ${40 + row * 14}, ${70 + row * 10}, 0.85)`;
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= width; x += 30) {
      context.lineTo(x, y + Math.sin(x * 0.01 + row) * 30);
    }
    context.lineTo(width, height);
    context.lineTo(0, height);
    context.closePath();
    context.fill();
  }
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
): void {
  const { width: sourceWidth, height: sourceHeight } = getSourceSize(image);
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function getSourceSize(image: CanvasImageSource): { width: number; height: number } {
  if ("naturalWidth" in image) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  if ("videoWidth" in image) {
    return { width: image.videoWidth, height: image.videoHeight };
  }
  if ("displayWidth" in image) {
    return { width: image.displayWidth, height: image.displayHeight };
  }
  const sized = image as { width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
  return {
    width: typeof sized.width === "number" ? sized.width : 0,
    height: typeof sized.height === "number" ? sized.height : 0,
  };
}

function drawMetalLines(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  colors: [string, string, string],
): void {
  for (let x = -height; x < width + height; x += 4) {
    context.fillStyle = colors[0];
    context.fillRect(x, 0, 1, height);
    context.fillStyle = colors[1];
    context.fillRect(x + 1, 0, 2, height);
    context.fillStyle = colors[2];
    context.fillRect(x + 3, 0, 1, height);
  }
}

function fillRadialEllipse(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  color: string,
  alpha: number,
): void {
  context.save();
  context.translate(centerX, centerY);
  context.scale(radiusX / Math.max(radiusY, 1), 1);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusY);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.58, "rgba(0, 0, 0, 0)");
  context.globalAlpha *= alpha;
  context.fillStyle = gradient;
  context.fillRect(-radiusY, -radiusY, radiusY * 2, radiusY * 2);
  context.restore();
}

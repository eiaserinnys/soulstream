import { describe, expect, it } from "vitest";

import {
  MAX_WEBGL_GLASS_CARDS,
  WEBGL_GLASS_STORAGE_KEY,
  calculateBackingDpr,
  clearWebglGlassOverride,
  createGlassSurfaceBuffer,
  isWebglGlassStorageValueDisabled,
  isWebglGlassStorageValueEnabled,
  packVisibleGlassSurfaces,
  readWebglGlassEnabled,
  readWebglGlassOverride,
  writeWebglGlassEnabled,
  type GlassSurfaceRegistration,
} from "./webgl-glass";

describe("webgl glass registry utilities", () => {
  it("keeps the localStorage toggle as a development override over default-on account settings", () => {
    const storage = new MemoryStorage();

    expect(readWebglGlassOverride(storage)).toBeNull();
    expect(readWebglGlassEnabled(storage)).toBe(true);
    expect(isWebglGlassStorageValueEnabled("1")).toBe(true);
    expect(isWebglGlassStorageValueEnabled("true")).toBe(true);
    expect(isWebglGlassStorageValueEnabled("enabled")).toBe(true);
    expect(isWebglGlassStorageValueDisabled("0")).toBe(true);
    expect(isWebglGlassStorageValueDisabled("off")).toBe(true);
    expect(isWebglGlassStorageValueEnabled("0")).toBe(false);

    writeWebglGlassEnabled(true, storage);
    expect(storage.getItem(WEBGL_GLASS_STORAGE_KEY)).toBe("1");
    expect(readWebglGlassOverride(storage)).toBe(true);
    expect(readWebglGlassEnabled(storage)).toBe(true);

    writeWebglGlassEnabled(false, storage);
    expect(storage.getItem(WEBGL_GLASS_STORAGE_KEY)).toBe("0");
    expect(readWebglGlassOverride(storage)).toBe(false);
    expect(readWebglGlassEnabled(storage)).toBe(false);

    clearWebglGlassOverride(storage);
    expect(storage.getItem(WEBGL_GLASS_STORAGE_KEY)).toBeNull();
    expect(readWebglGlassOverride(storage)).toBeNull();
  });

  it("packs visible rects in viewport order and culls offscreen cards", () => {
    const rects = createGlassSurfaceBuffer();
    const registrations = [
      registration(1, rect(12, 20, 260, 132)),
      registration(2, rect(20, -240, 260, 132)),
      registration(3, rect(44, 680, 260, 132)),
      registration(4, rect(900, 40, 260, 132)),
    ];

    const packed = packVisibleGlassSurfaces(
      registrations,
      { width: 800, height: 600, overscan: 40 },
      rects,
    );

    expect(packed.count).toBe(1);
    expect(packed.visibleCount).toBe(1);
    expect(packed.overflowCount).toBe(0);
    expect(Array.from(rects.slice(0, 4))).toEqual([12, 20, 260, 132]);
    expect(Array.from(rects.slice(4, 8))).toEqual([0, 0, 0, 0]);
  });

  it("caps packed uniforms at the shader limit while reporting overflow", () => {
    const registrations = Array.from({ length: MAX_WEBGL_GLASS_CARDS + 3 }, (_, index) =>
      registration(index, rect(0, index * 2, 120, 80)),
    );

    const packed = packVisibleGlassSurfaces(
      registrations,
      { width: 1280, height: 720 },
      createGlassSurfaceBuffer(),
    );

    expect(packed.count).toBe(MAX_WEBGL_GLASS_CARDS);
    expect(packed.visibleCount).toBe(MAX_WEBGL_GLASS_CARDS + 3);
    expect(packed.overflowCount).toBe(3);
  });

  it("uses the requested 1.5x to 2x backing DPR clamp", () => {
    expect(calculateBackingDpr(1)).toBe(1.5);
    expect(calculateBackingDpr(1.75)).toBe(1.75);
    expect(calculateBackingDpr(3)).toBe(2);
    expect(calculateBackingDpr(Number.NaN)).toBe(1.5);
  });
});

function registration(id: number, bounds: ReturnType<typeof rect>): GlassSurfaceRegistration {
  return {
    id,
    ref: {
      current: {
        getBoundingClientRect: () => bounds,
      } as Element,
    },
  };
}

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

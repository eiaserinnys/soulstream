import { describe, expect, it } from "vitest";
import {
  calculateLiquidLensMapSize,
  encodeLiquidLensVector,
  isChromiumUserAgent,
  sampleLiquidLensVector,
} from "./liquid-lens";

describe("liquid lens map helpers", () => {
  it("downsamples large surfaces to the design target side length", () => {
    expect(calculateLiquidLensMapSize(800, 240)).toEqual({
      width: 400,
      height: 120,
      downsample: 2,
    });
    expect(calculateLiquidLensMapSize(240, 120)).toEqual({
      width: 240,
      height: 120,
      downsample: 1,
    });
  });

  it("encodes the lens center as a neutral displacement value", () => {
    const vector = sampleLiquidLensVector(49.5, 29.5, {
      width: 100,
      height: 60,
      radius: 12,
      band: 20,
    });
    expect(Math.abs(vector.dx)).toBeLessThan(0.001);
    expect(Math.abs(vector.dy)).toBeLessThan(0.001);
    expect(encodeLiquidLensVector(vector)).toEqual({
      red: 128,
      green: 128,
      blue: 128,
      alpha: 255,
    });
  });

  it("recognizes Chromium UA variants without enabling Safari or Firefox", () => {
    expect(isChromiumUserAgent("Mozilla/5.0 HeadlessChrome/147.0.0.0 Safari/537.36")).toBe(true);
    expect(isChromiumUserAgent("Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36")).toBe(true);
    expect(isChromiumUserAgent("Mozilla/5.0 Version/17.0 Safari/605.1.15")).toBe(false);
    expect(isChromiumUserAgent("Mozilla/5.0 Firefox/128.0")).toBe(false);
  });
});

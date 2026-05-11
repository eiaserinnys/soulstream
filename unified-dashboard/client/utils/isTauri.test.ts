import { describe, it, expect, afterEach } from "vitest";
import { isTauri } from "./isTauri";

describe("isTauri()", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("window 부재 환경(SSR/Node)에서 false", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(isTauri()).toBe(false);
  });

  it("window.__TAURI_INTERNALS__ 존재 시 true", () => {
    (globalThis as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauri()).toBe(true);
  });

  it("일반 web window(__TAURI_INTERNALS__ 부재)에서 false", () => {
    (globalThis as { window: unknown }).window = {};
    expect(isTauri()).toBe(false);
  });
});

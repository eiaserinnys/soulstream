/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchUserPreferences,
  normalizeUserPreferencesResponse,
  readCachedUserPreferences,
  saveUserPreferences,
  uploadUserBackground,
  writeCachedUserPreferences,
} from "./user-preferences";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("user-preferences", () => {
  it("normalizes server responses and preserves background URLs", () => {
    const result = normalizeUserPreferencesResponse({
      email: "user@example.com",
      appearance: "dark",
      chatFontSize: 18,
      wallpaper: { mode: "photo", customImage: "/api/user/background?v=1" },
      glass: { enabled: false, refraction: 63, blur: 4, chromatic: 1.2, specular: 0.5, tint: 0.3 },
      hasBackground: true,
      backgroundUrl: "/api/user/background?v=1",
      updatedAt: "2026-06-14T00:00:00Z",
    });

    expect(result.appearance).toBe("dark");
    expect(result.chatFontSize).toBe(18);
    expect(result.wallpaper).toEqual({
      mode: "photo",
      customImage: "/api/user/background?v=1",
    });
    expect(result.glass).toEqual({
      enabled: false,
      refraction: 63,
      blur: 4,
      chromatic: 1.2,
      specular: 0.5,
      tint: 0.3,
    });
    expect(result.hasBackground).toBe(true);
  });

  it("falls back to default-on glass settings and clamps numeric ranges", () => {
    const result = normalizeUserPreferencesResponse({
      preferences: {
        appearance: "dark",
        wallpaper: { mode: "plain" },
        glass: {
          refraction: 180,
          blur: -2,
          chromatic: "1.7",
          specular: Number.NaN,
          tint: 2,
        },
      },
    });

    expect(result.glass).toEqual({
      enabled: true,
      refraction: 90,
      blur: 0,
      chromatic: 1.7,
      specular: 0.25,
      tint: 1,
    });
  });

  it("reads and writes account-scoped local cache", () => {
    writeCachedUserPreferences("User@Example.com", {
      appearance: "light",
      chatFontSize: 17,
      wallpaper: { mode: "metal" },
      glass: { enabled: true, refraction: 72, blur: 4.5, chromatic: 0.4, specular: 0.2, tint: 0.5 },
    });

    expect(readCachedUserPreferences("user@example.com")).toEqual({
      appearance: "light",
      chatFontSize: 17,
      wallpaper: { mode: "metal" },
      glass: { enabled: true, refraction: 72, blur: 4.5, chromatic: 0.4, specular: 0.2, tint: 0.5 },
    });
  });

  it("GETs preferences with same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      email: "user@example.com",
      appearance: "system",
      wallpaper: { mode: "bokeh" },
      glass: { enabled: true, refraction: 75, blur: 5, chromatic: 0.8, specular: 0.25, tint: 0.62 },
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: null,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUserPreferences();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/preferences",
      { credentials: "same-origin" },
    );
  });

  it("PUTs preferences with clearBackground", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      email: "user@example.com",
      appearance: "dark",
      wallpaper: { mode: "plain" },
      glass: { enabled: false, refraction: 50, blur: 2, chromatic: 0.5, specular: 0.3, tint: 0.7 },
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: "2026-06-14T00:00:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await saveUserPreferences(
      {
        appearance: "dark",
        chatFontSize: 16,
        wallpaper: { mode: "plain" },
        glass: { enabled: false, refraction: 50, blur: 2, chromatic: 0.5, specular: 0.3, tint: 0.7 },
      },
      { clearBackground: true },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/preferences",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        body: JSON.stringify({
          appearance: "dark",
          wallpaper: { mode: "plain" },
          glass: { enabled: false, refraction: 50, blur: 2, chromatic: 0.5, specular: 0.3, tint: 0.7 },
          chatFontSize: 16,
          clearBackground: true,
        }),
      }),
    );
  });

  it("POSTs background uploads as multipart form data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      email: "user@example.com",
      appearance: "system",
      wallpaper: { mode: "photo", customImage: "/api/user/background?v=2" },
      glass: { enabled: true, refraction: 75, blur: 5, chromatic: 0.8, specular: 0.25, tint: 0.62 },
      hasBackground: true,
      backgroundUrl: "/api/user/background?v=2",
      updatedAt: "2026-06-14T00:00:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadUserBackground(new Blob(["image"], { type: "image/png" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/background",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: expect.any(FormData),
      }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

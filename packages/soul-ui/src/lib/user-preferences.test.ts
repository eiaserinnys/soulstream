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
      wallpaper: { mode: "photo", customImage: "/api/user/background?v=1" },
      hasBackground: true,
      backgroundUrl: "/api/user/background?v=1",
      updatedAt: "2026-06-14T00:00:00Z",
    });

    expect(result.appearance).toBe("dark");
    expect(result.wallpaper).toEqual({
      mode: "photo",
      customImage: "/api/user/background?v=1",
    });
    expect(result.hasBackground).toBe(true);
  });

  it("reads and writes account-scoped local cache", () => {
    writeCachedUserPreferences("User@Example.com", {
      appearance: "light",
      wallpaper: { mode: "metal" },
    });

    expect(readCachedUserPreferences("user@example.com")).toEqual({
      appearance: "light",
      wallpaper: { mode: "metal" },
    });
  });

  it("GETs preferences with same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      email: "user@example.com",
      appearance: "system",
      wallpaper: { mode: "bokeh" },
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
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: "2026-06-14T00:00:00Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await saveUserPreferences(
      { appearance: "dark", wallpaper: { mode: "plain" } },
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

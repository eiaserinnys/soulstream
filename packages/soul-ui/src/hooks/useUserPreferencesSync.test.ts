/**
 * @vitest-environment jsdom
 */

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { useUserPreferencesSync } from "./useUserPreferencesSync";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPLOADED = "/api/user/background?v=1";

function Harness() {
  useUserPreferencesSync("user@example.com");
  return null;
}

function serverResponse(wallpaper: Record<string, unknown>) {
  return Response.json({
    email: "user@example.com",
    preferences: { appearance: "system", wallpaper },
    hasBackground: true,
    backgroundUrl: UPLOADED,
    updatedAt: "2026-07-09T03:05:06+00:00",
  });
}

describe("useUserPreferencesSync with an uploaded photo", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    useDashboardStore.getState().reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      init?.method === "PUT"
        ? serverResponse(JSON.parse(String(init.body)).wallpaper)
        : serverResponse({ mode: "photo", customImage: UPLOADED })
    ));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the uploaded photo when the user switches to bokeh", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(useDashboardStore.getState().uploadedBackgroundUrl).toBe(UPLOADED);

    await act(async () => useDashboardStore.getState().setWallpaper({ mode: "bokeh" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });

    const puts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(puts).toHaveLength(1);
    const body = JSON.parse(String((puts[0]![1] as RequestInit).body));
    expect(body.wallpaper).toEqual({ mode: "bokeh" });
    expect(body.clearBackground).toBe(false);
    expect(useDashboardStore.getState().uploadedBackgroundUrl).toBe(UPLOADED);
  });
});

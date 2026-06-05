import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CACHE_BUST_PARAM,
  toCacheBustedDashboardUrl,
} from "../dashboard-cache";

describe("toCacheBustedDashboardUrl", () => {
  it("adds a desktop version cache-bust query parameter", () => {
    const url = toCacheBustedDashboardUrl("https://soul.example.me/", "0.2.5");

    expect(url).toBe("https://soul.example.me/?soul_desktop_cache_bust=v0.2.5");
  });

  it("preserves existing query parameters and hash fragments", () => {
    const url = toCacheBustedDashboardUrl(
      "https://soul.example.me/dashboard?node=eiaserinnys#chat",
      "0.2.5",
    );

    expect(url).toBe(
      "https://soul.example.me/dashboard?node=eiaserinnys&soul_desktop_cache_bust=v0.2.5#chat",
    );
  });

  it("replaces an existing cache-bust parameter", () => {
    const url = toCacheBustedDashboardUrl(
      "https://soul.example.me/?soul_desktop_cache_bust=v0.2.4",
      "0.2.5",
    );

    expect(new URL(url).searchParams.get(DASHBOARD_CACHE_BUST_PARAM)).toBe("v0.2.5");
  });

  it("rejects invalid URLs", () => {
    expect(() => toCacheBustedDashboardUrl("not a url", "0.2.5")).toThrow();
  });
});

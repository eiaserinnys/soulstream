import { describe, expect, it } from "vitest";
import { decideStartup, isSettingsViewRequested } from "../launch";

describe("isSettingsViewRequested", () => {
  it("is true only for view=settings", () => {
    expect(isSettingsViewRequested("?view=settings")).toBe(true);
    expect(isSettingsViewRequested("?x=1&view=settings")).toBe(true);
    expect(isSettingsViewRequested("")).toBe(false);
    expect(isSettingsViewRequested("?view=other")).toBe(false);
  });
});

describe("decideStartup", () => {
  const saved = "https://soul.example.me";

  it("opens Settings instead of jumping to the saved server when view=settings", () => {
    expect(
      decideStartup({ savedUrl: saved, search: "?view=settings", updateAvailable: false }),
    ).toBe("settings");
    expect(
      decideStartup({ savedUrl: saved, search: "?view=settings", updateAvailable: true }),
    ).toBe("settings");
  });

  it("goes to the saved server on a normal launch", () => {
    expect(
      decideStartup({ savedUrl: saved, search: "", updateAvailable: false }),
    ).toBe("navigate");
  });

  it("waits for the update banner when an update is available", () => {
    expect(
      decideStartup({ savedUrl: saved, search: "", updateAvailable: true }),
    ).toBe("wait-for-update");
  });

  it("opens Setup when no server is saved, even with view=settings", () => {
    expect(
      decideStartup({ savedUrl: null, search: "?view=settings", updateAvailable: false }),
    ).toBe("setup");
    expect(
      decideStartup({ savedUrl: null, search: "", updateAvailable: false }),
    ).toBe("setup");
  });
});

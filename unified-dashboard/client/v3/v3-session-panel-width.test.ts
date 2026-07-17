// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  V3_SESSION_PANEL_DEFAULT_WIDTH,
  V3_SESSION_PANEL_MAX_WIDTH,
  V3_SESSION_PANEL_STORAGE_KEY,
  clampV3SessionPanelWidth,
  readV3SessionPanelWidth,
  writeV3SessionPanelWidth,
} from "./v3-session-panel-width";

describe("v3 session panel width", () => {
  afterEach(() => window.localStorage.clear());

  it("uses a dedicated persisted key and clamps the resize range", () => {
    expect(V3_SESSION_PANEL_STORAGE_KEY).not.toBe("dashboard-sidebar-collapse");
    expect(clampV3SessionPanelWidth(100)).toBe(240);
    expect(V3_SESSION_PANEL_MAX_WIDTH).toBe(560);
    expect(clampV3SessionPanelWidth(500)).toBe(500);
    expect(clampV3SessionPanelWidth(900)).toBe(V3_SESSION_PANEL_MAX_WIDTH);
  });

  it("can expand immediately from the legacy 420px persisted boundary", () => {
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "420");

    expect(readV3SessionPanelWidth()).toBe(420);
    expect(clampV3SessionPanelWidth(readV3SessionPanelWidth() + 80)).toBe(500);
  });

  it("reads and writes a safe persisted width", () => {
    expect(readV3SessionPanelWidth()).toBe(V3_SESSION_PANEL_DEFAULT_WIDTH);
    writeV3SessionPanelWidth(333);
    expect(readV3SessionPanelWidth()).toBe(333);
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "invalid");
    expect(readV3SessionPanelWidth()).toBe(V3_SESSION_PANEL_DEFAULT_WIDTH);
  });
});

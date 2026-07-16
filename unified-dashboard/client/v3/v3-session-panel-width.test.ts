// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  V3_SESSION_PANEL_DEFAULT_WIDTH,
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
    expect(clampV3SessionPanelWidth(900)).toBe(420);
  });

  it("reads and writes a safe persisted width", () => {
    expect(readV3SessionPanelWidth()).toBe(V3_SESSION_PANEL_DEFAULT_WIDTH);
    writeV3SessionPanelWidth(333);
    expect(readV3SessionPanelWidth()).toBe(333);
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "invalid");
    expect(readV3SessionPanelWidth()).toBe(V3_SESSION_PANEL_DEFAULT_WIDTH);
  });
});

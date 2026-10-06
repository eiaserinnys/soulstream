// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  V3_SESSION_PANEL_STORAGE_KEY,
  readV3SessionPanelWidth,
  writeV3SessionPanelWidth,
} from "./v3-session-panel-width";

describe("v3 session panel width", () => {
  afterEach(() => window.localStorage.clear());

  it("keeps a dedicated persisted key", () => {
    expect(V3_SESSION_PANEL_STORAGE_KEY).not.toBe("dashboard-sidebar-collapse");
  });

  it("preserves previously saved widths without applying a fixed maximum", () => {
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "420");
    expect(readV3SessionPanelWidth()).toBe(420);
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "700");
    expect(readV3SessionPanelWidth()).toBe(700);
  });

  it("returns null for absent or non-numeric values and rounds writes", () => {
    expect(readV3SessionPanelWidth()).toBeNull();
    writeV3SessionPanelWidth(333.6);
    expect(readV3SessionPanelWidth()).toBe(334);
    window.localStorage.setItem(V3_SESSION_PANEL_STORAGE_KEY, "invalid");
    expect(readV3SessionPanelWidth()).toBeNull();
  });
});

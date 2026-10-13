/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import {
  persistentSessionDevicePreferenceKey,
  readPersistentSessionDevicePreferences,
  setPersistentSessionLastSessionId,
  setPersistentSessionOpenOnStart,
  setPersistentSessionShowWeeklyUsage,
  setPersistentSessionWeeklyUsageNodeSelection,
} from "./persistent-session-device-preferences";

describe("persistent session device preferences", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes the email and stores device-specific PAS choices", () => {
    expect(persistentSessionDevicePreferenceKey("  Admin@Example.com ")).toBe("soulstream-pas-device:admin@example.com");
    expect(readPersistentSessionDevicePreferences("Admin@Example.com")).toEqual({
      openOnStart: false,
      lastSessionId: null,
      showWeeklyUsage: false,
      weeklyUsageNodeSelection: null,
    });

    setPersistentSessionOpenOnStart("Admin@Example.com", true);
    setPersistentSessionLastSessionId("Admin@Example.com", "session-42");
    setPersistentSessionShowWeeklyUsage("Admin@Example.com", true);

    expect(localStorage.getItem("soulstream-pas-device:admin@example.com")).toBe(JSON.stringify({ openOnStart: true, lastSessionId: "session-42", showWeeklyUsage: true, weeklyUsageNodeSelection: null }));
    expect(readPersistentSessionDevicePreferences("admin@example.com")).toEqual({
      openOnStart: true,
      lastSessionId: "session-42",
      showWeeklyUsage: true,
      weeklyUsageNodeSelection: null,
    });
  });

  it("keeps the default values when stored JSON cannot provide the preference fields", () => {
    localStorage.setItem("soulstream-pas-device:admin@example.com", "not-json");
    expect(readPersistentSessionDevicePreferences("admin@example.com")).toEqual({
      openOnStart: false,
      lastSessionId: null,
      showWeeklyUsage: false,
      weeklyUsageNodeSelection: null,
    });
  });

  it("persists a selected summary node without replacing other device preferences or another account", () => {
    setPersistentSessionOpenOnStart("Admin@Example.com", true);
    setPersistentSessionLastSessionId("Admin@Example.com", "session-42");
    setPersistentSessionShowWeeklyUsage("Admin@Example.com", true);

    setPersistentSessionWeeklyUsageNodeSelection("Admin@Example.com", {
      configuredNodeId: "node-a",
      selectedNodeId: "node-c",
    });

    expect(readPersistentSessionDevicePreferences("admin@example.com")).toEqual({
      openOnStart: true,
      lastSessionId: "session-42",
      showWeeklyUsage: true,
      weeklyUsageNodeSelection: { configuredNodeId: "node-a", selectedNodeId: "node-c" },
    });
    expect(readPersistentSessionDevicePreferences("other@example.com").weeklyUsageNodeSelection).toBeNull();
  });
});

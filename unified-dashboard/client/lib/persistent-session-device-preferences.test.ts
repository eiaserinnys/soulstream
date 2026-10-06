/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import {
  persistentSessionDevicePreferenceKey,
  readPersistentSessionDevicePreferences,
  setPersistentSessionLastSessionId,
  setPersistentSessionOpenOnStart,
} from "./persistent-session-device-preferences";

describe("persistent session device preferences", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes the email and stores only device-specific open and last-session choices", () => {
    expect(persistentSessionDevicePreferenceKey("  Admin@Example.com ")).toBe("soulstream-pas-device:admin@example.com");
    expect(readPersistentSessionDevicePreferences("Admin@Example.com")).toEqual({ openOnStart: false, lastSessionId: null });

    setPersistentSessionOpenOnStart("Admin@Example.com", true);
    setPersistentSessionLastSessionId("Admin@Example.com", "session-42");

    expect(localStorage.getItem("soulstream-pas-device:admin@example.com")).toBe(JSON.stringify({ openOnStart: true, lastSessionId: "session-42" }));
    expect(readPersistentSessionDevicePreferences("admin@example.com")).toEqual({ openOnStart: true, lastSessionId: "session-42" });
  });

  it("keeps the default values when stored JSON cannot provide the preference fields", () => {
    localStorage.setItem("soulstream-pas-device:admin@example.com", "not-json");
    expect(readPersistentSessionDevicePreferences("admin@example.com")).toEqual({ openOnStart: false, lastSessionId: null });
  });
});

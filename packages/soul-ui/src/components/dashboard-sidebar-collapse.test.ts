import { describe, expect, it } from "vitest";

import {
  DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY,
  isDashboardSidebarToggleShortcut,
  readDashboardLeftSidebarCollapsed,
  writeDashboardLeftSidebarCollapsed,
} from "./dashboard-sidebar-collapse";

describe("dashboard-sidebar-collapse", () => {
  it("persists the desktop left sidebar collapsed state", () => {
    const storage = new Map<string, string>();
    const mockStorage = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as Storage;

    writeDashboardLeftSidebarCollapsed(true, mockStorage);

    expect(storage.get(DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
    expect(readDashboardLeftSidebarCollapsed(mockStorage)).toBe(true);
  });

  it("treats blocked localStorage as an unavailable persistence layer", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });

    try {
      expect(readDashboardLeftSidebarCollapsed()).toBe(false);
      expect(() => writeDashboardLeftSidebarCollapsed(true)).not.toThrow();
    } finally {
      if (originalDescriptor) Object.defineProperty(globalThis, "localStorage", originalDescriptor);
    }
  });

  it("uses Cmd+B on macOS and Ctrl+B elsewhere", () => {
    expect(isDashboardSidebarToggleShortcut({ key: "b", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "MacIntel")).toBe(true);
    expect(isDashboardSidebarToggleShortcut({ key: "b", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, "MacIntel")).toBe(false);
    expect(isDashboardSidebarToggleShortcut({ key: "B", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, "Win32")).toBe(true);
    expect(isDashboardSidebarToggleShortcut({ key: "b", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }, "Linux x86_64")).toBe(false);
  });
});

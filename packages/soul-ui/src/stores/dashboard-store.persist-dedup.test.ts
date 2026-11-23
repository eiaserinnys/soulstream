import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * zustand persist 스토리지 래퍼 검증.
 *
 * 스트리밍 플러시처럼 영속 대상(drafts, folderSortMode, leftNavigationMode,
 * folderBoardLayouts)과 무관한 set()이 반복될 때 JSON.stringify와
 * localStorage.setItem이 모두 일어나지 않아야 한다.
 *
 * 스토어 모듈은 import 시점에 getDashboardPersistStorage()로 스토리지를 한 번
 * 고르므로, 카운팅 가능한 가짜 window.localStorage를 import 전에 심는다.
 */
const storageHarness = vi.hoisted(() => {
  const map = new Map<string, string>();
  const setItem = vi.fn((name: string, value: string) => {
    map.set(name, value);
  });
  const getItem = vi.fn((name: string) => map.get(name) ?? null);
  const removeItem = vi.fn((name: string) => {
    map.delete(name);
  });
  (globalThis as Record<string, unknown>).window = {
    localStorage: { getItem, setItem, removeItem },
  };
  return { map, setItem, getItem, removeItem };
});

import { useDashboardStore } from "./dashboard-store";
import type { TextDeltaEvent, UserMessageEvent } from "../shared/types";

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

function resetToCleanSlate(): void {
  useDashboardStore.getState().reset();
  storageHarness.setItem.mockClear();
  storageHarness.removeItem.mockClear();
  storageHarness.getItem.mockClear();
}

describe("dashboard persist storage deduplication", () => {
  beforeEach(() => {
    resetToCleanSlate();
  });

  it("serializes and writes nothing for 100 unrelated streaming batches", () => {
    useDashboardStore.getState().setActiveSession("persist-dedup-stream");
    useDashboardStore.getState().processEvent(
      { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
      0,
    );
    storageHarness.setItem.mockClear();
    const stringifySpy = vi.spyOn(JSON, "stringify");

    for (let index = 0; index < 100; index += 1) {
      useDashboardStore.getState().processEvents([
        {
          event: { type: "text_delta", text: `token-${index}` } as TextDeltaEvent,
          eventId: index + 1,
        },
      ]);
    }

    const stringifyCalls = stringifySpy.mock.calls.length;
    stringifySpy.mockRestore();
    expect(stringifyCalls).toBe(0);
    expect(storageHarness.setItem).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().treeVersion).toBeGreaterThan(0);
  });

  it("writes once per actual persisted-field change and keeps the storage shape", () => {
    useDashboardStore.getState().setDraft("session-a", "hello");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(1);

    useDashboardStore.getState().setDraft("session-a", "hello world");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(2);

    useDashboardStore.getState().clearDraft("session-a");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(3);

    useDashboardStore.getState().setDraft("session-b", "draft b");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(4);

    const [name, raw] = storageHarness.setItem.mock.calls[3];
    expect(name).toBe("soul-dashboard-storage");
    const state = useDashboardStore.getState();
    expect(JSON.parse(raw)).toEqual({
      state: {
        drafts: { "session-b": "draft b" },
        folderSortMode: state.folderSortMode,
        leftNavigationMode: state.leftNavigationMode,
        folderBoardLayouts: state.folderBoardLayouts,
      },
      version: 0,
    });
  });

  it("restores persisted drafts on rehydration and writes again afterwards", async () => {
    storageHarness.map.set(
      "soul-dashboard-storage",
      JSON.stringify({
        state: {
          drafts: { "session-restored": "restored text" },
          folderSortMode: "created",
          leftNavigationMode: "feed",
          folderBoardLayouts: {},
        },
        version: 0,
      }),
    );

    await useDashboardStore.persist.rehydrate();

    expect(useDashboardStore.getState().drafts["session-restored"]).toBe("restored text");
    expect(useDashboardStore.getState().leftNavigationMode).toBe("feed");

    storageHarness.setItem.mockClear();
    useDashboardStore.getState().setDraft("session-restored", "edited");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed write and retries on the next set", () => {
    storageHarness.setItem.mockImplementationOnce(() => {
      throw new Error("quota exceeded");
    });

    expect(() => useDashboardStore.getState().setDraft("session-a", "boom")).toThrow(
      "quota exceeded",
    );
    expect(useDashboardStore.getState().drafts["session-a"]).toBe("boom");

    storageHarness.setItem.mockClear();
    useDashboardStore.getState().setActiveSession("session-unrelated");

    expect(storageHarness.setItem).toHaveBeenCalledTimes(1);
    const raw = storageHarness.setItem.mock.calls[0][1];
    expect(JSON.parse(raw).state.drafts).toEqual({ "session-a": "boom" });
  });

  it("writes again after removeItem clears the storage", () => {
    useDashboardStore.getState().setDraft("session-a", "before-clear");
    expect(storageHarness.setItem).toHaveBeenCalledTimes(1);

    useDashboardStore.persist.clearStorage();
    expect(storageHarness.removeItem).toHaveBeenCalledWith("soul-dashboard-storage");
    expect(storageHarness.map.has("soul-dashboard-storage")).toBe(false);

    storageHarness.setItem.mockClear();
    useDashboardStore.getState().setActiveSession("session-unrelated");

    expect(storageHarness.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storageHarness.setItem.mock.calls[0][1]).state.drafts).toEqual({
      "session-a": "before-clear",
    });
  });

  it("does not rewrite while the persisted references stay untouched across many sets", () => {
    useDashboardStore.getState().setDraft("session-a", "stable draft");
    storageHarness.setItem.mockClear();

    for (let index = 0; index < 10; index += 1) {
      useDashboardStore.getState().setActiveSession(`session-${index}`);
      useDashboardStore.getState().setFocusEventId(index, `session-${index}`);
      useDashboardStore.getState().setLeftNavigationMode("folders");
    }

    expect(storageHarness.setItem).not.toHaveBeenCalled();
  });
});

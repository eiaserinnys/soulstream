import { describe, expect, it } from "vitest";

import {
  navigationSnapshot,
  resolveNavigationTarget,
  subscribeNavigationUiEvents,
  type StoreSubscribable,
} from "./ui-events-instrumentation";
import type { UiEventDraft, UiEventType } from "@seosoyoung/soul-ui";

type State = Record<string, unknown>;

function fakeStore(initial: State) {
  let state = initial;
  const listeners = new Set<(next: State, previous: State) => void>();
  const store: StoreSubscribable<State> & { set: (patch: State) => void } = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (patch) => {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, previous);
    },
  };
  return store;
}

function recorder() {
  const events: { type: UiEventType; draft: UiEventDraft | undefined }[] = [];
  return { events, track: (type: UiEventType, draft?: UiEventDraft) => { events.push({ type, draft }); } };
}

const BASE: State = {
  viewMode: "feed",
  activeSessionKey: null,
  activeBoardContainer: null,
  activeBoardDocumentId: null,
  activeCustomViewId: null,
  selectedFolderId: null,
};

describe("navigation snapshot", () => {
  it("reads only the fields that decide which screen is open", () => {
    expect(navigationSnapshot({ ...BASE, sessions: [1, 2, 3], catalog: {} } as State))
      .toEqual({
        viewMode: "feed",
        activeSessionKey: null,
        activeBoardContainerKind: null,
        activeBoardContainerId: null,
        activeBoardDocumentId: null,
        activeCustomViewId: null,
        selectedFolderId: null,
      });
  });
});

describe("navigation target", () => {
  const snapshot = (patch: State) => navigationSnapshot({ ...BASE, ...patch });

  it("prefers the session when a single update changes several fields", () => {
    // openTaskBoard 류는 한 번의 set() 으로 여러 필드를 바꾼다.
    expect(resolveNavigationTarget(
      snapshot({}),
      snapshot({ activeSessionKey: "s1", selectedFolderId: "f1", viewMode: "folder" }),
    )).toEqual({ kind: "session", id: "s1" });
  });

  it("reports a task board as a task", () => {
    expect(resolveNavigationTarget(
      snapshot({}),
      snapshot({ activeBoardContainer: { kind: "task", id: "t1" }, viewMode: "folder" }),
    )).toEqual({ kind: "task", id: "t1" });
  });

  it("reports an opened document", () => {
    expect(resolveNavigationTarget(snapshot({}), snapshot({ activeBoardDocumentId: "d1" })))
      .toEqual({ kind: "document", id: "d1" });
  });

  it("reports a custom view", () => {
    expect(resolveNavigationTarget(snapshot({}), snapshot({ activeCustomViewId: "v1" })))
      .toEqual({ kind: "custom_view", id: "v1" });
  });

  it("falls back to the folder and then to the view mode", () => {
    expect(resolveNavigationTarget(snapshot({}), snapshot({ selectedFolderId: "f1" })))
      .toEqual({ kind: "folder", id: "f1" });
    expect(resolveNavigationTarget(snapshot({}), snapshot({ viewMode: "tasks" })))
      .toEqual({ kind: "view", id: "tasks" });
  });

  it("sees no navigation when nothing that defines the screen moved", () => {
    expect(resolveNavigationTarget(snapshot({ activeSessionKey: "s1" }),
      snapshot({ activeSessionKey: "s1" }))).toBeNull();
  });
});

describe("navigation subscription", () => {
  it("emits one view_open per move", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({ activeSessionKey: "s1" });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("view_open");
    expect(events[0]?.draft?.target).toEqual({ kind: "session", id: "s1" });
  });

  it("stays silent while streamed data churns the store", () => {
    // SSE 수신이나 폴링으로 세션 목록이 갱신되는 것은 사용자 조작이 아니다.
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({ sessions: [1] });
    store.set({ sessions: [1, 2] });
    store.set({ catalog: { sessions: {} } });
    store.set({ pendingNotifications: [{ id: "n1" }] });

    expect(events).toHaveLength(0);
  });

  it("does not repeat itself when the same screen is set again", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({ activeSessionKey: "s1" });
    store.set({ activeSessionKey: "s1" });

    expect(events).toHaveLength(1);
  });

  it("carries the previous screen as the origin of the next one", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({ activeSessionKey: "s1" });
    store.set({ activeSessionKey: "s2" });

    expect(events[0]?.draft?.from).toBeUndefined();
    expect(events[1]?.draft?.from).toEqual({ kind: "session", id: "s1" });
    expect(events[1]?.draft?.target).toEqual({ kind: "session", id: "s2" });
  });

  it("leaves entry unset so the collector can apply the click hint", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);
    store.set({ activeSessionKey: "s1" });
    expect(events[0]?.draft?.entry).toBeUndefined();
  });

  it("collapses a multi field navigation into a single event", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({
      activeBoardContainer: { kind: "task", id: "t1" },
      selectedFolderId: "f1",
      viewMode: "folder",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.draft?.target).toEqual({ kind: "task", id: "t1" });
  });

  it("stops listening once disposed", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    const dispose = subscribeNavigationUiEvents(store, track);
    dispose();
    store.set({ activeSessionKey: "s1" });
    expect(events).toHaveLength(0);
  });
});

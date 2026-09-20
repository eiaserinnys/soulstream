import { describe, expect, it } from "vitest";

import {
  initialNavigationTarget,
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

describe("initial screen", () => {
  const snapshot = (patch: State) => navigationSnapshot({ ...BASE, ...patch });

  it("uses the document that was already open rather than what is under it", () => {
    expect(initialNavigationTarget(
      snapshot({ activeSessionKey: "s1", activeBoardDocumentId: "d1" }),
    )).toEqual({ kind: "document", id: "d1" });
  });

  it("uses the custom view that was already open", () => {
    expect(initialNavigationTarget(
      snapshot({ activeSessionKey: "s1", activeCustomViewId: "v1" }),
    )).toEqual({ kind: "custom_view", id: "v1" });
  });

  it("falls back to the session when no overlay is open", () => {
    expect(initialNavigationTarget(snapshot({ activeSessionKey: "s1" })))
      .toEqual({ kind: "session", id: "s1" });
  });

  it("falls back to the view mode on a bare start", () => {
    expect(initialNavigationTarget(snapshot({}))).toEqual({ kind: "view", id: "feed" });
  });
});

describe("navigation subscription", () => {
  it("records the screen that was already open when it starts listening", () => {
    // 이것이 없으면 그 실행의 첫 화면이 타임라인에서 통째로 빠진다.
    const store = fakeStore({ ...BASE, activeSessionKey: "s0" });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    expect(events).toHaveLength(1);
    expect(events[0]?.draft?.target).toEqual({ kind: "session", id: "s0" });
    expect(events[0]?.draft?.entry).toBe("url");
  });

  it("links the first move back to the screen it started from", () => {
    const store = fakeStore({ ...BASE, activeSessionKey: "s0" });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    store.set({ activeSessionKey: "s1" });

    expect(events[1]?.draft?.from).toEqual({ kind: "session", id: "s0" });
  });

  it("records returning to the session when an open document is closed", () => {
    // session-slice 는 같은 세션을 다시 고를 때 문서/커스텀 뷰를 비운다.
    // 화면은 분명히 바뀌는데 바뀐 필드만 보면 아무 대상도 잡히지 않는다.
    const store = fakeStore({
      ...BASE, activeSessionKey: "s1", activeBoardDocumentId: "d1",
    });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);
    const before = events.length;

    store.set({ activeBoardDocumentId: null });

    expect(events).toHaveLength(before + 1);
    expect(events[before]?.draft?.target).toEqual({ kind: "session", id: "s1" });
  });

  it("records returning when a custom view is closed", () => {
    const store = fakeStore({
      ...BASE, activeSessionKey: "s1", activeCustomViewId: "v1",
    });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);
    const before = events.length;

    store.set({ activeCustomViewId: null });

    expect(events[before]?.draft?.target).toEqual({ kind: "session", id: "s1" });
  });

  it("emits one view_open per move", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);
    // 구독 시점의 초기 화면 1건이 먼저 들어간다. 이후는 이동마다 1건.
    const before = events.length;

    store.set({ activeSessionKey: "s1" });

    expect(events).toHaveLength(before + 1);
    expect(events[before]?.type).toBe("view_open");
    expect(events[before]?.draft?.target).toEqual({ kind: "session", id: "s1" });
  });

  it("stays silent while streamed data churns the store", () => {
    // SSE 수신이나 폴링으로 세션 목록이 갱신되는 것은 사용자 조작이 아니다.
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    const before = events.length;

    store.set({ sessions: [1] });
    store.set({ sessions: [1, 2] });
    store.set({ catalog: { sessions: {} } });
    store.set({ pendingNotifications: [{ id: "n1" }] });

    // 초기 1건 외에는 아무것도 늘지 않아야 한다.
    expect(events).toHaveLength(before);
  });

  it("does not repeat itself when the same screen is set again", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    const before = events.length;

    store.set({ activeSessionKey: "s1" });
    store.set({ activeSessionKey: "s1" });

    expect(events).toHaveLength(before + 1);
  });

  it("carries the previous screen as the origin of the next one", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    const before = events.length;

    store.set({ activeSessionKey: "s1" });
    store.set({ activeSessionKey: "s2" });

    expect(events[before]?.draft?.from).toEqual({ kind: "view", id: "feed" });
    expect(events[before + 1]?.draft?.from).toEqual({ kind: "session", id: "s1" });
    expect(events[before + 1]?.draft?.target).toEqual({ kind: "session", id: "s2" });
  });

  it("leaves entry unset so the collector can apply the click hint", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);
    const before = events.length;
    store.set({ activeSessionKey: "s1" });
    // 초기 화면만 url 로 못 박고, 이후 이동은 수집기가 클릭 힌트를 붙이도록 비워 둔다.
    expect(events[before]?.draft?.entry).toBeUndefined();
  });

  it("collapses a multi field navigation into a single event", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    subscribeNavigationUiEvents(store, track);

    const before = events.length;

    store.set({
      activeBoardContainer: { kind: "task", id: "t1" },
      selectedFolderId: "f1",
      viewMode: "folder",
    });

    expect(events).toHaveLength(before + 1);
    expect(events[before]?.draft?.target).toEqual({ kind: "task", id: "t1" });
  });

  it("stops listening once disposed", () => {
    const store = fakeStore({ ...BASE });
    const { events, track } = recorder();
    const dispose = subscribeNavigationUiEvents(store, track);
    const before = events.length;
    dispose();
    store.set({ activeSessionKey: "s1" });
    expect(events).toHaveLength(before);
  });
});

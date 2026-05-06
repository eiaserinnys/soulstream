/**
 * prompt-suggestion-slice 단위 테스트.
 *
 * dashboard-store 통합 없이 slice의 reducer 동작만 격리 검증한다.
 * createStore + 캐스팅으로 mock store를 만든다 (zustand 일반 패턴).
 */

import { describe, it, expect } from "vitest";
import { createStore } from "zustand/vanilla";
import type { StateCreator } from "zustand";
import {
  createPromptSuggestionSlice,
  getPromptSuggestionInitialState,
} from "./prompt-suggestion-slice";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

type Slice = ReturnType<typeof createPromptSuggestionSlice>;

function makeStore() {
  // slice는 DashboardState & DashboardActions의 부분만 필요로 한다 — 캐스팅으로 격리.
  const creator = createPromptSuggestionSlice as unknown as StateCreator<Slice>;
  return createStore<Slice>()((set, get, store) => creator(set as never, get as never, store as never));
}

describe("prompt-suggestion-slice", () => {
  it("초기 state: lastPromptSuggestions = {}", () => {
    expect(getPromptSuggestionInitialState()).toEqual({ lastPromptSuggestions: {} });
  });

  it("setPromptSuggestion: 신규 entry 추가", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "hello");
    expect(store.getState().lastPromptSuggestions).toEqual({ "sess-1": "hello" });
  });

  it("setPromptSuggestion: 기존 entry 덮어쓰기", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "first");
    store.getState().setPromptSuggestion("sess-1", "second");
    expect(store.getState().lastPromptSuggestions).toEqual({ "sess-1": "second" });
  });

  it("setPromptSuggestion: 다른 세션 entry는 보존", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "a");
    store.getState().setPromptSuggestion("sess-2", "b");
    expect(store.getState().lastPromptSuggestions).toEqual({ "sess-1": "a", "sess-2": "b" });
  });

  it("setPromptSuggestion(null): 해당 entry 제거", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "a");
    store.getState().setPromptSuggestion("sess-1", null);
    expect(store.getState().lastPromptSuggestions).toEqual({});
  });

  it("setPromptSuggestion: 같은 값 재호출이면 state 객체 reference 유지 (불필요한 리렌더 방지)", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "x");
    const before = store.getState().lastPromptSuggestions;
    store.getState().setPromptSuggestion("sess-1", "x");
    const after = store.getState().lastPromptSuggestions;
    expect(after).toBe(before);
  });

  it("clearPromptSuggestion: entry 제거", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "a");
    store.getState().clearPromptSuggestion("sess-1");
    expect(store.getState().lastPromptSuggestions).toEqual({});
  });

  it("clearPromptSuggestion: 존재하지 않는 entry → state 객체 reference 유지", () => {
    const store = makeStore();
    const before = store.getState().lastPromptSuggestions;
    store.getState().clearPromptSuggestion("sess-missing");
    const after = store.getState().lastPromptSuggestions;
    expect(after).toBe(before);
  });

  it("clearPromptSuggestion: 다른 세션 entry는 보존", () => {
    const store = makeStore();
    store.getState().setPromptSuggestion("sess-1", "a");
    store.getState().setPromptSuggestion("sess-2", "b");
    store.getState().clearPromptSuggestion("sess-1");
    expect(store.getState().lastPromptSuggestions).toEqual({ "sess-2": "b" });
  });
});

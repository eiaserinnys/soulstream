import { describe, expect, it } from "vitest";

import { DetailCursorStore } from "./detail-cursor-store";

describe("DetailCursorStore", () => {
  it("isolates cursors by provider-owned store, server/user scope, and session", () => {
    const firstProvider = new DetailCursorStore();
    const secondProvider = new DetailCursorStore();

    firstProvider.commit("https://one.test|alice", "session-a", 12);
    firstProvider.commit("https://one.test|bob", "session-a", 7);
    firstProvider.commit("https://two.test|alice", "session-a", 4);

    expect(firstProvider.get("https://one.test|alice", "session-a")).toBe(12);
    expect(firstProvider.get("https://one.test|bob", "session-a")).toBe(7);
    expect(firstProvider.get("https://two.test|alice", "session-a")).toBe(4);
    expect(secondProvider.get("https://one.test|alice", "session-a")).toBe(0);
  });

  it("commits monotonically and reclaims a deleted session from every scope", () => {
    const store = new DetailCursorStore();
    store.commit("server|alice", "session-a", 10);
    store.commit("server|alice", "session-a", 8);
    store.commit("server|bob", "session-a", 11);

    expect(store.get("server|alice", "session-a")).toBe(10);
    store.deleteSession("session-a");
    expect(store.get("server|alice", "session-a")).toBe(0);
    expect(store.get("server|bob", "session-a")).toBe(0);
  });

  it("bounds both sessions per scope and retained scopes", () => {
    const store = new DetailCursorStore({ maxScopes: 2, maxSessionsPerScope: 2 });
    store.commit("scope-a", "s1", 1);
    store.commit("scope-a", "s2", 2);
    store.commit("scope-a", "s3", 3);
    expect(store.get("scope-a", "s1")).toBe(0);
    expect(store.get("scope-a", "s2")).toBe(2);

    store.commit("scope-b", "s1", 1);
    store.commit("scope-c", "s1", 1);
    expect(store.get("scope-a", "s2")).toBe(0);
    expect(store.get("scope-b", "s1")).toBe(1);
    expect(store.get("scope-c", "s1")).toBe(1);
  });

  it("clears an old server/user scope without touching the next scope", () => {
    const store = new DetailCursorStore();
    store.commit("old|alice", "session-a", 5);
    store.commit("new|alice", "session-a", 9);
    store.clearScope("old|alice");
    expect(store.get("old|alice", "session-a")).toBe(0);
    expect(store.get("new|alice", "session-a")).toBe(9);
  });
});

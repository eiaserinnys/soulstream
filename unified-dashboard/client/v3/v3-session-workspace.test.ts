import { describe, expect, it, vi } from "vitest";
import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";

import {
  resolveSessionForOpen,
  resolveSessionWorkspace,
} from "./v3-session-workspace";

describe("resolveSessionForOpen", () => {
  it("reuses a matching summary without fetching", async () => {
    const known = session("session-a", "folder-a");
    const fetchSessions = vi.fn();

    await expect(resolveSessionForOpen({
      sessionId: "session-a",
      knownSession: known,
      fetchSessions,
    })).resolves.toBe(known);
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it("performs one targeted lookup when the search result is outside the loaded v3 sessions", async () => {
    const target = session("target-session", "folder-a");
    const fetchSessions = vi.fn(async () => ({ sessions: [target] }));

    await expect(resolveSessionForOpen({
      sessionId: "target-session",
      fetchSessions,
    })).resolves.toBe(target);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(fetchSessions).toHaveBeenCalledWith({ sessionIds: ["target-session"] });
  });

  it("returns null when the targeted session no longer exists", async () => {
    const fetchSessions = vi.fn(async () => ({ sessions: [] }));

    await expect(resolveSessionForOpen({
      sessionId: "missing-session",
      fetchSessions,
    })).resolves.toBeNull();
  });
});

describe("resolveSessionWorkspace", () => {
  it("uses a cached primary board item without a request", async () => {
    const fetchImplementation = vi.fn();
    const result = await resolveSessionWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [boardItem("session-a", "task", "task-a")],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    });

    expect(result).toEqual({ target: { kind: "task", pageId: "task-a" } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("opens an unassigned session standalone without a request", async () => {
    const fetchImplementation = vi.fn();
    const result = await resolveSessionWorkspace({
      session: session("session-a", null),
      boardItems: [],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    });

    expect(result).toEqual({ target: { kind: "standalone" } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("performs one bounded folder lookup when the cached catalog cannot resolve the session", async () => {
    const items = [boardItem("session-a", "task", "task-a")];
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ boardItems: items }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await resolveSessionWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/board-items?folder_id=folder-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      target: { kind: "task", pageId: "task-a" },
      loadedBoardItems: items,
      folderId: "folder-a",
    });
  });

  it.each([
    ["an empty board item list", { boardItems: [] }],
    ["a payload without boardItems", {}],
  ])("opens standalone after %s", async (_label, payload) => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await resolveSessionWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      target: { kind: "standalone" },
      loadedBoardItems: [],
      folderId: "folder-a",
    });
  });

  it("rejects an unsuccessful folder lookup with the HTTP status", async () => {
    const fetchImplementation = vi.fn(async () => new Response("unavailable", { status: 503 }));

    await expect(resolveSessionWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    })).rejects.toThrow("세션의 업무를 불러오지 못했습니다 (503)");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

function session(agentSessionId: string, folderId: string | null): SessionSummary {
  return {
    agentSessionId,
    folderId,
    status: "running",
    createdAt: "2026-07-16T00:00:00Z",
  } as SessionSummary;
}

function boardItem(
  sessionId: string,
  containerKind: "folder" | "task",
  containerId: string,
): CatalogBoardItem {
  return {
    id: `board-${sessionId}`,
    folderId: "folder-a",
    itemType: "session",
    itemId: sessionId,
    membershipKind: "primary",
    containerKind,
    containerId,
    x: 0,
    y: 0,
  };
}

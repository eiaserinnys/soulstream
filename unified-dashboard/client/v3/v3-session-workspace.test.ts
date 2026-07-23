import { describe, expect, it, vi } from "vitest";
import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";

import {
  resolveSessionForOpen,
  resolveSessionTaskWorkspace,
  resolveSessionWorkspace,
  SessionWorkspaceResolutionError,
} from "./v3-session-workspace";
import type { PlannerTask } from "./planner-data";

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

  it("opens a truly unassigned session standalone after a targeted canonical lookup", async () => {
    const fetchImplementation = vi.fn(async () => json({ boardItems: [] }));
    const result = await resolveSessionWorkspace({
      session: session("session-a", null),
      boardItems: [],
      fetchImplementation: fetchImplementation as typeof globalThis.fetch,
    });

    expect(result).toEqual({ target: { kind: "standalone" }, loadedBoardItems: [] });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/board-items?session_id=session-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("performs one targeted session lookup when daily and project collections do not contain its task", async () => {
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
      "/api/board-items?session_id=session-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      target: { kind: "task", pageId: "task-a" },
      loadedBoardItems: items,
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

describe("resolveSessionTaskWorkspace", () => {
  it("target-loads a task outside daily and loaded project pages without adding daily membership", async () => {
    const target = plannerTask("task-outside-page", "in_progress");
    const loadTask = vi.fn(async () => target);
    const result = await resolveSessionTaskWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [],
      currentTasks: [],
      loadTask,
      fetchImplementation: vi.fn(async () => json({
        boardItems: [boardItem("session-a", "task", "task-outside-page")],
      })) as typeof globalThis.fetch,
    });

    expect(result.task).toBe(target);
    expect(loadTask).toHaveBeenCalledWith("task-outside-page");
  });

  it("reuses a completed owning task even when it is absent from daily membership", async () => {
    const completed = plannerTask("task-complete", "completed");
    const loadTask = vi.fn();
    const result = await resolveSessionTaskWorkspace({
      session: session("session-a", "folder-a"),
      boardItems: [boardItem("session-a", "task", "task-complete")],
      currentTasks: [completed],
      loadTask,
    });

    expect(result.task).toBe(completed);
    expect(loadTask).not.toHaveBeenCalled();
  });

  it("distinguishes an owning-task load failure from a truly unassigned session", async () => {
    const lookup = vi.fn(async () => json({
      boardItems: [boardItem("session-a", "task", "task-missing")],
    })) as typeof globalThis.fetch;
    const promise = resolveSessionTaskWorkspace({
      session: session("session-a", null),
      boardItems: [],
      currentTasks: [],
      loadTask: async () => { throw new Error("Not Found"); },
      fetchImplementation: lookup,
    });
    await expect(promise).rejects.toBeInstanceOf(SessionWorkspaceResolutionError);
    await expect(promise).rejects.toMatchObject({
      phase: "task",
      message: "소속 업무를 불러오지 못했습니다.",
    });

    await expect(resolveSessionTaskWorkspace({
      session: session("session-unassigned", null),
      boardItems: [],
      currentTasks: [],
      loadTask: vi.fn(),
      fetchImplementation: vi.fn(async () => json({ boardItems: [] })) as typeof globalThis.fetch,
    })).resolves.toMatchObject({ task: null, workspace: { target: { kind: "standalone" } } });
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

function plannerTask(id: string, status: "in_progress" | "completed"): PlannerTask {
  return {
    page: { id, title: id },
    taskId: id,
    status,
  } as PlannerTask;
}

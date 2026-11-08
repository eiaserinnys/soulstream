import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  resolveSessionForOpen,
  resolveSessionFolderWorkspace,
  resolveSessionWorkspace,
  SessionWorkspaceResolutionError,
} from "./v3-session-workspace";
import type { PlannerFolder } from "./planner-data";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("opens the folder named by the session summary without any board lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await resolveSessionWorkspace({
      session: session("session-a", "folder-a"),
    });

    expect(result).toEqual({ target: { kind: "folder", folderId: "folder-a" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens a session without a folder standalone without any board lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await resolveSessionWorkspace({
      session: session("session-a", null),
    });

    expect(result).toEqual({ target: { kind: "standalone" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveSessionFolderWorkspace", () => {
  it("reuses a loaded folder entry for the session folder", async () => {
    const loaded = plannerTask("folder-page", "folder-a", "in_progress");
    const loadFolderById = vi.fn();
    const result = await resolveSessionFolderWorkspace({
      session: session("session-a", "folder-a"),
      currentFolderEntries: [loaded],
      loadFolderById,
    });

    expect(result.task).toBe(loaded);
    expect(loadFolderById).not.toHaveBeenCalled();
  });

  it("target-loads a folder outside the currently loaded entries by its folder id", async () => {
    const target = plannerTask("folder-page", "folder-a", "in_progress");
    const loadFolderById = vi.fn(async () => target);
    const result = await resolveSessionFolderWorkspace({
      session: session("session-a", "folder-a"),
      currentFolderEntries: [],
      loadFolderById,
    });

    expect(result.task).toBe(target);
    expect(loadFolderById).toHaveBeenCalledWith("folder-a");
  });

  it("keeps the owning folder load failure distinct from a truly unassigned session", async () => {
    const promise = resolveSessionFolderWorkspace({
      session: session("session-a", "missing-folder"),
      currentFolderEntries: [],
      loadFolderById: async () => { throw new Error("Not Found"); },
    });
    await expect(promise).rejects.toBeInstanceOf(SessionWorkspaceResolutionError);
    await expect(promise).rejects.toMatchObject({
      phase: "folder",
      message: "소속 폴더를 불러오지 못했습니다.",
    });

    await expect(resolveSessionFolderWorkspace({
      session: session("session-unassigned", null),
      currentFolderEntries: [],
      loadFolderById: vi.fn(),
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

function plannerTask(
  pageId: string,
  folderId: string,
  status: "in_progress" | "completed",
): PlannerFolder {
  return {
    page: { id: pageId, title: pageId },
    folderId,
    status,
  } as PlannerFolder;
}

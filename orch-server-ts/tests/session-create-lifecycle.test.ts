import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  SessionCreateLifecycleError,
  createSessionCreateLifecycle,
  type BoardItemRouteProvider,
  type BoardItemFolderRecord,
  type BoardItemRecord,
  type SessionResourceAccessProvider,
} from "../src/index.js";

describe("session create lifecycle", () => {
  it.each([
    { kind: "runbook", id: "task-a" },
    { kind: "task" },
    { kind: "task", id: "" },
    { kind: "task", id: "   " },
    { kind: "folder", id: 7 },
  ])("rejects malformed container %# before access and board resolution", async (container) => {
    const boardItems = boardItemProvider();
    const access = accessProvider({ restricted: false, allowedFolderIds: [] });
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems,
      access,
    });

    await expect(lifecycle.prepare({
      request: request(),
      body: { prompt: "hello", container },
    })).rejects.toMatchObject({ statusCode: 422, code: "INVALID_REQUEST" });
    expect(access.resolveAccess).not.toHaveBeenCalled();
    expect(boardItems.resolveBoardContainerFolderId).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "folder", id: " folder-a " }, { kind: "folder", id: "folder-a" }],
    [{ kind: "task", id: " task-a " }, { kind: "task", id: "task-a" }],
  ])("normalizes valid container %j", async (container, expected) => {
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems: boardItemProvider(),
      access: accessProvider({ restricted: false, allowedFolderIds: [] }),
    });

    await expect(lifecycle.prepare({ request: request(), body: { prompt: "hello", container } }))
      .resolves.toMatchObject({ payload: { container: expected } });
  });

  it("inherits a source session primary task container and removes sourceSessionId", async () => {
    const boardItems = boardItemProvider({
      boardItems: [{
        id: "session:source",
        folderId: "folder-a",
        containerKind: "task",
        containerId: "task-a",
        membershipKind: "primary",
        itemType: "session",
        itemId: "source",
      }],
    });
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems,
      access: accessProvider({ restricted: false, allowedFolderIds: [] }),
    });

    const prepared = await lifecycle.prepare({
      request: request(),
      body: {
        prompt: "continue",
        folderId: "folder-a",
        sourceSessionId: "source",
      },
    });

    expect(prepared.payload).toMatchObject({
      folderId: "folder-a",
      container: { kind: "task", id: "task-a" },
      caller_info: { source: "browser" },
    });
    expect(prepared.payload).not.toHaveProperty("sourceSessionId");
  });

  it("defaults restricted users to their first allowed folder and rejects forbidden folders", async () => {
    const requireFolderAccess = vi.fn(async ({ folderId }: { folderId: string | null }) => {
      if (folderId === "folder-denied") {
        throw new SessionCreateLifecycleError(
          "SESSION_ACCESS_DENIED",
          "Folder access denied",
          403,
        );
      }
    });
    const access = accessProvider(
      { restricted: true, allowedFolderIds: ["folder-allowed"] },
      requireFolderAccess,
    );
    const lifecycle = createSessionCreateLifecycle({
      resolveCallerInfo: vi.fn(async () => ({ source: "browser" })),
      boardItems: boardItemProvider({
        folders: [
          { id: "folder-allowed" },
          { id: "folder-child", parentFolderId: "folder-allowed" },
        ],
      }),
      access,
    });

    const prepared = await lifecycle.prepare({
      request: request(),
      body: { prompt: "hello" },
    });

    expect(prepared.payload.folderId).toBe("folder-allowed");
    expect(requireFolderAccess).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "folder-allowed",
    }));

    await expect(lifecycle.prepare({
      request: request(),
      body: { prompt: "hello", folderId: "folder-denied" },
    })).rejects.toMatchObject({ statusCode: 403, code: "SESSION_ACCESS_DENIED" });
  });
});

function request(): FastifyRequest {
  return {
    headers: {},
    ip: "203.0.113.9",
  } as unknown as FastifyRequest;
}

function boardItemProvider(input: {
  folders?: readonly BoardItemFolderRecord[];
  boardItems?: readonly BoardItemRecord[];
} = {}): BoardItemRouteProvider {
  const folders = input.folders ?? [];
  const boardItems = input.boardItems ?? [];
  return {
    listFolders: vi.fn(async () => folders),
    listBoardItems: vi.fn(async () => boardItems),
    resolveBoardContainerFolderId: vi.fn(async (container) => {
      if (container.kind === "folder") return container.id;
      const task = boardItems.find((item) =>
        item.itemType === "task" && item.itemId === container.id
      );
      if (typeof task?.folderId !== "string") throw new Error("missing task");
      return task.folderId;
    }),
    getCatalogSnapshot: vi.fn(async () => ({ folders, boardItems })),
  };
}

function accessProvider(
  resolved: { restricted: boolean; allowedFolderIds: readonly string[] },
  requireFolderAccess = vi.fn(async () => undefined),
): SessionResourceAccessProvider {
  return {
    resolveAccess: vi.fn(async () => resolved),
    requireSessionAccess: vi.fn(async () => undefined),
    requireFolderAccess,
  };
}

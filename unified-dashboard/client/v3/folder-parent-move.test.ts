import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import type { PlannerFolder } from "./planner-data";
import { runOptimisticFolderMove } from "./folder-parent-move";

const page = (id: string) => ({ id, title: id }) as PageDto;
const folder = { id: "folder-a", parentFolderId: "parent-a", version: 4 } as CatalogFolder;
const task = {
  page: page("page-a"), blocks: [], stateVector: "", folderId: folder.id, status: "open",
  assignee: "", contextCount: 0, progress: null, parentFolderId: "parent-a",
  sessionIds: [],
} as PlannerFolder;

describe("folder parent move", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves the folder identity through the versioned folder API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ folder: { id: folder.id } }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await runOptimisticFolderMove({ folder, task,
      target: { folderId: "parent-b" }, project: vi.fn() });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/folders/folder-a");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      parentFolderId: "parent-b", expectedVersion: 4, idempotencyKey: expect.any(String),
    });
  });

  it("restores the projected parent after the server rejects the move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("conflict", { status: 409 })));
    const projected: string[] = [];
    await expect(runOptimisticFolderMove({ folder, task,
      target: { folderId: "parent-b" },
      project: (_task, targetFolderId) => projected.push(targetFolderId ?? "root"),
    })).rejects.toThrow("폴더 이동 실패");
    expect(projected).toEqual(["parent-b", "parent-a"]);
  });

  it("rejects an unchanged parent before writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runOptimisticFolderMove({ folder, task,
      target: { folderId: "parent-a" }, project: vi.fn(),
    })).rejects.toThrow("이미 이 폴더");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

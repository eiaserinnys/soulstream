import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageReadResponse } from "@seosoyoung/soul-ui/page";

import {
  defaultFolderMoveTargets,
  searchFolderMoveTargets,
  type FolderMoveTarget,
} from "./folder-move-targets";

describe("task move targets", () => {
  it("keeps the empty-query fallback small, unique, and outside the current task", () => {
    const current = target("current", "rb-current", "현재 폴더");
    const duplicate = target("duplicate", "rb-a", "중복 폴더");

    expect(defaultFolderMoveTargets([
      current,
      target("task-a", "rb-a", "폴더 A"),
      duplicate,
      target("task-b", "rb-b", "폴더 B"),
    ], "rb-current").map((item) => item.folderId)).toEqual(["rb-a", "rb-b"]);
  });

  it("searches all catalog folders and opens only matching pages", async () => {
    const snapshots = new Map([
      ["remote-task", pageRead("remote-task", "화면 밖 폴더", [])],
      ["document", pageRead("document", "일반 문서", [])],
      ["current", pageRead("current", "현재 폴더", [])],
    ]);
    const api = {
      getPage: vi.fn(async (pageId: string) => snapshots.get(pageId)!),
    } as unknown as PageApiClient;
    const folders = [
      { status: "open" as const, version: 1, archived: false, id: "rb-remote", name: "화면 밖 폴더", projectPageId: "remote-task", sortOrder: 0 },
      { status: "open" as const, version: 1, archived: false, id: "rb-current", name: "현재 폴더", projectPageId: "current", sortOrder: 1 },
      { status: "open" as const, version: 1, archived: false, id: "folder-doc", name: "일반 문서", projectPageId: "document", sortOrder: 2 },
    ];

    await expect(searchFolderMoveTargets(api, "  화면 밖  ", "rb-current", folders))
      .resolves.toEqual([target("remote-task", "rb-remote", "화면 밖 폴더")]);
    expect(api.getPage).toHaveBeenCalledWith("remote-task");
    expect(api.getPage).toHaveBeenCalledTimes(1);
  });

  it("does not turn an empty query into an unbounded list request", async () => {
    const api = {
      getPage: vi.fn(),
    } as unknown as PageApiClient;

    await expect(searchFolderMoveTargets(api, "   ", "rb-current", [])).resolves.toEqual([]);
    expect(api.getPage).not.toHaveBeenCalled();
  });
});

function target(id: string, folderId: string, title: string): FolderMoveTarget {
  return { page: pageRead(id, title, []).page, folderId };
}

function pageRead(
  id: string,
  title: string,
  blocks: PageReadResponse["blocks"],
): PageReadResponse {
  return {
    page: {
      id,
      title,
      daily_date: null,
      version: 1,
      archived: false,
      metadata: {},
      created_at: "2026-07-15T00:00:00Z",
      updated_at: "2026-07-15T00:00:00Z",
    },
    blocks,
    state_vector: "AA==",
  };
}

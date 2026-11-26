import { describe, expect, it } from "vitest";
import type { PageReadResponse } from "@seosoyoung/soul-ui/page";

import {
  defaultFolderMoveTargets,
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

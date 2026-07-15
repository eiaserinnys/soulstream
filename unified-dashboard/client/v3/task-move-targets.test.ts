import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageReadResponse } from "@seosoyoung/soul-ui/page";

import {
  defaultTaskMoveTargets,
  searchTaskMoveTargets,
  type TaskMoveTarget,
} from "./task-move-targets";

describe("task move targets", () => {
  it("keeps the empty-query fallback small, unique, and outside the current task", () => {
    const current = target("current", "rb-current", "현재 업무");
    const duplicate = target("duplicate", "rb-a", "중복 업무");

    expect(defaultTaskMoveTargets([
      current,
      target("task-a", "rb-a", "업무 A"),
      duplicate,
      target("task-b", "rb-b", "업무 B"),
    ], "rb-current").map((item) => item.runbookId)).toEqual(["rb-a", "rb-b"]);
  });

  it("uses the bounded page search and returns only primary runbook tasks", async () => {
    const snapshots = new Map([
      ["remote-task", pageRead("remote-task", "화면 밖 업무", [runbookBlock("rb-remote", true)])],
      ["document", pageRead("document", "일반 문서", [])],
      ["secondary", pageRead("secondary", "보조 참조", [runbookBlock("rb-secondary", false)])],
      ["current", pageRead("current", "현재 업무", [runbookBlock("rb-current", true)])],
    ]);
    const api = {
      searchPages: vi.fn(async () => ({
        items: [...snapshots.values()].map(({ page }) => ({ pageId: page.id, title: page.title })),
      })),
      getPage: vi.fn(async (pageId: string) => snapshots.get(pageId)!),
    } as unknown as PageApiClient;

    await expect(searchTaskMoveTargets(api, "  화면 밖  ", "rb-current"))
      .resolves.toEqual([target("remote-task", "rb-remote", "화면 밖 업무")]);
    expect(api.searchPages).toHaveBeenCalledWith("화면 밖", 8);
    expect(api.getPage).toHaveBeenCalledTimes(4);
  });

  it("does not turn an empty query into an unbounded list request", async () => {
    const api = {
      searchPages: vi.fn(),
      getPage: vi.fn(),
    } as unknown as PageApiClient;

    await expect(searchTaskMoveTargets(api, "   ", "rb-current")).resolves.toEqual([]);
    expect(api.searchPages).not.toHaveBeenCalled();
    expect(api.getPage).not.toHaveBeenCalled();
  });
});

function target(id: string, runbookId: string, title: string): TaskMoveTarget {
  return { page: pageRead(id, title, []).page, runbookId };
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

function runbookBlock(runbookId: string, primary: boolean): PageReadResponse["blocks"][number] {
  return {
    id: `block-${runbookId}`,
    page_id: "page",
    parent_id: null,
    position_key: "A",
    block_type: "runbook_ref",
    text: "",
    properties: { runbookId, primary },
    collapsed: false,
  };
}

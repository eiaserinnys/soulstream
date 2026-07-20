import { describe, expect, it, vi } from "vitest";
import type {
  BrowserBacklinkDto,
  PageApiClient,
  PageDto,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import {
  setDailyTaskMembership,
  toggleDailyTaskMembership,
} from "./daily-task-membership";

describe("daily task membership", () => {
  it("treats an alias mount as the same task by target page id", async () => {
    const api = membershipApi({
      blocks: [mountBlock("mount-alias", "[[대시보드 개선]]")],
      mountBlockIds: ["mount-alias"],
    });

    await expect(setDailyTaskMembership({
      api,
      dailyPageId: "daily-today",
      taskPage: taskPage(),
      present: true,
      idempotencyKey: () => "add-alias",
      reason: "test add",
    })).resolves.toBe("unchanged");

    expect(api.getBacklinks).toHaveBeenCalledWith("task-pages", {
      kinds: ["mount"],
      limit: 50,
    });
    expect(api.applyOperations).not.toHaveBeenCalled();
  });

  it("removes every matching mount in one page CAS mutation", async () => {
    const api = membershipApi({
      blocks: [
        mountBlock("mount-alias", "[[대시보드 개선]]"),
        mountBlock("mount-canonical", "[[Pages 대시보드 개선]]"),
      ],
      mountBlockIds: ["mount-alias", "mount-canonical"],
    });

    await expect(setDailyTaskMembership({
      api,
      dailyPageId: "daily-today",
      taskPage: taskPage(),
      present: false,
      idempotencyKey: () => "remove-all",
      reason: "test remove",
    })).resolves.toBe("removed");

    expect(api.applyOperations).toHaveBeenCalledWith("daily-today", {
      expectedVersion: 4,
      expectedStateVector: new Uint8Array([1, 2, 3]),
      idempotencyKey: "remove-all",
      reason: "test remove",
      operations: [
        { op: "delete_block_subtree", block_id: "mount-alias" },
        { op: "delete_block_subtree", block_id: "mount-canonical" },
      ],
    });
  });

  it("keeps remove-add-remove cycles at zero or one physical mount", async () => {
    const state = statefulMembershipApi();
    const input = {
      api: state.api,
      dailyPageId: "daily-today",
      taskPage: taskPage(),
      idempotencyKey: () => `cycle-${state.mutationCount() + 1}`,
      reason: "test cycle",
    };

    await expect(toggleDailyTaskMembership(input)).resolves.toBe("removed");
    expect(state.mountCount()).toBe(0);
    await expect(toggleDailyTaskMembership(input)).resolves.toBe("added");
    expect(state.mountCount()).toBe(1);
    await expect(toggleDailyTaskMembership(input)).resolves.toBe("removed");
    expect(state.mountCount()).toBe(0);
  });
});

function taskPage(): Pick<PageDto, "id" | "title"> {
  return { id: "task-pages", title: "Pages 대시보드 개선" };
}

function mountBlock(id: string, text: string): PageReadResponse["blocks"][number] {
  return {
    id,
    page_id: "daily-today",
    parent_id: null,
    position_key: id,
    block_type: "paragraph",
    text,
    properties: {},
    collapsed: false,
  };
}

function backlink(sourceBlockId: string): BrowserBacklinkDto {
  return {
    id: `link-${sourceBlockId}`,
    sourcePageId: "daily-today",
    sourcePageTitle: "2026년 7월 20일",
    sourceBlockId,
    sourceTextPreview: "",
    linkKind: "mount",
    targetPageId: "task-pages",
    targetBlockId: null,
    sourceStart: 0,
    sourceEnd: 1,
  };
}

function membershipApi(input: {
  blocks: PageReadResponse["blocks"];
  mountBlockIds: string[];
}): PageApiClient {
  return {
    getPage: vi.fn(async () => pageRead(input.blocks)),
    getBacklinks: vi.fn(async () => ({
      items: input.mountBlockIds.map(backlink),
      nextCursor: null,
    })),
    applyOperations: vi.fn(async () => ({
      ...pageRead(input.blocks),
      operation: { id: "operation" },
      temp_id_mapping: {},
    })),
  } as unknown as PageApiClient;
}

function statefulMembershipApi() {
  let version = 4;
  let mutations = 0;
  let blocks = [mountBlock("mount-alias", "[[대시보드 개선]]")];
  const api = {
    getPage: vi.fn(async () => pageRead(blocks, version)),
    getBacklinks: vi.fn(async () => ({
      items: blocks.map((block) => backlink(block.id)),
      nextCursor: null,
    })),
    applyOperations: vi.fn(async (_pageId: string, input: {
      operations: Array<{ op: string; block_id?: string; text?: string }>;
    }) => {
      for (const operation of input.operations) {
        if (operation.op === "delete_block_subtree") {
          blocks = blocks.filter((block) => block.id !== operation.block_id);
        } else if (operation.op === "create_block") {
          blocks = [...blocks, mountBlock(`mount-${mutations + 1}`, operation.text ?? "")];
        }
      }
      mutations += 1;
      version += 1;
      return {
        ...pageRead(blocks, version),
        operation: { id: `operation-${mutations}` },
        temp_id_mapping: {},
      };
    }),
  } as unknown as PageApiClient;
  return {
    api,
    mountCount: () => blocks.length,
    mutationCount: () => mutations,
  };
}

function pageRead(blocks: PageReadResponse["blocks"], version = 4): PageReadResponse {
  return {
    page: {
      id: "daily-today",
      title: "2026년 7월 20일",
      daily_date: "2026-07-20",
      version,
      archived: false,
      metadata: {},
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z",
    },
    blocks,
    state_vector: "AQID",
  };
}

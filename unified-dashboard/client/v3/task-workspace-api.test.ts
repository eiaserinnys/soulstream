import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  renameTaskTitle,
  saveTaskSessionDefaults,
  unmountTaskDocument,
} from "./task-workspace-api";

describe("renameTaskTitle", () => {
  it("renames the task through the page CAS contract used by the task identity service", async () => {
    const taskPage = page("task-a", "변경 전", 5);
    const renamedPage = page("task-a", "변경 후", 6);
    const api = {
      getPage: vi.fn(async () => ({
        page: taskPage,
        state_vector: "AQ==",
        blocks: [],
      })),
      applyOperations: vi.fn(async () => ({
        page: renamedPage,
        blocks: [],
        operation: { id: "rename-task" },
        temp_id_mapping: {},
      })),
    } as unknown as PageApiClient;

    await expect(renameTaskTitle(api, taskPage.id, "  변경 후  ", () => "rename-1"))
      .resolves.toEqual(renamedPage);

    expect(api.applyOperations).toHaveBeenCalledWith(taskPage.id, {
      expectedVersion: 5,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "rename-1",
      reason: "v3 task identity title rename",
      operations: [{ op: "rename_page", title: "변경 후" }],
    });
  });

  it("rejects an empty title without issuing a mutation", async () => {
    const api = {
      getPage: vi.fn(),
      applyOperations: vi.fn(),
    } as unknown as PageApiClient;

    await expect(renameTaskTitle(api, "task-a", "   ", () => "rename-1"))
      .rejects.toThrow("업무 제목을 입력해야 합니다");
    expect(api.getPage).not.toHaveBeenCalled();
    expect(api.applyOperations).not.toHaveBeenCalled();
  });
});

describe("saveTaskSessionDefaults", () => {
  it("creates a direct session_defaults block through the existing page CAS surface", async () => {
    const taskPage = page("task-a", "업무 A", 5);
    const blocks = [block("paragraph", "paragraph")];
    const saved = [...blocks, block("defaults-created", "session_defaults", {
      agentId: "roselin_codex",
      nodeId: "eiaserinnys",
      scope: "session",
    })];
    const api = pageApi(taskPage, blocks, saved);

    await expect(saveTaskSessionDefaults(api, taskPage.id, {
      blockId: null,
      agentId: " roselin_codex ",
      nodeId: " eiaserinnys ",
    }, (prefix) => `${prefix}-1`)).resolves.toEqual({ blocks: saved });

    expect(api.applyOperations).toHaveBeenCalledWith(taskPage.id, {
      expectedVersion: 5,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "session-defaults-save-1",
      reason: "v3 task session defaults save",
      operations: [{
        op: "create_block",
        temp_id: "session-defaults-block-1",
        parent_id: null,
        after_block_id: "paragraph",
        block_type: "session_defaults",
        text: "",
        properties: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
          scope: "session",
        },
        collapsed: false,
      }],
    });
  });

  it("updates the existing direct block and rejects an empty explicit value", async () => {
    const taskPage = page("task-a", "업무 A", 5);
    const defaults = block("defaults-direct", "session_defaults", {
      agentId: "old-agent",
      nodeId: "old-node",
      scope: "session",
    });
    const api = pageApi(taskPage, [defaults], [defaults]);

    await saveTaskSessionDefaults(api, taskPage.id, {
      blockId: defaults.id,
      agentId: "new-agent",
      nodeId: null,
    }, (prefix) => `${prefix}-2`);

    expect(api.applyOperations).toHaveBeenCalledWith(taskPage.id, expect.objectContaining({
      operations: [{
        op: "update_block_type_and_properties",
        block_id: defaults.id,
        block_type: "session_defaults",
        properties: { agentId: "new-agent", nodeId: null, scope: "session" },
      }],
    }));

    await expect(saveTaskSessionDefaults(api, taskPage.id, {
      blockId: defaults.id,
      agentId: " ",
      nodeId: null,
    })).rejects.toThrow("에이전트 또는 노드를 선택해야 합니다");
  });
});

describe("unmountTaskDocument", () => {
  it("deletes the mounted document block through the page CAS contract", async () => {
    const taskPage = page("task-a", "업무 A", 5);
    const api = {
      getPage: vi.fn(async () => ({
        page: taskPage,
        state_vector: "AQ==",
        blocks: [{
          id: "mount-doc",
          page_id: taskPage.id,
          parent_id: null,
          position_key: "A",
          block_type: "paragraph",
          text: "[[문서 A]]",
          properties: {},
          collapsed: false,
        }],
      })),
      applyOperations: vi.fn(async () => ({
        page: { ...taskPage, version: 6 },
        blocks: [],
        operation: { id: "delete-mount" },
        temp_id_mapping: {},
      })),
    } as unknown as PageApiClient;

    await unmountTaskDocument(api, taskPage.id, "mount-doc", () => "unmount-1");

    expect(api.applyOperations).toHaveBeenCalledWith(taskPage.id, {
      expectedVersion: 5,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "unmount-1",
      reason: "v3 task document unmount",
      operations: [{ op: "delete_block_subtree", block_id: "mount-doc" }],
    });
  });
});

function page(id: string, title: string, version: number): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

function block(id: string, blockType: string, properties: Record<string, unknown> = {}) {
  return {
    id,
    page_id: "task-a",
    parent_id: null,
    position_key: id,
    block_type: blockType,
    text: "",
    properties,
    collapsed: false,
  };
}

function pageApi(taskPage: PageDto, blocks: ReturnType<typeof block>[], saved: ReturnType<typeof block>[]) {
  return {
    getPage: vi.fn(async () => ({ page: taskPage, state_vector: "AQ==", blocks })),
    applyOperations: vi.fn(async () => ({
      page: { ...taskPage, version: taskPage.version + 1 },
      blocks: saved,
      operation: { id: "save-defaults" },
      temp_id_mapping: {},
    })),
  } as unknown as PageApiClient & { applyOperations: ReturnType<typeof vi.fn> };
}

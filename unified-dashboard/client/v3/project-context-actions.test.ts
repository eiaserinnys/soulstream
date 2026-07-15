import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto, PageMutationResponse } from "@seosoyoung/soul-ui/page";

import {
  deleteProjectContextBlock,
  saveProjectAtomReference,
  saveProjectGuidance,
  saveProjectSessionDefaults,
} from "./project-context-actions";

describe("project context page mutations", () => {
  it("updates guidance text with fresh version, state vector, and tool:caller:request idempotency", async () => {
    const api = pageApi([block("guidance", "기존", { enabled: true, scope: "project" })]);

    await saveProjectGuidance(api, "project", {
      blockId: "guidance",
      text: "새 지침",
    }, () => "request-1");

    expect(api.applyOperations).toHaveBeenCalledWith("project", {
      expectedVersion: 7,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "v3-project-context:browser:request-1",
      reason: "v3 project guidance save",
      operations: [{ op: "update_block_text", block_id: "guidance", text: "새 지침" }],
    });
  });

  it("creates guidance after the last root block when none exists", async () => {
    const api = pageApi([block("paragraph", "본문", {})]);

    await saveProjectGuidance(api, "project", { blockId: null, text: "추가 지침" }, () => "request-2");

    expect(api.applyOperations).toHaveBeenCalledWith("project", expect.objectContaining({
      operations: [expect.objectContaining({
        op: "create_block",
        after_block_id: "paragraph",
        block_type: "guidance",
        text: "추가 지침",
        properties: { enabled: true, scope: "project" },
      })],
    }));
  });

  it("updates atom properties, validates depth 1..5, and supports deletion", async () => {
    const api = pageApi([block("atom", "", {
      instance: "atom",
      nodeId: "old",
      nodeTitle: "기존",
      depth: 3,
      titlesOnly: false,
    }, "atom_ref")]);

    await saveProjectAtomReference(api, "project", {
      blockId: "atom",
      nodeId: "new-node",
      nodeTitle: "새 노드",
      depth: 5,
      titlesOnly: true,
    }, () => "request-3");
    expect(api.applyOperations).toHaveBeenLastCalledWith("project", expect.objectContaining({
      operations: [{
        op: "update_block_type_and_properties",
        block_id: "atom",
        block_type: "atom_ref",
        properties: {
          instance: "atom",
          nodeId: "new-node",
          nodeTitle: "새 노드",
          depth: 5,
          titlesOnly: true,
        },
      }],
    }));

    await expect(saveProjectAtomReference(api, "project", {
      blockId: "atom",
      nodeId: "node",
      nodeTitle: "노드",
      depth: 6,
      titlesOnly: false,
    }, () => "invalid")).rejects.toThrow("1~5");

    await deleteProjectContextBlock(api, "project", "atom", () => "request-4");
    expect(api.applyOperations).toHaveBeenLastCalledWith("project", expect.objectContaining({
      operations: [{ op: "delete_block_subtree", block_id: "atom" }],
    }));
  });

  it("creates project-scoped session defaults through the same CAS path", async () => {
    const api = pageApi([]);

    await saveProjectSessionDefaults(api, "project", {
      blockId: null,
      agentId: "roselin_codex",
      nodeId: "eiaserinnys",
    }, () => "request-5");

    expect(api.applyOperations).toHaveBeenCalledWith("project", expect.objectContaining({
      operations: [expect.objectContaining({
        op: "create_block",
        block_type: "session_defaults",
        properties: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
          scope: "project",
        },
      })],
    }));
  });
});

function pageApi(blocks: ReturnType<typeof block>[]): PageApiClient {
  const current = page();
  const response: PageMutationResponse = {
    page: { ...current, version: 8 },
    blocks,
    operation: { id: "op" },
    temp_id_mapping: {},
  };
  return {
    getPage: vi.fn(async () => ({ page: current, blocks, state_vector: "AQ==" })),
    applyOperations: vi.fn(async () => response),
  } as unknown as PageApiClient;
}

function page(): PageDto {
  return {
    id: "project",
    title: "프로젝트",
    daily_date: null,
    version: 7,
    archived: false,
    metadata: {},
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

function block(id: string, text: string, properties: Record<string, unknown>, blockType = id) {
  return {
    id,
    page_id: "project",
    parent_id: null,
    position_key: id,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}

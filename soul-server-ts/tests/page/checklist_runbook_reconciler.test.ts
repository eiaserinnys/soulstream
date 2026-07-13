import { describe, expect, it, vi } from "vitest";

import {
  ChecklistRunbookReconciler,
  type ChecklistProjectionOutboxRow,
} from "../../src/page/checklist_runbook_reconciler.js";

const row: ChecklistProjectionOutboxRow = {
  block_id: "block-1",
  page_id: "page-1",
  source_hash: "source-1",
  actor_kind: "user",
  actor_session_id: null,
  actor_user_id: "operator@example.com",
  routing_session_id: "sess-route",
  attempts: 0,
};

function harness(block: Record<string, unknown> | null = {
  id: "block-1",
  block_type: "checklist",
  text: "Ship it",
  properties: { checked: true },
}) {
  const repository = {
    claimDue: vi.fn(async () => [row]),
    markSuccess: vi.fn(async () => true),
    markFailure: vi.fn(async () => undefined),
  };
  const adapter = {
    reconcile: vi.fn(async () => ({
      properties: { runbookId: "page-runbook:page-1", itemId: "checklist:block-1" },
      status: "completed" as const,
      checked: true,
    })),
    archive: vi.fn(async () => undefined),
  };
  const pageHost = {
    getPage: vi.fn(async () => ({
      page: { id: "page-1", title: "Page", version: 7, metadata: {} },
      blocks: block ? [block] : [],
    })),
    batchPageOperations: vi.fn(async () => ({
      page: { id: "page-1", version: 8 },
      blocks: [],
      temp_id_mapping: {},
      operation: {},
    })),
  };
  const logger = { warn: vi.fn(), info: vi.fn() };
  return {
    repository,
    adapter,
    pageHost,
    reconciler: new ChecklistRunbookReconciler({
      nodeId: "node-1",
      repository,
      adapter,
      pageHost,
      logger,
    }),
  };
}

describe("ChecklistRunbookReconciler", () => {
  it("replays a durable legacy checklist and writes only the bound reference", async () => {
    const h = harness();

    await h.reconciler.reconcileDue();

    expect(h.adapter.reconcile).toHaveBeenCalledWith({
      page: { id: "page-1", title: "Page", metadata: {} },
      block: {
        id: "block-1",
        text: "Ship it",
        properties: { checked: true },
      },
      actor: {
        actorKind: "user",
        actorSessionId: "sess-route",
        actorUserId: "operator@example.com",
      },
    });
    expect(h.pageHost.batchPageOperations).toHaveBeenCalledWith({
      page_id: "page-1",
      expected_version: 7,
      operations: [{
        op: "update_block_type_and_properties",
        block_id: "block-1",
        block_type: "checklist",
        properties: {
          runbookId: "page-runbook:page-1",
          itemId: "checklist:block-1",
        },
      }],
      actor_session_id: "sess-route",
      idempotency_key: expect.stringContaining("source-1"),
    });
    expect(h.repository.markSuccess).toHaveBeenCalledWith(row, "node-1");
  });

  it("archives the deterministic item when the checklist disappeared", async () => {
    const h = harness(null);

    await h.reconciler.reconcileDue();

    expect(h.adapter.archive).toHaveBeenCalledWith({
      pageId: "page-1",
      blockId: "block-1",
      actor: {
        actorKind: "user",
        actorSessionId: "sess-route",
        actorUserId: "operator@example.com",
      },
    });
    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();
  });

  it("retains transient failures for restart replay", async () => {
    const h = harness();
    h.adapter.reconcile.mockRejectedValueOnce(new Error("temporary runbook failure"));

    await h.reconciler.reconcileDue();

    expect(h.repository.markFailure).toHaveBeenCalledWith(
      row,
      "node-1",
      "temporary runbook failure",
    );
    expect(h.repository.markSuccess).not.toHaveBeenCalled();
  });
});

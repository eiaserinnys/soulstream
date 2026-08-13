import { describe, expect, it, vi } from "vitest";
import { validatePageBlockProperties } from "@soulstream/page-model";

import {
  ChecklistTaskReconciler,
  type ChecklistProjectionOutboxRow,
} from "../../src/page/checklist_task_reconciler.js";
import { ChecklistBindingMismatchError } from
  "../../src/page/checklist_task_adapter.js";
import { PageYjsHostClientError } from "../../src/page/page_host_client.js";
import { TaskIdentityHostClientError } from "../../src/work-task/task_identity_host_client.js";

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
    markDeadLetter: vi.fn(async () => true),
  };
  const adapter = {
    reconcile: vi.fn(async () => ({
      properties: { taskId: "page-task:page-1", itemId: "checklist:block-1" },
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
    batchPageOperations: vi.fn(async (input: Record<string, unknown>) => {
      const operation = (input.operations as Array<{
        block_type: string;
        properties: Record<string, unknown>;
      }>)[0]!;
      const validationError = validatePageBlockProperties(
        operation.block_type,
        operation.properties,
      );
      if (validationError) throw new Error(validationError);
      return {
        page: { id: "page-1", version: 8 },
        blocks: [],
        temp_id_mapping: {},
        operation: {},
      };
    }),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  return {
    repository,
    adapter,
    pageHost,
    logger,
    reconciler: new ChecklistTaskReconciler({
      nodeId: "node-1",
      repository,
      adapter,
      pageHost,
      logger,
    }),
  };
}

describe("ChecklistTaskReconciler", () => {
  it("replays a durable legacy checklist through the canonical page property contract", async () => {
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
        actorSessionId: null,
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
          checked: true,
          taskId: "page-task:page-1",
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
        actorSessionId: null,
        actorUserId: "operator@example.com",
      },
    });
    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();
  });

  it("retains transient failures for restart replay", async () => {
    const h = harness();
    h.adapter.reconcile.mockRejectedValueOnce(new Error("temporary task failure"));

    await h.reconciler.reconcileDue();

    expect(h.repository.markFailure).toHaveBeenCalledWith(
      row,
      "node-1",
      "temporary task failure",
    );
    expect(h.repository.markSuccess).not.toHaveBeenCalled();
  });

  it("dead-letters a permanent binding mismatch instead of retrying forever", async () => {
    const h = harness();
    h.adapter.reconcile.mockRejectedValueOnce(
      new ChecklistBindingMismatchError("stored checklist task not found: task-missing"),
    );

    await h.reconciler.reconcileDue();

    expect(h.repository.markDeadLetter).toHaveBeenCalledWith(
      row,
      "node-1",
      "stored checklist task not found: task-missing",
    );
    expect(h.repository.markFailure).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "page-1",
        blockId: "block-1",
        attempts: 1,
        reason: "permanent_error",
      }),
      "checklist Task projection dead-lettered",
    );
  });

  it("uses typed task identity conflicts to decide retry versus dead-letter", async () => {
    const retryableCodes = [
      "TASK_IDENTITY_CREATE_COLLISION",
      "TASK_IDENTITY_ALREADY_PROMOTED",
      "TASK_IDENTITY_STALE_PLAN_CONFLICT",
    ];
    for (const code of retryableCodes) {
      const h = harness();
      h.adapter.reconcile.mockRejectedValueOnce(
        new TaskIdentityHostClientError(code, 409, code, {}),
      );
      await h.reconciler.reconcileDue();
      expect(h.repository.markFailure).toHaveBeenCalledTimes(1);
      expect(h.repository.markDeadLetter).not.toHaveBeenCalled();
    }

    const permanent = harness();
    permanent.adapter.reconcile.mockRejectedValueOnce(
      new TaskIdentityHostClientError(
        "TASK_IDENTITY_BINDING_CONFLICT",
        409,
        "binding conflict",
        {},
      ),
    );
    await permanent.reconciler.reconcileDue();
    expect(permanent.repository.markDeadLetter).toHaveBeenCalledTimes(1);
    expect(permanent.repository.markFailure).not.toHaveBeenCalled();
  });

  it("dead-letters a page property contract rejection without another retry", async () => {
    const h = harness();
    h.pageHost.batchPageOperations.mockRejectedValueOnce(
      new PageYjsHostClientError(
        "PAGE_MUTATION_INVALID",
        422,
        "checklist.checked must be a boolean",
        {},
      ),
    );

    await h.reconciler.reconcileDue();

    expect(h.repository.markDeadLetter).toHaveBeenCalledTimes(1);
    expect(h.repository.markFailure).not.toHaveBeenCalled();
  });

  it("dead-letters an unclassified failure after the finite retry budget", async () => {
    const h = harness();
    const exhausted = { ...row, attempts: 7 };
    h.repository.claimDue.mockResolvedValueOnce([exhausted]);
    h.adapter.reconcile.mockRejectedValueOnce(new Error("unknown persistent failure"));

    await h.reconciler.reconcileDue();

    expect(h.repository.markDeadLetter).toHaveBeenCalledWith(
      exhausted,
      "node-1",
      "unknown persistent failure",
    );
    expect(h.repository.markFailure).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 8, reason: "attempts_exhausted" }),
      "checklist Task projection dead-lettered",
    );
  });

  it("keeps routing_session_id out of llm audit provenance", async () => {
    const h = harness();
    h.repository.claimDue.mockResolvedValueOnce([{
      ...row,
      actor_kind: "llm",
      actor_session_id: null,
      actor_user_id: null,
      routing_session_id: "sess-route",
    }]);

    await h.reconciler.reconcileDue();

    expect(h.adapter.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          actorKind: "llm",
          actorSessionId: null,
        },
      }),
    );
    expect(h.pageHost.batchPageOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_session_id: "sess-route",
      }),
    );
  });
});

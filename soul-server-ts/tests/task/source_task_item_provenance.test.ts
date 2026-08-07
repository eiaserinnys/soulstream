import { describe, expect, it, vi } from "vitest";

import type { TaskSnapshot } from "../../src/db/session_db.js";
import { resolveSourceTaskItemProvenance } from "../../src/task/source_task_item_provenance.js";

function snapshotWithItems(...ids: string[]): TaskSnapshot {
  return {
    task: { id: "task-1" },
    sections: [],
    items: ids.map((id) => ({ id })),
  } as TaskSnapshot;
}

function makeHarness(snapshot: TaskSnapshot | null = snapshotWithItems("valid-item")) {
  const getTaskSnapshot = vi.fn().mockResolvedValue(snapshot);
  const logger = { warn: vi.fn() };
  const resolve = (input: {
    sessionId?: string;
    sourceTaskItemId?: string | null;
    container?: { containerKind: "folder" | "task"; containerId: string } | null;
  }) => resolveSourceTaskItemProvenance({
    sessionId: input.sessionId ?? "session-1",
    sourceTaskItemId: input.sourceTaskItemId,
    container: input.container,
    getTaskSnapshot,
    logger,
  });
  return { getTaskSnapshot, logger, resolve };
}

describe("resolveSourceTaskItemProvenance", () => {
  it("preserves an existing slug source item", async () => {
    const h = makeHarness(snapshotWithItems("p13-integrity-constraint"));

    await expect(h.resolve({
      sourceTaskItemId: "p13-integrity-constraint",
      container: { containerKind: "task", containerId: "task-1" },
    })).resolves.toBe("p13-integrity-constraint");

    expect(h.getTaskSnapshot).toHaveBeenCalledWith("task-1");
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("drops an unknown source item with a structured warning", async () => {
    const h = makeHarness();

    await expect(h.resolve({
      sessionId: "session-unknown-source",
      sourceTaskItemId: "truncated-item-id",
      container: { containerKind: "task", containerId: "task-1" },
    })).resolves.toBeNull();

    expect(h.logger.warn).toHaveBeenCalledWith({
      sessionId: "session-unknown-source",
      sourceTaskItemId: "truncated-item-id",
      taskId: "task-1",
      reason: "task_item_not_found",
    }, "source task item provenance rejected; continuing without provenance");
  });

  it("drops provenance when its task cannot be verified", async () => {
    const h = makeHarness();
    const validationError = new Error("task host unavailable");
    h.getTaskSnapshot.mockRejectedValueOnce(validationError);

    await expect(h.resolve({
      sessionId: "session-source-validation-failed",
      sourceTaskItemId: "valid-item",
      container: { containerKind: "task", containerId: "task-1" },
    })).resolves.toBeNull();

    expect(h.logger.warn).toHaveBeenCalledWith({
      err: validationError,
      sessionId: "session-source-validation-failed",
      sourceTaskItemId: "valid-item",
      taskId: "task-1",
      reason: "validation_failed",
    }, "source task item provenance rejected; continuing without provenance");
  });

  it("drops provenance that is not scoped to a task container", async () => {
    const h = makeHarness();

    await expect(h.resolve({
      sessionId: "session-unscoped-source",
      sourceTaskItemId: "valid-item",
      container: { containerKind: "folder", containerId: "folder-1" },
    })).resolves.toBeNull();

    expect(h.getTaskSnapshot).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith({
      sessionId: "session-unscoped-source",
      sourceTaskItemId: "valid-item",
      taskId: null,
      reason: "task_container_missing",
    }, "source task item provenance rejected; continuing without provenance");
  });

  it("does not query or warn when provenance is absent", async () => {
    const h = makeHarness();

    await expect(h.resolve({ sourceTaskItemId: null })).resolves.toBeNull();

    expect(h.getTaskSnapshot).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

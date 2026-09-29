import { describe, expect, it, vi } from "vitest";

import type { FolderSnapshot } from "../../src/db/session_db.js";
import { resolveSourceChecklistItemProvenance } from "../../src/task/source_task_item_provenance.js";

function snapshotWithItems(...ids: string[]): FolderSnapshot {
  return {
    folder: { id: "folder-1" },
    sections: [],
    items: ids.map((id) => ({ id })),
  } as FolderSnapshot;
}

function makeHarness(snapshot: FolderSnapshot | null = snapshotWithItems("valid-item")) {
  const getFolderSnapshot = vi.fn().mockResolvedValue(snapshot);
  const logger = { warn: vi.fn() };
  const resolve = (input: {
    sessionId?: string;
    sourceChecklistItemId?: string | null;
    folderId?: string | null;
  }) => resolveSourceChecklistItemProvenance({
    sessionId: input.sessionId ?? "session-1",
    sourceChecklistItemId: input.sourceChecklistItemId,
    folderId: input.folderId,
    getFolderSnapshot,
    logger,
  });
  return { getFolderSnapshot, logger, resolve };
}

describe("resolveSourceChecklistItemProvenance", () => {
  it("preserves an item that belongs to the folder", async () => {
    const h = makeHarness(snapshotWithItems("valid-item"));
    await expect(h.resolve({ sourceChecklistItemId: "valid-item", folderId: "folder-1" }))
      .resolves.toBe("valid-item");
    expect(h.getFolderSnapshot).toHaveBeenCalledWith("folder-1");
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("drops an unknown item with a structured warning", async () => {
    const h = makeHarness();
    await expect(h.resolve({ sessionId: "session-2", sourceChecklistItemId: "missing", folderId: "folder-1" }))
      .resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledWith({
      sessionId: "session-2", sourceChecklistItemId: "missing",
      folderId: "folder-1", reason: "checklist_item_not_found",
    }, "source checklist item provenance rejected; continuing without provenance");
  });

  it("drops provenance if the folder cannot be verified", async () => {
    const h = makeHarness();
    h.getFolderSnapshot.mockRejectedValueOnce(new Error("host unavailable"));
    await expect(h.resolve({ sourceChecklistItemId: "valid-item", folderId: "folder-1" }))
      .resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: "validation_failed", folderId: "folder-1",
    }), expect.any(String));
  });

  it("does not query when the source item is absent", async () => {
    const h = makeHarness();
    await expect(h.resolve({ sourceChecklistItemId: null })).resolves.toBeNull();
    expect(h.getFolderSnapshot).not.toHaveBeenCalled();
  });
});

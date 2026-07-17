import { describe, expect, it, vi } from "vitest";

import { notifyPageUpdates } from "../../src/page/page_update_notifications.js";

describe("page update notifications", () => {
  it("emits one notification per committed page and skips idempotent results", () => {
    const notify = vi.fn();

    notifyPageUpdates([
      { page: { id: "page-1", version: 2 } },
      { page: { id: "page-1", version: 2 } },
      { page: { id: "page-2", version: 4 } },
      { page: { id: "page-3", version: 8 }, idempotent: true },
    ], notify);

    expect(notify.mock.calls).toEqual([
      [{ pageId: "page-1", version: 2 }],
      [{ pageId: "page-2", version: 4 }],
    ]);
  });

  it("does not let an observer failure escape a committed mutation", () => {
    const error = new Error("observer unavailable");
    const logger = { error: vi.fn() };

    expect(() => notifyPageUpdates(
      [{ page: { id: "page-1", version: 2 } }],
      () => { throw error; },
      logger,
    )).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      { err: error, pageId: "page-1", version: 2 },
      "Page update notification failed after commit",
    );
  });
});

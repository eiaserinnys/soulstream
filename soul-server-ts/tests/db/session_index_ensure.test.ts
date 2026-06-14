import { describe, expect, it, vi } from "vitest";

import { ensureStableSessionOrderIndexInBackground } from "../../src/db/session_index_ensure.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("ensureStableSessionOrderIndexInBackground", () => {
  it("starts the index ensure without awaiting the caller path", async () => {
    let resolveEnsure: (() => void) | undefined;
    const db = {
      ensureStableSessionOrderIndex: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveEnsure = resolve;
          }),
      ),
    };
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    ensureStableSessionOrderIndexInBackground(db, logger as never);

    expect(db.ensureStableSessionOrderIndex).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    resolveEnsure?.();
    await flushMicrotasks();

    expect(logger.info).toHaveBeenCalledWith(
      "Stable session order index ensure completed",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs index ensure failure without rethrowing an unhandled rejection", async () => {
    const err = new Error("boom");
    const db = {
      ensureStableSessionOrderIndex: vi.fn().mockRejectedValue(err),
    };
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    expect(() => {
      ensureStableSessionOrderIndexInBackground(db, logger as never);
    }).not.toThrow();

    await flushMicrotasks();

    expect(logger.error).toHaveBeenCalledWith(
      { err },
      "Stable session order index ensure failed; continuing without index",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

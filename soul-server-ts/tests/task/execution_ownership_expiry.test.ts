import { describe, expect, it, vi } from "vitest";

import type { CanonicalExecutionOwnership } from "../../src/task/execution_ownership.js";
import { ExecutionOwnershipExpiry } from "../../src/task/execution_ownership_expiry.js";

function ownership(
  overrides: Partial<CanonicalExecutionOwnership> = {},
): CanonicalExecutionOwnership {
  return {
    ownershipGeneration: 7,
    ownerKind: "spawned_runner",
    manifestId: "manifest-1",
    runtimeEnvIdentity: "env-1",
    registrationId: "registration-1",
    pid: 968_764,
    startIdentity: "start-1",
    executionCommandId: "command-1",
    phase: "active",
    failureReason: null,
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("ExecutionOwnershipExpiry", () => {
  /**
   * 260820 incident: the owning process died holding an active reservation.
   * Every later attempt lost the CAS, and the compensation path failed its own
   * generation — never the stuck one — so nothing could ever converge.
   */
  it("fails the stuck owner's generation, not the caller's", async () => {
    const fail = vi.fn().mockResolvedValue({ applied: true });
    const expiry = new ExecutionOwnershipExpiry({
      fail,
      isProcessAlive: () => false,
      logger: makeLogger(),
    });

    await expect(expiry.expireIfOwnerIsGone("session-a", ownership()))
      .resolves.toBe("expired");
    expect(fail).toHaveBeenCalledWith(
      "session-a",
      7,
      expect.stringContaining("968764"),
    );
  });

  it("leaves a live owner alone", async () => {
    const fail = vi.fn();
    const expiry = new ExecutionOwnershipExpiry({
      fail,
      isProcessAlive: () => true,
      logger: makeLogger(),
    });

    await expect(expiry.expireIfOwnerIsGone("session-a", ownership()))
      .resolves.toBe("owner_alive");
    expect(fail).not.toHaveBeenCalled();
  });

  it("refuses to guess when the owner pid is unknown", async () => {
    const fail = vi.fn();
    const expiry = new ExecutionOwnershipExpiry({
      fail,
      isProcessAlive: () => false,
      logger: makeLogger(),
    });

    await expect(expiry.expireIfOwnerIsGone("session-a", ownership({ pid: null })))
      .resolves.toBe("owner_unknown");
    await expect(expiry.expireIfOwnerIsGone("session-a", undefined))
      .resolves.toBe("owner_unknown");
    expect(fail).not.toHaveBeenCalled();
  });

  it("leaves an already terminal ownership alone", async () => {
    const fail = vi.fn();
    const expiry = new ExecutionOwnershipExpiry({
      fail,
      isProcessAlive: () => false,
      logger: makeLogger(),
    });

    await expect(
      expiry.expireIfOwnerIsGone("session-a", ownership({ phase: "failed" })),
    ).resolves.toBe("owner_unknown");
    expect(fail).not.toHaveBeenCalled();
  });

  it("reports a rejected or throwing expiry instead of claiming success", async () => {
    const logger = makeLogger();
    const rejecting = new ExecutionOwnershipExpiry({
      fail: vi.fn().mockResolvedValue({ applied: false }),
      isProcessAlive: () => false,
      logger,
    });
    await expect(rejecting.expireIfOwnerIsGone("session-a", ownership()))
      .resolves.toBe("not_applied");

    const throwing = new ExecutionOwnershipExpiry({
      fail: vi.fn().mockRejectedValue(new Error("host unavailable")),
      isProcessAlive: () => false,
      logger,
    });
    await expect(throwing.expireIfOwnerIsGone("session-a", ownership()))
      .resolves.toBe("not_applied");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

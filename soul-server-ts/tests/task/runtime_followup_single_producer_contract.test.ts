import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorMaintenanceService } from
  "../../../orch-server-ts/src/runtime/orchestrator_maintenance_service.js";

afterEach(() => {
  vi.useRealTimers();
});

function maintenanceWithRetiredProducer(
  recoverPendingImmediateDeliveries: () => Promise<void>,
): OrchestratorMaintenanceService {
  const options = {
    sessionCache: {
      sweepExpired: () => ({
        terminalSessions: 0,
        disconnectedSessions: 0,
        total: 0,
      }),
    },
    pushNotifier: {
      sweepExpired: () => ({
        toolInputs: 0,
        notificationEvents: 0,
        total: 0,
      }),
    },
    recoverPendingImmediateDeliveries,
  };
  return new OrchestratorMaintenanceService(options);
}

describe("runtime followup single-producer contract", () => {
  it("keeps an active-turn followup at exactly one agent observation", async () => {
    vi.useFakeTimers();
    const observation = { agentSawCount: 1 };
    const retiredProducer = vi.fn(async () => {
      observation.agentSawCount += 1;
    });
    const service = maintenanceWithRetiredProducer(retiredProducer);

    service.start();
    await retiredProducer.mock.results[0]?.value;
    await service.stop();

    expect(observation).toEqual({ agentSawCount: 1 });
  });

  it("keeps an idle followup at exactly one next-turn observation", async () => {
    vi.useFakeTimers();
    const observation = { agentSawCount: 0 };
    const retiredProducer = vi.fn(async () => {
      observation.agentSawCount += 1;
    });
    const service = maintenanceWithRetiredProducer(retiredProducer);

    service.start();
    await retiredProducer.mock.results[0]?.value;
    observation.agentSawCount += 1;
    await service.stop();

    expect(observation).toEqual({ agentSawCount: 1 });
  });

  it("leaves no pending retry or enqueue failure after inline consumption", async () => {
    vi.useFakeTimers();
    let consumed = false;
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const observation = {
      pendingCount: 0,
      retryCount: 0,
      errorCodes: [] as string[],
    };
    const retiredProducer = vi.fn(async () => {
      observation.pendingCount += 1;
      await recoveryGate;
      if (!consumed) return;
      observation.retryCount += 1;
      observation.errorCodes.push("claude_runtime_followup_enqueue_failed");
    });
    const service = maintenanceWithRetiredProducer(retiredProducer);

    service.start();
    consumed = true;
    releaseRecovery?.();
    await retiredProducer.mock.results[0]?.value;
    await service.stop();

    expect(observation).toEqual({
      pendingCount: 0,
      retryCount: 0,
      errorCodes: [],
    });
  });
});

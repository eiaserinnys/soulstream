import { describe, expect, it, vi } from "vitest";

import { RunnerRegistrationControl } from "../../src/runner/runner_registration_control.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { CompletionDeliveryCoordinator } from "../../src/task/completion_delivery_coordinator.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import { terminalDedupeKeyOf } from "../../src/task/task_termination.js";
import { EventOutboxDeadLetterError } from "../../src/upstream/event_outbox_pump_protocol.js";

import {
  DEDUPE_KEY,
  IDENTITY,
  SESSION_ID,
  makeOutboxDirectory,
  makeStore,
  makeTask,
  silentLogger,
} from "./card1266_settlement_harness.js";
import { makeDeliveryRepository } from "./delivery_repository_test_fake.js";

function registration(sessionId = SESSION_ID): RunnerRegistration {
  return {
    config: { sessionId, paths: { sessionDirectory: `/runner/${sessionId}` } },
    registrationId: "registration-1",
    pid: null,
    pidAlive: false,
    pidStartIdentity: null,
  } as unknown as RunnerRegistration;
}

describe("card #1266 U2b a runner registration with a pending settlement is not retired", () => {
  it("refuses to retire while the settlement is pending and retires once it is closed", async () => {
    const store = makeStore(await makeOutboxDirectory());
    const spawner = {
      invalidateRegistration: vi.fn(async () => {}),
      retireTerminalRegistration: vi.fn(async () => {}),
      terminate: vi.fn(async () => undefined),
    };
    const control = new RunnerRegistrationControl(
      spawner as never,
      async (candidate) => await store.hasPendingForSession(candidate.config.sessionId),
    );
    await store.begin(IDENTITY);

    await expect(control.retireTerminal(registration())).rejects.toMatchObject({ code: "runner_settlement_pending" });
    await expect(control.assertNoPendingSettlement(registration())).rejects.toMatchObject({ code: "runner_settlement_pending" });
    expect(spawner.terminate).not.toHaveBeenCalled();
    expect(spawner.retireTerminalRegistration).not.toHaveBeenCalled();

    await store.close(DEDUPE_KEY);

    await expect(control.retireTerminal(registration())).resolves.toBeUndefined();
    expect(spawner.terminate).toHaveBeenCalledOnce();
  });

  it("does not block a registration of another session", async () => {
    const store = makeStore(await makeOutboxDirectory());
    await store.begin(IDENTITY);
    const control = new RunnerRegistrationControl(
      { invalidateRegistration: vi.fn(), retireTerminalRegistration: vi.fn(), terminate: vi.fn(async () => undefined) } as never,
      async (candidate) => await store.hasPendingForSession(candidate.config.sessionId),
    );

    await expect(control.assertNoPendingSettlement(registration("other-session"))).resolves.toBeUndefined();
  });
});

describe("card #1266 U2b a permanent terminal rejection closes first, so the registration retires", () => {
  it("retires the rejected registration through the gate because the settlement was closed before", async () => {
    const store = makeStore(await makeOutboxDirectory());
    const spawner = {
      invalidateRegistration: vi.fn(async () => {}),
      retireTerminalRegistration: vi.fn(async () => {}),
      terminate: vi.fn(async () => undefined),
    };
    const control = new RunnerRegistrationControl(
      spawner as never,
      async (candidate) => await store.hasPendingForSession(candidate.config.sessionId),
    );
    const retired: string[] = [];
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: {
        enqueueTerminalTransitionAndWaitForApplication: async () => {
          throw new EventOutboxDeadLetterError(8, "REPEATED_FAILURE", "2026-11-14T00:00:01.000Z", "repeated failure");
        },
      } as never,
      settlement: store,
      closeSettlementPending: async (task: Parameters<typeof terminalDedupeKeyOf>[0]) => {
        const key = terminalDedupeKeyOf(task);
        if (key) await store.close(key);
      },
      retireRejectedRegistration: async () => {
        await control.retireTerminal(registration());
        retired.push("retired");
      },
    } as never);
    const task = makeTask({ terminationEventRecorded: false });

    await transition.persistExecutorFinalState(task, true, { settleCompletion: true });

    expect(retired).toEqual(["retired"]);
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
    expect(spawner.terminate).toHaveBeenCalledOnce();
    expect(await store.list()).toEqual([]);
  });

  it("would not retire if the settlement were still pending (the order matters)", async () => {
    const store = makeStore(await makeOutboxDirectory());
    await store.begin(IDENTITY);
    const control = new RunnerRegistrationControl(
      { invalidateRegistration: vi.fn(), retireTerminalRegistration: vi.fn(), terminate: vi.fn(async () => undefined) } as never,
      async (candidate) => await store.hasPendingForSession(candidate.config.sessionId),
    );

    await expect(control.retireTerminal(registration())).rejects.toMatchObject({ code: "runner_settlement_pending" });
  });
});

describe("card #1266 U2b completion registration result", () => {
  const input = {
    targetSessionId: "parent-sess-1",
    sourceSessionId: SESSION_ID,
    terminalRevision: "41",
    text: "done",
    callerInfo: { source: "agent" } as never,
    createdAt: new Date("2026-11-14T00:05:00.000Z"),
  };

  function coordinator(rows = new Map<string, Record<string, unknown>>()) {
    const repository = makeDeliveryRepository(rows);
    const dispatch = vi.fn(async () => {});
    return {
      rows,
      repository,
      dispatch,
      coordinator: new CompletionDeliveryCoordinator({ repository: repository as never, dispatch, logger: silentLogger }),
    };
  }

  it("answers registered when the row is stored", async () => {
    const subject = coordinator();
    await expect(subject.coordinator.enqueue(input)).resolves.toBe("registered");
    expect(subject.rows.size).toBe(1);
  });

  it("answers retry_required when the store fails, instead of returning as if registered", async () => {
    const subject = coordinator();
    subject.repository.register.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(subject.coordinator.enqueue(input)).resolves.toBe("retry_required");
    expect(subject.rows.size).toBe(0);
  });

  it("answers retry_required when the lookup before the registration fails", async () => {
    const subject = coordinator();
    subject.repository.get.mockRejectedValueOnce(new Error("lookup failed"));

    await expect(subject.coordinator.enqueue(input)).resolves.toBe("retry_required");
    expect(subject.repository.register).not.toHaveBeenCalled();
  });

  it("counts a repeated registration of the same relation key as registered, and a body that differs (restored text) does not kill the row", async () => {
    const subject = coordinator();
    await subject.coordinator.enqueue(input);
    const [row] = [...subject.rows.values()];

    await expect(subject.coordinator.enqueue({ ...input, text: "restored from the central row" }))
      .resolves.toBe("registered");

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(subject.rows.get(row!.delivery_id as string)?.state).not.toBe("uncertain");
  });
});

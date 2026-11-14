import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { composeCompletionSettlement } from "../../src/runtime/completion_settlement_composition.js";
import { startWorkerRuntime } from "../../src/runtime/worker_startup.js";
import { RunnerRegistrationControl } from "../../src/runner/runner_registration_control.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { EventOutbox } from "../../src/upstream/event_outbox.js";
import type { Task } from "../../src/task/task_models.js";

import {
  DEDUPE_KEY,
  IDENTITY,
  SESSION_ID,
  centralRow,
  makeNotifier,
  makeOutboxDirectory,
  makeTask,
  silentLogger,
} from "../task/card1266_settlement_harness.js";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const source = (path: string) => readFileSync(`${sourceRoot}${path}`, "utf8");

async function compose(v2: boolean, rows = new Map<string, Record<string, unknown>>()) {
  const directory = await makeOutboxDirectory();
  const outbox = await EventOutbox.open(directory);
  const harness = makeNotifier(rows);
  const settlement = composeCompletionSettlement({
    env: { EVENT_OUTBOX_DIR: directory, CLAUDE_SESSION_RUNTIME_V2_ENABLED: v2 },
    logger: silentLogger,
    db: { getSession: vi.fn(async () => centralRow()) } as never,
    eventOutbox: outbox,
    completionNotifier: harness.notifier,
    scheduleService: { listSchedules: vi.fn(async () => ({ sessionId: SESSION_ID, schedules: [], nextRunAt: null })) } as never,
  });
  return { settlement, outbox, rows, ...harness };
}

function owner() {
  const ports: Array<Record<string, unknown>> = [];
  return { ports, setTerminationCleanupPorts: (value: Record<string, unknown>) => { ports.push(value); } };
}

describe("card #1266 U2b production wiring of the settlement", () => {
  it("sweeps from the assembled worker even when the Claude session runtime v2 flag is off", async () => {
    const subject = await compose(false);
    await subject.settlement.store.begin(IDENTITY);
    subject.settlement.store.release(DEDUPE_KEY);

    await subject.settlement.worker.runOnce();

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.settlement.store.list()).toEqual([]);
  });

  it("feeds the runner registration gate from the same store, so a pending settlement blocks retirement", async () => {
    const subject = await compose(true);
    const control = new RunnerRegistrationControl(
      { invalidateRegistration: vi.fn(), retireTerminalRegistration: vi.fn(), terminate: vi.fn(async () => undefined) } as never,
      subject.settlement.hasPendingRunnerSettlement,
    );
    const registration = { config: { sessionId: SESSION_ID }, registrationId: "r", pidAlive: false, pidStartIdentity: null } as unknown as RunnerRegistration;
    await subject.settlement.store.begin(IDENTITY);

    await expect(control.assertNoPendingSettlement(registration)).rejects.toMatchObject({ code: "runner_settlement_pending" });

    await subject.settlement.store.close(DEDUPE_KEY);
    await expect(control.assertNoPendingSettlement(registration)).resolves.toBeUndefined();
  });

  it("wires the close port into both owners with the retire and forget ports, and the store only when delivery v2 is on", async () => {
    for (const v2 of [true, false]) {
      const subject = await compose(v2);
      const owners = [owner(), owner()];
      const retire = vi.fn(async () => {});
      const forget = vi.fn();
      subject.settlement.wireTerminationCleanup({ owners, retireRejectedRegistration: retire, forgetTask: forget });

      for (const { ports } of owners) {
        expect(ports).toHaveLength(1);
        expect(ports[0]).toMatchObject({ retireRejectedRegistration: retire, forgetTask: forget });
        expect(ports[0]?.closeSettlementPending).toBeTypeOf("function");
        expect("settlement" in (ports[0] ?? {})).toBe(v2);
      }
      await subject.settlement.store.begin(IDENTITY);
      const close = owners[0]!.ports[0]!.closeSettlementPending as (task: Task, info: { registrationId: string | null }) => Promise<void>;
      await close(makeTask(), { registrationId: "registration-1" });
      expect(await subject.settlement.store.list()).toEqual([]);
    }
  });

  it("leaves the retire port out when the node has no runner recovery", async () => {
    const subject = await compose(true);
    const owners = [owner()];
    subject.settlement.wireTerminationCleanup({ owners, retireRejectedRegistration: undefined, forgetTask: vi.fn() });

    expect("retireRejectedRegistration" in (owners[0]!.ports[0] ?? {})).toBe(false);
  });

  it("closes every entry of the session when the task has no terminal key yet", async () => {
    const subject = await compose(true);
    const owners = [owner()];
    subject.settlement.wireTerminationCleanup({ owners, retireRejectedRegistration: vi.fn(async () => {}), forgetTask: vi.fn() });
    await subject.settlement.store.begin(IDENTITY);

    await (owners[0]!.ports[0]!.closeSettlementPending as (task: Task, info: unknown) => Promise<void>)(
      makeTask({ terminalDedupeIdentity: undefined }), { registrationId: null },
    );

    expect(await subject.settlement.store.list()).toEqual([]);
  });

  it("is assembled by the worker composition and started and stopped by the process", () => {
    const worker = source("runtime/worker_composition.ts");
    expect(worker).toContain("composeCompletionSettlement(");
    expect(worker).toContain("hasPendingRunnerSettlement: settlement.hasPendingRunnerSettlement");
    expect(worker).toContain("settlement.wireTerminationCleanup(");
    expect(worker).toContain("completionSettlementWorker: settlement.worker");
    expect(source("main.ts")).toContain("runtime.completionSettlementWorker.stop(");
  });

  it("starts the sweep after the runner recovery scan converged, with or without a runner recovery", async () => {
    for (const withRecovery of [true, false]) {
      const order: string[] = [];
      const runtime = {
        createUpstreamAdapter: () => ({ run: async () => { await new Promise<void>(() => {}); } }),
        upstreamRegistrationReady: Promise.resolve(),
        ...(withRecovery
          ? { runnerRecoveryCoordinator: { start: async () => { order.push("scan"); } } }
          : {}),
        completionSettlementWorker: { start: vi.fn(async () => { order.push("sweep"); }) },
      };
      await startWorkerRuntime({
        compose: async () => runtime,
        listen: async () => {},
        logger: { info: vi.fn() },
        onUpstreamFailure: vi.fn(),
        onRunnerRecoveryFailure: vi.fn(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(order).toEqual(withRecovery ? ["scan", "sweep"] : ["sweep"]);
    }
  });
});

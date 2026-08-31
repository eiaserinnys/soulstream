import { describe, expect, it } from "vitest";

import { createFullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { ProductionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";
import type {
  FullSliceBackend,
  FullSliceObservation,
  FullSliceScenario,
} from "./s4_new_session_full_slice_types.js";

const BACKENDS: FullSliceBackend[] = ["claude", "codex"];

describe("S3-S6 production full slice", () => {
  it.each(BACKENDS)("S3 %s reattaches and applies one active intervention", async (
    backend,
  ) => {
    await runCase("S3", backend, (observed) => {
      assertCommon(observed, "S3", backend, [`S3 ${backend} intervention reply`], 1);
      expect(observed.restart).not.toBeNull();
      expect(observed.restart?.afterConnectionId)
        .not.toBe(observed.restart?.beforeConnectionId);
      expect(observed.runner.reattached).toEqual(observed.runner.first);
      expect(observed.runner.successor).toBeNull();
      assertActiveIntervention(observed, "S3", backend);
    });
  }, 120_000);

  it.each(BACKENDS)("S4 %s completes a fresh production execution", async (
    backend,
  ) => {
    await runCase("S4", backend, (observed) => {
      assertCommon(observed, "S4", backend, [`S4 ${backend} initial reply`], 1);
      expect(observed.restart).toBeNull();
      expect(observed.runner.reattached).toBeNull();
      expect(observed.runner.successor).toBeNull();
      const executeProbes = observed.engineBoundaryProbes.filter(
        (probe) => probe.call === "executeFrames",
      );
      expect(executeProbes).toHaveLength(1);
      expect(executeProbes[0]).toEqual({
        call: "executeFrames",
        scenario: "S4",
        backend,
        pid: observed.runner.first.pid,
        prompt: expect.any(String),
        resumeSessionId: null,
      });
      expectPromptEndsWithExactlyOnce(
        executeProbes[0].prompt,
        `S4 ${backend} initial prompt`,
      );
      expect(observed.engineBoundaryProbes.filter((probe) => probe.call === "intervene"))
        .toHaveLength(0);
      expect(observed.delivery).toBeNull();
    });
  }, 120_000);

  it.each(BACKENDS)("S5 %s resumes a completed session through public intervene", async (
    backend,
  ) => {
    await runCase("S5", backend, (observed) => {
      assertCommon(
        observed,
        "S5",
        backend,
        [`S5 ${backend} initial reply`, `S5 ${backend} resume reply`],
        2,
      );
      expect(observed.restart).toBeNull();
      expect(observed.runner.reattached).toBeNull();
      expect(observed.runner.firstAliveAfterInitialTerminal).toBe(false);
      assertDifferentSuccessor(observed);
      const interveneAcks = observed.publicAcks.filter(
        (ack) => ack.operation === "intervene",
      );
      expect(interveneAcks).toHaveLength(1);
      expect(interveneAcks[0]).toMatchObject({
        status: 200,
        body: {
          type: "intervene_ack",
          status: "ok",
          outcome: "auto_resumed",
        },
      });
      expect(interveneAcks[0]?.deliveryId).not.toBeNull();
      assertConsumedDelivery(observed, interveneAcks[0]?.deliveryId ?? "");
      const executeProbes = observed.engineBoundaryProbes.filter(
        (probe) => probe.call === "executeFrames",
      );
      expect(executeProbes).toHaveLength(2);
      const initialProbes = executeProbes.filter((probe) => probe.resumeSessionId === null);
      expect(initialProbes).toHaveLength(1);
      expect(initialProbes[0]).toEqual({
        call: "executeFrames",
        scenario: "S5",
        backend,
        pid: observed.runner.first.pid,
        prompt: expect.any(String),
        resumeSessionId: null,
      });
      expectPromptEndsWithExactlyOnce(
        initialProbes[0].prompt,
        `S5 ${backend} initial prompt`,
      );
      const resumeProbes = executeProbes.filter((probe) => probe.resumeSessionId !== null);
      expect(resumeProbes).toHaveLength(1);
      expect(resumeProbes[0]).toEqual({
        call: "executeFrames",
        scenario: "S5",
        backend,
        pid: observed.runner.successor?.pid,
        prompt: expect.any(String),
        resumeSessionId: expect.any(String),
      });
      expectFollowupPromptWithAppendedContext(
        resumeProbes[0].prompt,
        `S5 ${backend} completed resume`,
      );
      expect(observed.engineBoundaryProbes.filter((probe) => probe.call === "intervene"))
        .toHaveLength(0);
      expect(observed.durable.userMessageTexts.filter(
        (text) => text === `S5 ${backend} completed resume`,
      )).toHaveLength(1);
    });
  }, 120_000);

  it.each(BACKENDS)("S6 %s applies one active intervention without a new runner", async (
    backend,
  ) => {
    await runCase("S6", backend, (observed) => {
      assertCommon(observed, "S6", backend, [`S6 ${backend} intervention reply`], 1);
      expect(observed.restart).toBeNull();
      expect(observed.runner.reattached).toBeNull();
      expect(observed.runner.successor).toBeNull();
      assertActiveIntervention(observed, "S6", backend);
    });
  }, 120_000);
});

async function runCase(
  scenario: "S3" | "S4" | "S5" | "S6",
  backend: FullSliceBackend,
  assertObservation: (observation: FullSliceObservation) => void,
): Promise<void> {
  const postgres = await createFullSchemaPostgresHarness();
  let harness: ProductionFullSliceHarness | null = null;
  let scenarioFailed = false;
  let scenarioError: unknown;
  try {
    harness = await ProductionFullSliceHarness.create(postgres, scenario, backend);
    assertObservation(await harness.run());
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await harness?.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await postgres.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (scenarioFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [scenarioError, ...cleanupErrors],
        "Full-slice scenario and cleanup failed",
      );
    }
    throw scenarioError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Full-slice cleanup failed");
  }
}

function assertCommon(
  observed: FullSliceObservation,
  scenario: FullSliceScenario,
  backend: FullSliceBackend,
  expectedAssistantContents: string[],
  expectedTerminalCount: number,
): void {
  expect(observed.scenario).toBe(scenario);
  expect(observed.backend).toBe(backend);
  const createAcks = observed.publicAcks.filter((ack) => ack.operation === "create");
  expect(createAcks).toHaveLength(1);
  expect(createAcks[0]?.status).toBe(201);
  expect(observed.durable.status).toBe("completed");
  expect(observed.durable.assistantContents).toEqual(expectedAssistantContents);
  expect(observed.durable.sessionEndedCount).toBe(expectedTerminalCount);
  expect(observed.durable.errorEventCount).toBe(0);
}

function assertActiveIntervention(
  observed: FullSliceObservation,
  scenario: "S3" | "S6",
  backend: FullSliceBackend,
): void {
  const interveneAcks = observed.publicAcks.filter((ack) => ack.operation === "intervene");
  expect(interveneAcks).toHaveLength(1);
  expect(interveneAcks[0]).toMatchObject({
    status: 200,
    body: { type: "intervene_ack", status: "ok" },
  });
  expect(interveneAcks[0]?.deliveryId).not.toBeNull();
  assertConsumedDelivery(observed, interveneAcks[0]?.deliveryId ?? "");
  const executeProbes = observed.engineBoundaryProbes.filter(
    (probe) => probe.call === "executeFrames",
  );
  expect(executeProbes).toHaveLength(backend === "claude" ? 2 : 1);
  expect(executeProbes[0]).toEqual({
    call: "executeFrames",
    scenario,
    backend,
    pid: observed.runner.first.pid,
    prompt: expect.any(String),
    resumeSessionId: null,
  });
  expectPromptEndsWithExactlyOnce(
    executeProbes[0].prompt,
    `${scenario} ${backend} initial prompt`,
  );
  if (backend === "claude") {
    expect(executeProbes[1]).toEqual({
      call: "executeFrames",
      scenario,
      backend,
      pid: observed.runner.first.pid,
      prompt: expect.any(String),
      resumeSessionId: expect.any(String),
    });
    expectFollowupPromptWithAppendedContext(
      executeProbes[1].prompt,
      `${scenario} ${backend} active intervention`,
    );
  }
  const interveneProbes = observed.engineBoundaryProbes.filter(
    (probe) => probe.call === "intervene",
  );
  expect(interveneProbes).toHaveLength(1);
  expect(interveneProbes[0]).toEqual({
    call: "intervene",
    scenario,
    backend,
    pid: observed.runner.first.pid,
    prompt: `${scenario} ${backend} active intervention`,
    result: backend === "claude"
      ? {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        }
      : { status: "delivered", mechanism: "active_turn" },
  });
  const interruptProbes = observed.engineBoundaryProbes.filter(
    (probe) => probe.call === "interrupt",
  );
  expect(interruptProbes).toHaveLength(backend === "claude" ? 1 : 0);
  expect(observed.durable.interventionSentTexts.filter(
    (text) => text === `${scenario} ${backend} active intervention`,
  )).toHaveLength(1);
}

function assertDifferentSuccessor(observed: FullSliceObservation): void {
  expect(observed.runner.successor).not.toBeNull();
  expect(observed.runner.successor?.registrationId)
    .not.toBe(observed.runner.first.registrationId);
  expect(observed.runner.successor?.pid).not.toBe(observed.runner.first.pid);
  expect(observed.runner.successor?.startIdentity)
    .not.toBe(observed.runner.first.startIdentity);
}

function expectPromptEndsWithExactlyOnce(prompt: string, original: string): void {
  expect(prompt.endsWith(original)).toBe(true);
  expect(prompt.split(original)).toHaveLength(2);
}

function expectFollowupPromptWithAppendedContext(prompt: string, original: string): void {
  expect(prompt.split(original)).toHaveLength(2);
  expect(prompt.startsWith(`${original}\n\n<context>\n`)).toBe(true);
  expect(prompt.endsWith("\n</context>")).toBe(true);
}

function assertConsumedDelivery(
  observed: FullSliceObservation,
  deliveryId: string,
): void {
  expect(observed.delivery).toEqual({
    rowCount: 1,
    deliveryId,
    targetSessionId: observed.sessionId,
    state: "consumed",
    aggregateState: "consumed",
    consumedAt: expect.any(String),
  });
}

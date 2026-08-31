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

describe("S1+S2 production restart and resume full slice", () => {
  it.each(BACKENDS)("S1 %s reattaches the exact runner after soul-server SIGKILL", async (
    backend,
  ) => {
    await runCase("S1", backend, (observed) => {
      assertCommon(observed, "S1", backend, [`S1 ${backend} initial reply`], 1);
      expect(observed.publicAcks.filter((ack) => ack.operation === "intervene"))
        .toHaveLength(0);
      expect(observed.restart).not.toBeNull();
      expect(observed.restart?.afterConnectionId)
        .not.toBe(observed.restart?.beforeConnectionId);
      expect(observed.runner.reattached).toEqual(observed.runner.first);
      expect(observed.runner.successor).toBeNull();
      expect(observed.silentWindow).toEqual({
        runnerAlive: true,
        sessionEndedCount: 0,
        errorEventCount: 0,
      });
      const executeProbes = observed.engineBoundaryProbes.filter(
        (probe) => probe.call === "executeFrames",
      );
      expect(executeProbes).toHaveLength(1);
      expect(executeProbes[0]).toMatchObject({
        call: "executeFrames",
        scenario: "S1",
        backend,
        pid: observed.runner.first.pid,
        resumeSessionId: null,
      });
      expectFirstTurnPromptWithPrependedContext(
        executeProbes[0].prompt,
        `S1 ${backend} initial prompt`,
      );
      expect(observed.engineBoundaryProbes.filter((probe) => probe.call === "intervene"))
        .toHaveLength(0);
      expect(observed.delivery).toBeNull();
    });
  }, 120_000);

  it.each(BACKENDS)("S2 %s resumes a completed session once through public intervene", async (
    backend,
  ) => {
    await runCase("S2", backend, (observed) => {
      assertCommon(
        observed,
        "S2",
        backend,
        [`S2 ${backend} initial reply`, `S2 ${backend} resume reply`],
        2,
      );
      expect(observed.restart).not.toBeNull();
      expect(observed.restart?.afterConnectionId)
        .not.toBe(observed.restart?.beforeConnectionId);
      expect(observed.runner.reattached).toEqual(observed.runner.first);
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
      expect(initialProbes[0]).toMatchObject({
        call: "executeFrames",
        scenario: "S2",
        backend,
        pid: observed.runner.first.pid,
        resumeSessionId: null,
      });
      expectFirstTurnPromptWithPrependedContext(
        initialProbes[0].prompt,
        `S2 ${backend} initial prompt`,
      );
      const resumeProbes = executeProbes.filter((probe) => probe.resumeSessionId !== null);
      expect(resumeProbes).toHaveLength(1);
      expect(resumeProbes[0]).toMatchObject({
        call: "executeFrames",
        scenario: "S2",
        backend,
        pid: observed.runner.successor?.pid,
        resumeSessionId: expect.any(String),
      });
      expectFollowupPromptWithAppendedContext(
        resumeProbes[0].prompt,
        `S2 ${backend} completed resume`,
      );
      expect(observed.engineBoundaryProbes.filter((probe) => probe.call === "intervene"))
        .toHaveLength(0);
      expect(observed.durable.userMessageTexts.filter(
        (text) => text === `S2 ${backend} completed resume`,
      )).toHaveLength(1);
    });
  }, 120_000);
});

async function runCase(
  scenario: "S1" | "S2",
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

function assertDifferentSuccessor(observed: FullSliceObservation): void {
  expect(observed.runner.successor).not.toBeNull();
  expect(observed.runner.successor?.registrationId)
    .not.toBe(observed.runner.first.registrationId);
  expect(observed.runner.successor?.pid).not.toBe(observed.runner.first.pid);
  expect(observed.runner.successor?.startIdentity)
    .not.toBe(observed.runner.first.startIdentity);
}

function expectFirstTurnPromptWithPrependedContext(prompt: string, original: string): void {
  expect(prompt.split(original)).toHaveLength(2);
  expect(prompt.startsWith("<context>\n")).toBe(true);
  expect(prompt.endsWith(`\n</context>\n\n${original}`)).toBe(true);
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

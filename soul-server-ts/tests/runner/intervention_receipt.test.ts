import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import {
  engineEventFrame,
  executeCommandFrame,
  invokeCommandFrame,
  runnerCommandResultFrame,
  type RunnerFrame,
} from "../../src/runner/frame_protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import { RUNNER_INTERVENTION_RECEIPT_CAPABILITY } from
  "../../src/runner/runner_intervention_receipt.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  pendingRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteInterventionReceipt } from
  "../../src/runner/sqlite_intervention_receipt.js";
import { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../../src/upstream/event_outbox_pump_mux.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");
const REGISTRATION_ID = "registration-receipt-runner";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-intervention-receipt-"));
  directories.push(directory);
  return directory;
}

async function makeReceiptStore(): Promise<{
  databasePath: string;
  store: RunnerSqliteInterventionReceipt;
}> {
  const directory = await temporaryDirectory();
  const databasePath = join(directory, "runner.sqlite");
  const outbox = await RunnerSqliteEventOutbox.create(databasePath);
  outbox.close();
  const store = RunnerSqliteInterventionReceipt.open(databasePath, REGISTRATION_ID, {
    sessionId: "session-receipt",
  });
  return { databasePath, store };
}

function makeEngine(overrides: Partial<EnginePort> = {}): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/runner",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
    ...overrides,
  };
}

async function drain<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("runner intervention receipt recording", () => {
  it("writes handing before the engine call and applied after a delivered verdict", async () => {
    const { store } = await makeReceiptStore();
    let observedDuringEngineCall: unknown;
    const intervene = vi.fn(async () => {
      observedDuringEngineCall = store.lookup("intervention-applied").row?.state;
      return { status: "delivered", mechanism: "active_turn" } as const;
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(
      makeEngine({ intervene }),
      {},
      store,
    );

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-intervene-1",
      "intervene",
      [{ prompt: "steer", runnerInterventionId: "intervention-applied" }],
    ))).resolves.toMatchObject({ result: { status: "ok" } });

    expect(observedDuringEngineCall).toBe("handing");
    expect(store.lookup("intervention-applied")).toEqual({
      row: { state: "applied", registrationId: REGISTRATION_ID },
      runnerRegistrationId: REGISTRATION_ID,
    });
    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({
      runnerInterventionId: "intervention-applied",
    }));
    store.close();
  });

  it("records not_applied when the engine clearly did not take the input", async () => {
    const { store } = await makeReceiptStore();
    const engine = makeEngine({
      intervene: vi.fn(async () => ({
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
      }) as const),
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await dispatcher.dispatch(invokeCommandFrame(
      "invoke-intervene-2",
      "intervene",
      [{ prompt: "steer", runnerInterventionId: "intervention-refused" }],
    ));

    expect(store.lookup("intervention-refused").row).toEqual({
      state: "not_applied",
      registrationId: REGISTRATION_ID,
    });
    store.close();
  });

  it("leaves handing when the engine call throws", async () => {
    const { store } = await makeReceiptStore();
    const engine = makeEngine({
      intervene: vi.fn(async () => {
        throw new Error("engine unavailable");
      }),
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-intervene-3",
      "intervene",
      [{ prompt: "steer", runnerInterventionId: "intervention-thrown" }],
    ))).resolves.toMatchObject({ result: { status: "error" } });

    expect(store.lookup("intervention-thrown").row).toEqual({
      state: "handing",
      registrationId: REGISTRATION_ID,
    });
    store.close();
  });

  it("records execute intervention ids as handing, then applied once the engine starts", async () => {
    const { store, databasePath } = await makeReceiptStore();
    const observed: Record<string, string | undefined> = {};
    const engine = makeEngine({
      async executeToFrameChannel(params, channel): Promise<void> {
        for (const interventionId of params.runnerInterventionIds ?? []) {
          observed[interventionId] = store.lookup(interventionId).row?.state;
        }
        if (params.runnerInterventionId) {
          observed[params.runnerInterventionId] = store.lookup(
            params.runnerInterventionId,
          ).row?.state;
        }
        await channel.emit(engineEventFrame({ type: "complete", timestamp: 1 }));
      },
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await expect(dispatcher.dispatch(executeCommandFrame("execute-receipt", {
      agentSessionId: "session-receipt",
      prompt: "next turn",
      runnerInterventionId: "intervention-execute-single",
      runnerInterventionIds: ["intervention-execute-a", "intervention-execute-b"],
    }))).resolves.toMatchObject({ result: { status: "ok" } });
    await drain(dispatcher.events("execute-receipt"));

    expect(observed).toEqual({
      "intervention-execute-a": "handing",
      "intervention-execute-b": "handing",
      "intervention-execute-single": "handing",
    });
    for (const interventionId of [
      "intervention-execute-single",
      "intervention-execute-a",
      "intervention-execute-b",
    ]) {
      expect(store.lookup(interventionId).row).toEqual({
        state: "applied",
        registrationId: REGISTRATION_ID,
      });
    }
    expect(readReceiptRows(databasePath)).toHaveLength(3);
    store.close();
  });

  it("keeps one row per intervention number and keeps the columns the spec names", async () => {
    const { store, databasePath } = await makeReceiptStore();

    store.recordHanding(["intervention-repeat"], "execute:first");
    store.recordHanding(["intervention-repeat"], "execute:second");

    const rows = readReceiptRows(databasePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intervention_id: "intervention-repeat",
      registration_id: REGISTRATION_ID,
      execution_command_id: "execute:second",
      state: "handing",
    });
    expect(Number.isFinite(Date.parse(String(rows[0]!.updated_at)))).toBe(true);
    store.close();
  });

  it("answers the lookup capability with the row and this runner's registration", async () => {
    const { store } = await makeReceiptStore();
    store.recordHanding(["intervention-lookup"], null);
    store.markApplied(["intervention-lookup"]);
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine(), {}, store);

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-receipt-1",
      RUNNER_INTERVENTION_RECEIPT_CAPABILITY,
      ["intervention-lookup"],
    ))).resolves.toMatchObject({
      result: {
        status: "ok",
        data: {
          row: { state: "applied", registrationId: REGISTRATION_ID },
          runnerRegistrationId: REGISTRATION_ID,
        },
      },
    });
    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-receipt-2",
      RUNNER_INTERVENTION_RECEIPT_CAPABILITY,
      ["intervention-never-seen"],
    ))).resolves.toMatchObject({
      result: {
        status: "ok",
        data: {
          row: null,
          runnerRegistrationId: REGISTRATION_ID,
        },
      },
    });
    store.close();
  });

  it("forwards an intervention id through a runner that predates the receipt store", async () => {
    // An old runner has no receipt store and no lookup capability; the extra
    // input field must ride along harmlessly so a rolling deploy keeps steering.
    const intervene = vi.fn(async () => ({
      status: "delivered",
      mechanism: "active_turn",
    }) as const);
    const dispatcher = new InProcessRunnerCommandDispatcher(
      makeEngine({ intervene }),
    );

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-old-runner-intervene",
      "intervene",
      [{ prompt: "steer", runnerInterventionId: "intervention-old" }],
    ))).resolves.toMatchObject({
      result: { status: "ok", data: { status: "delivered" } },
    });
    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "steer",
      runnerInterventionId: "intervention-old",
    }));
  });

  it("keeps the delivered verdict when the applied receipt write throws", async () => {
    const { store } = await makeReceiptStore();
    vi.spyOn(store, "markApplied").mockImplementation(() => {
      throw new Error("receipt write failed");
    });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const engine = makeEngine({
      intervene: vi.fn(async () => ({
        status: "delivered",
        mechanism: "active_turn",
      }) as const),
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-intervene-write-failure",
      "intervene",
      [{ prompt: "steer", runnerInterventionId: "intervention-write-failure" }],
    ))).resolves.toMatchObject({
      result: { status: "ok", data: { status: "delivered" } },
    });

    expect(store.lookup("intervention-write-failure").row).toEqual({
      state: "handing",
      registrationId: REGISTRATION_ID,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    store.close();
  });

  it("keeps the execute event stream flowing when the applied receipt write throws", async () => {
    const { store } = await makeReceiptStore();
    vi.spyOn(store, "markApplied").mockImplementation(() => {
      throw new Error("receipt write failed");
    });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const engine = makeEngine({
      async executeToFrameChannel(_params, channel): Promise<void> {
        await channel.emit(engineEventFrame({ type: "complete", timestamp: 1 }));
      },
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await expect(dispatcher.dispatch(executeCommandFrame("execute-write-failure", {
      agentSessionId: "session-receipt",
      prompt: "next turn",
      runnerInterventionId: "intervention-execute-write-failure",
    }))).resolves.toMatchObject({ result: { status: "ok" } });
    const frames = await drain(dispatcher.events("execute-write-failure"));

    expect(frames).toHaveLength(1);
    expect(store.lookup("intervention-execute-write-failure").row).toEqual({
      state: "handing",
      registrationId: REGISTRATION_ID,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    store.close();
  });

  it("leaves handing when the first execute frame is an engine error event", async () => {
    const { store } = await makeReceiptStore();
    const engine = makeEngine({
      async executeToFrameChannel(_params, channel): Promise<void> {
        await channel.emit(engineEventFrame({ type: "error", timestamp: 1 }));
        await channel.emit(engineEventFrame({ type: "complete", timestamp: 2 }));
      },
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(engine, {}, store);

    await expect(dispatcher.dispatch(executeCommandFrame("execute-error-first", {
      agentSessionId: "session-receipt",
      prompt: "next turn",
      runnerInterventionId: "intervention-execute-error-first",
    }))).resolves.toMatchObject({ result: { status: "ok" } });
    const frames = await drain(dispatcher.events("execute-error-first"));

    // An error event is a rejection, so the receipt must stay `handing`
    // even though later frames arrive.
    expect(frames).toHaveLength(2);
    expect(store.lookup("intervention-execute-error-first").row).toEqual({
      state: "handing",
      registrationId: REGISTRATION_ID,
    });
    store.close();
  });

  it("answers not_supported for the lookup capability when no receipt store is attached", async () => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine());

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-receipt-old-runner",
      RUNNER_INTERVENTION_RECEIPT_CAPABILITY,
      ["intervention-lookup"],
    ))).resolves.toMatchObject({
      result: { status: "ok", data: { status: "not_supported" } },
    });
  });
});

describe("node-side intervention receipt lookup", () => {
  it.each([
    {
      name: "applied receipt from the expected registration",
      answer: {
        row: { state: "applied", registrationId: "expected-registration" },
        runnerRegistrationId: "expected-registration",
      },
      expected: "applied",
    },
    {
      name: "no receipt row on the expected runner",
      answer: { row: null, runnerRegistrationId: "expected-registration" },
      expected: "not_applied",
    },
    {
      name: "not_applied receipt on the expected runner",
      answer: {
        row: { state: "not_applied", registrationId: "expected-registration" },
        runnerRegistrationId: "expected-registration",
      },
      expected: "not_applied",
    },
    {
      name: "handing receipt",
      answer: {
        row: { state: "handing", registrationId: "expected-registration" },
        runnerRegistrationId: "expected-registration",
      },
      expected: "unknown",
    },
    {
      name: "old runner without the capability",
      answer: { status: "not_supported" },
      expected: "unknown",
    },
    {
      name: "answer from another runner registration",
      answer: {
        row: { state: "applied", registrationId: "expected-registration" },
        runnerRegistrationId: "other-registration",
      },
      expected: "unknown",
    },
    {
      name: "applied receipt written by another registration",
      answer: {
        row: { state: "applied", registrationId: "other-registration" },
        runnerRegistrationId: "expected-registration",
      },
      expected: "unknown",
    },
    {
      name: "malformed answer",
      answer: { unexpected: true },
      expected: "unknown",
    },
  ] as const)("returns $expected for $name", async ({ answer, expected }) => {
    const fixture = await makeNodeFixture(answer);

    await expect(fixture.dispatcher.lookupInterventionReceipt(
      "intervention-node",
      "expected-registration",
    )).resolves.toBe(expected);
    await fixture.close();
  });

  it.each([
    ["timeout", new Error("Runner request timed out after 30000ms")],
    ["disconnect", new Error("Runner host connection unavailable")],
  ])("returns unknown when the lookup %s fails", async (_name, error) => {
    const fixture = await makeNodeFixture({
      row: null,
      runnerRegistrationId: "expected-registration",
    });
    vi.spyOn(fixture.dispatcher, "invoke").mockRejectedValue(error);

    await expect(fixture.dispatcher.lookupInterventionReceipt(
      "intervention-node",
      "expected-registration",
    )).resolves.toBe("unknown");
    await fixture.close();
  });
});

function readReceiptRows(databasePath: string): Array<Record<string, unknown>> {
  // An independent read-only connection proves the row is durable, not just
  // visible through the writing store.
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM runner_intervention_receipt").all() as
      Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

async function makeNodeFixture(receiptAnswer: unknown) {
  const stateDirectory = await temporaryDirectory();
  const paths = runnerProcessPaths(stateDirectory, "session-receipt");
  await mkdir(paths.sessionDirectory, { recursive: true });
  const writer = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await writer.initializeBootstrap({
    session_id: "session-receipt",
    created_at: "2026-11-13T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-receipt",
      cwd: "/workspace/receipt",
      codex_home: "/home/test/.codex",
      rollout_root: "/home/test/.codex/sessions",
      code_sha: "sha-receipt",
      snapshot_path: "/release/sha-receipt/soul-server-ts",
    },
  });
  writer.close();
  const identity = {
    ...pendingRunnerRegistrationIdentity("session-receipt", "sha-receipt"),
    pid: 4401,
    startIdentity: "start-4401",
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
  let endpoint!: RunnerSocketEndpoint;
  endpoint = new RunnerSocketEndpoint(paths.socketPath, async (frame: RunnerFrame) => {
    if (frame.channel !== "command") return;
    const data = frame.kind === "invoke"
      && frame.capability === RUNNER_INTERVENTION_RECEIPT_CAPABILITY
      ? receiptAnswer
      : undefined;
    await endpoint.currentConnection!.send(runnerCommandResultFrame(frame.commandId, {
      status: "ok",
      ...(data !== undefined ? { data } : {}),
    }));
  }, vi.fn());
  await endpoint.listen();
  const dispatcher = new RunnerProcessDispatcher({
    spawn: {
      stateDirectory,
      sessionId: "session-receipt",
      backend: "codex",
      agent: {
        id: "agent-receipt",
        name: "Agent Receipt",
        backend: "codex",
        workspace_dir: "/workspace/receipt",
      },
      codeSha: "sha-receipt",
      snapshotPath: "/release/sha-receipt/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    runnerProcess: {
      pid: 4401,
      registrationId: identity.registrationId,
      paths,
      config: {} as never,
      adopted: false,
    },
    pumpMux: new EventOutboxPumpMux(
      new EventOutboxPump(emptyOutboxStore("node-stream"), vi.fn()),
    ),
    logger: pino({ level: "silent" }),
    handleHostCall: async () => null,
  });
  await dispatcher.prepareSession("session-receipt");
  return {
    dispatcher,
    close: async () => {
      await dispatcher.close().catch(() => undefined);
      await endpoint.close();
    },
  };
}

function emptyOutboxStore(streamId: string) {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    async readBatch() { return null; },
    async acknowledge() {},
  };
}

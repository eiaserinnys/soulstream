import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import { createAttachmentMaterializer } from "../../src/attachments/attachment_materializer.js";
import { makeUserMessage } from "../../src/engine/claude_sdk_user_message.js";
import type { EngineExecuteParams, EnginePort, EngineUserInput } from "../../src/engine/protocol.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { createInProcessTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskEngineTurnRunner } from "../../src/task/task_engine_turn_runner.js";
import { createAttachmentInputPreparer } from "../../src/task/prepare_attachment_input.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";
import type { Task } from "../../src/task/task_models.js";
import type { ExecutionContextBuilder } from "../../src/context/context_builder.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const CACHE_ROOT = join(tmpdir(), "soulstream-attachment-model-input-boundary-245");
const SESSION_ID = "session-1";
const IMAGE_ID = "asset-image";
const TEXT_ID = "asset-text";
const IMAGE_PATH = join(CACHE_ROOT, SESSION_ID, "assets", IMAGE_ID, "screen.png");
const TEXT_PATH = join(CACHE_ROOT, SESSION_ID, "assets", TEXT_ID, "notes.txt");
const LEGACY_IMAGE_PATH = "/legacy/screen.png";
const LEGACY_TEXT_PATH = "/legacy/notes.txt";

const claudeAgent: AgentProfile = {
  id: "claude-default",
  name: "Claude Default",
  backend: "claude",
  workspace_dir: "/tmp/claude-default",
};

const attachmentIds = [IMAGE_ID, TEXT_ID];
const attachmentPaths = [LEGACY_IMAGE_PATH, LEGACY_TEXT_PATH];
const attachmentBindings = [
  { attachment_id: IMAGE_ID, path: LEGACY_IMAGE_PATH },
  { attachment_id: TEXT_ID, path: LEGACY_TEXT_PATH },
];
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=",
  "base64",
);
const textBytes = Buffer.from("private report body");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function descriptor(
  attachmentId: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): AttachmentDescriptor {
  return {
    attachment_id: attachmentId,
    name,
    mime_type: mimeType,
    byte_size: bytes.byteLength,
    checksum_sha256: sha256(bytes),
    width: null,
    height: null,
    preview_kind: mimeType.startsWith("image/") ? "image" : "info",
    preview_mime_type: null,
  };
}

function makeAttachmentFixture() {
  const sources = new Map([
    [IMAGE_ID, { descriptor: descriptor(IMAGE_ID, "screen.png", "image/png", imageBytes), bytes: imageBytes }],
    [TEXT_ID, { descriptor: descriptor(TEXT_ID, "notes.txt", "text/plain", textBytes), bytes: textBytes }],
  ]);
  const requestedUrls: string[] = [];
  const contentGets = new Map<string, number>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
    const url = new URL(String(request));
    requestedUrls.push(url.toString());
    const path = url.pathname.split("/");
    const endpoint = path.at(-1);
    const attachmentId = path.at(-2);
    const source = attachmentId ? sources.get(attachmentId) : undefined;
    if (!source) throw new Error(`Unexpected attachment request: ${url.pathname}`);
    if (endpoint === "metadata") {
      return Response.json({ descriptor: source.descriptor, upload_status: "committed" });
    }
    if (endpoint === "content") {
      contentGets.set(attachmentId!, (contentGets.get(attachmentId!) ?? 0) + 1);
      return new Response(source.bytes);
    }
    throw new Error(`Unexpected attachment endpoint: ${url.pathname}`);
  });
  const materializer = createAttachmentMaterializer({
    incomingDir: CACHE_ROOT,
    nodeId: "eiaserinnys",
    orch: { baseUrl: "http://orch.test", headers: {} },
    fetch,
  });
  return { materializer, fetch, requestedUrls, contentGets };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "Inspect the supplied files",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBuilder(materializer: ReturnType<typeof createAttachmentMaterializer>) {
  const contextBuilder = {
    build: vi.fn().mockResolvedValue(undefined),
    buildFollowupContext: vi.fn().mockResolvedValue(undefined),
    buildBackendRolloverContext: vi.fn().mockResolvedValue({ contextItems: [] }),
    buildGenerationContext: vi.fn().mockResolvedValue({
      effectiveSystemPrompt: "system instructions",
      combinedContextItems: [],
      assembledPrompt: "",
      checkpointStats: {
        estimatedTokens: 4,
        chars: 12,
        sections: { state: 1, story: 1, summaries: 1, recent: 1 },
        summarizedThroughTurn: 0,
        recentFromEventId: 0,
        recentToEventId: 0,
      },
    }),
  } as unknown as ExecutionContextBuilder;
  return new TaskTurnInputBuilder({
    contextBuilder,
    initialMessagePublisher: {
      publishInitialMessages: vi.fn().mockResolvedValue(undefined),
      publishContextManifestBestEffort: vi.fn().mockResolvedValue(undefined),
    },
    logger: pino({ level: "silent" }),
    prepareAttachmentInput: createAttachmentInputPreparer(materializer),
    waitForAttachmentRefs: vi.fn().mockResolvedValue(undefined),
  });
}

async function* emptyRunnerFrames(): AsyncGenerator<never> {}

async function collectExecuteParams(
  task: Task,
  agent: AgentProfile,
  input: Parameters<TaskEngineTurnRunner["executeTurn"]>[0]["input"],
): Promise<EngineExecuteParams> {
  const executeFrames = vi.fn((_params: EngineExecuteParams) => emptyRunnerFrames());
  const runner = {
    engine: { backendId: agent.backend, workspaceDir: agent.workspace_dir } as EnginePort,
    dispatcher: { executeFrames } as unknown as TaskRunnerRuntime["dispatcher"],
  } as TaskRunnerRuntime;
  const turnRunner = new TaskEngineTurnRunner({
    snapshotPersistence: {
      persistRunStateSnapshot: vi.fn().mockResolvedValue(undefined),
      persistSessionItemsSnapshot: vi.fn().mockResolvedValue(undefined),
    },
  });
  for await (const _event of turnRunner.executeTurn({ task, agent, runner, input })) {
    // Drain the real turn boundary.
  }
  const params = executeFrames.mock.calls[0]?.[0];
  if (!params) throw new Error("TaskEngineTurnRunner did not invoke the runner");
  return params;
}

describe("attachment model input boundary", () => {
  beforeEach(async () => rm(CACHE_ROOT, { recursive: true, force: true }));
  afterEach(async () => rm(CACHE_ROOT, { recursive: true, force: true }));

  it("feeds current materialized paths through turns, rollover, and Claude image blocks", async () => {
    const fixture = makeAttachmentFixture();
    const builder = makeBuilder(fixture.materializer);
    const task = makeTask({ attachmentIds, attachmentPaths, attachmentBindings });
    const initial = await builder.prepareInitialTurnInput(task, claudeAgent);
    const initialParams = await collectExecuteParams(task, claudeAgent, initial);

    expect(initialParams.imageAttachmentPaths).toEqual([IMAGE_PATH]);
    expect(initialParams.prompt).toContain(`[첨부 파일 로컬 경로: ${TEXT_PATH}]`);
    expect(initialParams.prompt).not.toContain("/legacy/");
    expect(await readFile(IMAGE_PATH)).toEqual(imageBytes);
    expect(await readFile(TEXT_PATH)).toEqual(textBytes);
    expect(task).toMatchObject({ prompt: "Inspect the supplied files", attachmentIds, attachmentPaths });
    expect(initial.attachmentSource).toMatchObject({ text: task.prompt, attachmentIds });

    const claudeContent = makeUserMessage(initialParams.prompt, initialParams.imageAttachmentPaths).message.content;
    expect(claudeContent).toEqual([
      { type: "text", text: initialParams.prompt },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") },
      },
    ]);
    expect(initialParams.prompt).not.toContain(textBytes.toString("utf8"));

    const followupMessage = {
      text: "Check these files too",
      user: "Browser",
      deliveryId: "followup-1",
      attachmentIds: [...attachmentIds],
      attachmentPaths: [...attachmentPaths],
      attachmentBindings: [...attachmentBindings],
    };
    const followup = await builder.prepareFollowupTurnInput(task, claudeAgent, [followupMessage]);
    const followupParams = await collectExecuteParams(task, claudeAgent, followup);
    expect(followupParams.imageAttachmentPaths).toEqual([IMAGE_PATH]);
    expect(followupParams.prompt).toContain(`[첨부 파일 로컬 경로: ${TEXT_PATH}]`);
    expect(followupParams.prompt).not.toContain("/legacy/");
    expect(followupMessage).toMatchObject({ attachmentIds, attachmentPaths });

    const generationMessage = {
      text: "Continue with these attachments",
      user: "Browser",
      deliveryId: "generation-1",
      attachmentIds: [...attachmentIds],
      attachmentPaths: [...attachmentPaths],
      attachmentBindings: [...attachmentBindings],
    };
    const generationTask = makeTask({
      activeGenerationRollover: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-16T00:00:00.000Z",
        fromBackendSessionId: "backend-old",
        previousModelPreset: "claude-default",
        previousBackend: "claude",
      },
      interventionQueue: [generationMessage],
    });
    const generation = await builder.prepareInitialTurnInput(generationTask, claudeAgent);
    const generationParams = await collectExecuteParams(generationTask, claudeAgent, generation);
    expect(generationParams.imageAttachmentPaths).toEqual([IMAGE_PATH]);
    expect(generationParams.prompt).toContain(`[첨부 파일 로컬 경로: ${TEXT_PATH}]`);
    expect(generationMessage).toMatchObject({ attachmentIds, attachmentPaths });

    const liveTask = makeTask();
    const liveEngine = {
      backendId: "claude",
      workspaceDir: claudeAgent.workspace_dir,
      intervene: vi.fn().mockResolvedValue({ status: "delivered", mechanism: "active_turn" }),
    };
    liveTask.runner = { engine: liveEngine } as unknown as Task["runner"];
    const livePersistence = {
      waitForSessionAck: vi.fn().mockResolvedValue(undefined),
      enqueueEvent: vi.fn().mockResolvedValue({ eventId: 1 }),
      handleSideEffects: vi.fn().mockResolvedValue(undefined),
    };
    const liveTransition = new RunningInterventionTransition({
      broadcaster: {} as never,
      logger: pino({ level: "silent" }),
      persistence: livePersistence as never,
      prepareAttachmentInput: createAttachmentInputPreparer(fixture.materializer),
    });
    const liveMessage = {
      text: "Use this image and report",
      user: "Browser",
      callerInfo: { source: "browser", display_name: "Browser" },
      deliveryId: "live-1",
      attachmentIds: [...attachmentIds],
      attachmentPaths: [...attachmentPaths],
      attachmentBindings: [...attachmentBindings],
    };
    await expect(liveTransition.deliver(liveTask, liveMessage)).resolves.toEqual({ delivered: true });
    const liveInput = liveEngine.intervene.mock.calls[0]?.[0] as EngineUserInput | undefined;
    expect(liveInput?.imageAttachmentPaths).toEqual([IMAGE_PATH]);
    expect(liveInput?.prompt).toContain(`[첨부 파일 로컬 경로: ${TEXT_PATH}]`);
    expect(liveInput?.prompt).not.toContain("/legacy/");

    await rm(join(CACHE_ROOT, SESSION_ID, "assets"), { recursive: true, force: true });
    const rollover = await builder.prepareBackendRolloverTurnInput(
      task,
      claudeAgent,
      initial,
      "backend-old",
    );
    const rolloverParams = await collectExecuteParams(task, claudeAgent, rollover);
    expect(rolloverParams.imageAttachmentPaths).toEqual([IMAGE_PATH]);
    expect(rolloverParams.prompt).toContain(`[첨부 파일 로컬 경로: ${TEXT_PATH}]`);
    expect(rollover.attachmentSource).toMatchObject({ text: task.prompt, attachmentIds });
    for (const [path, bytes] of [[IMAGE_PATH, imageBytes], [TEXT_PATH, textBytes]] as const) {
      const cached = await readFile(path);
      expect(cached).toEqual(bytes);
      expect(sha256(cached)).toBe(sha256(bytes));
    }
    expect(fixture.contentGets).toEqual(new Map([[IMAGE_ID, 2], [TEXT_ID, 2]]));
    expect(fixture.requestedUrls.every((url) => new URL(url).origin === "http://orch.test")).toBe(true);
    expect(fixture.requestedUrls.every((url) => new URL(url).pathname.includes("/api/attachments/worker/"))).toBe(true);
  });

  it("does not call the engine when attachment preparation fails", async () => {
    const materializer = createAttachmentMaterializer({
      incomingDir: CACHE_ROOT,
      nodeId: "eiaserinnys",
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("central attachment unavailable");
      }),
    });
    const engine: EnginePort = {
      backendId: claudeAgent.backend,
      workspaceDir: claudeAgent.workspace_dir,
      execute: vi.fn(async function* (_params: EngineExecuteParams): AsyncGenerator<never> {}),
      intervene: vi.fn(async () => ({ status: "not_delivered", mechanism: "unsupported" })),
      interrupt: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    const persistence = makeEventPersistenceTestDouble();
    const executor = new TaskExecutor(
      () => engine,
      {} as SessionDB,
      persistence.persistence,
      {
        emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
        emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionBroadcaster,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createAttachmentInputPreparer(materializer),
    );
    const task = makeTask({ attachmentIds, attachmentPaths, attachmentBindings });

    await executor.startExecutionWithRunner(
      task,
      claudeAgent,
      createInProcessTaskRunnerRuntime(engine),
    );

    expect(engine.execute).not.toHaveBeenCalled();
    expect(task.status).toBe("error");
  });
});

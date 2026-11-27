import { afterEach, describe, expect, it, vi } from "vitest";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";
import { parsePersistentInstructionsApplyPayload } from
  "@soulstream/wire-schema/persistent-session-instructions";

import type { SessionActionCommandDispatchOptions } from
  "../src/session/session_action_command_errors.js";
import {
  createLiveTurnSummaryPipeline,
  createPersistentInstructionCommandSender,
} from
  "../src/turn-summary/live_turn_summary_pipeline.js";
import type { TurnSummaryConfig } from "../src/turn-summary/turn_summary_config.js";
import type { PersistentInstructionExtractor } from
  "../src/turn-summary/persistent_instruction_extractor.js";

const liveFactoryMocks = vi.hoisted(() => ({
  pipelineDeps: undefined as unknown,
  storyDeps: undefined as unknown,
  generate: vi.fn(),
  summarize: vi.fn(),
  catchUpStart: vi.fn(),
  catchUpStop: vi.fn(),
  catchUpDrain: vi.fn(),
}));

vi.mock("../src/turn-summary/turn_summary_catch_up_sweep.js", () => ({
  TurnSummaryCatchUpSweep: class {
    start(): void {
      liveFactoryMocks.catchUpStart();
    }
    stop(): void {
      liveFactoryMocks.catchUpStop();
    }
    async drain(): Promise<void> {
      await liveFactoryMocks.catchUpDrain();
    }
  },
}));

vi.mock("../src/turn-summary/session_story_completion_sweep.js", () => ({
  SessionStoryCompletionSweep: class {
    start(): void {}
    stop(): void {}
    async drain(): Promise<void> {}
  },
}));

vi.mock("../src/turn-summary/session_story_fold_service.js", () => ({
  SessionStoryFoldService: class {
    constructor(deps: unknown) {
      liveFactoryMocks.storyDeps = deps;
    }
  },
}));

vi.mock("../src/turn-summary/turn_summary_pipeline.js", () => ({
  TurnSummaryPipeline: class {
    constructor(deps: unknown) {
      liveFactoryMocks.pipelineDeps = deps;
    }
    accept(): void {}
    async drain(): Promise<void> {}
  },
}));

vi.mock("../src/turn-summary/codex_exec_turn_summarizer.js", () => ({
  CodexExecTurnSummarizer: class {
    generate(...args: unknown[]) {
      return liveFactoryMocks.generate(...args);
    }
    summarize(...args: unknown[]) {
      return liveFactoryMocks.summarize(...args);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("persistent instruction command sender", () => {
  it("routes the H1 body in the settings command envelope", async () => {
    const routedCommand = { command: { message: {} }, node: { nodeId: "node-a" } };
    const routeExistingSessionPendingCommand = vi.fn()
      .mockResolvedValue(routedCommand);
    const sendPendingCommand = vi.fn().mockResolvedValue({
      type: "persistent_session_instructions_applied",
    });
    const sender = createPersistentInstructionCommandSender({
      router: { routeExistingSessionPendingCommand } as unknown as
        SessionActionCommandDispatchOptions["router"],
      bridge: { sendPendingCommand } as unknown as
        SessionActionCommandDispatchOptions["bridge"],
      timeoutMs: 4321,
    });

    await sender({
      session_id: "session-a",
      origin: "extracted",
      ops: [{
        op: "add",
        text: "앞으로 응답은 간결하게 써 줘.",
        source_turns: ["T5"],
        source_event_ids: [10],
      }],
      anchor: "input-10",
    });

    const outgoingPayload = routeExistingSessionPendingCommand.mock.calls[0]?.[0];
    expect(outgoingPayload).toEqual({
      type: "apply_persistent_session_instructions",
      agentSessionId: "session-a",
      origin: "extracted",
      ops: [{
        op: "add",
        text: "앞으로 응답은 간결하게 써 줘.",
        source_turns: ["T5"],
        source_event_ids: [10],
      }],
      anchor: "input-10",
    });
    expect(outgoingPayload).not.toHaveProperty("session_id");
    expect(routeExistingSessionPendingCommand).toHaveBeenCalledWith(
      outgoingPayload,
      { timeoutMs: 4321 },
    );
    expect(parsePersistentInstructionsApplyPayload({
      session_id: outgoingPayload.agentSessionId,
      origin: outgoingPayload.origin,
      ops: outgoingPayload.ops,
      ...(outgoingPayload.anchor === undefined
        ? {}
        : { anchor: outgoingPayload.anchor }),
    })).toMatchObject({ ok: true });
    expect(sendPendingCommand).toHaveBeenCalledWith(routedCommand);
  });
});

describe("live turn summary pipeline sweeps", () => {
  it("starts and drains the turn-summary catch-up sweep", async () => {
    const pipeline = createLiveTurnSummaryPipeline({
      config: {
        codex_cli_path: "codex",
        typesafe_api_key: undefined,
      } as never,
      configPath: "unused-turn-summary.yaml",
      modelCatalog: repositoryModelCatalog(),
      sqlResolver: {} as never,
      registry: { isAntigravityEnabled: () => true } as never,
      eventHub: { publish: vi.fn() } as never,
      commands: { router: {} as never, bridge: {} as never, timeoutMs: 100 },
      sessionBroadcaster: { append: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
      warn: vi.fn(),
      overrides: { turnSummaryCodexPath: "/codex" },
    });

    pipeline.start?.();
    await pipeline.drain();

    expect(liveFactoryMocks.catchUpStart).toHaveBeenCalledTimes(1);
    expect(liveFactoryMocks.catchUpStop).toHaveBeenCalledTimes(1);
    expect(liveFactoryMocks.catchUpDrain).toHaveBeenCalledTimes(1);
  });
});

describe("live persistent instruction extractor wiring", () => {
  it("uses the existing Typesafe key and Codex generator with Sol limits", async () => {
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      answers: { long_term_correction: { noul: 0.8 } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    liveFactoryMocks.generate.mockResolvedValue({
      content: JSON.stringify({ standing_instructions: [] }),
      model: "gpt-6.1-sol",
      latencyMs: 1,
      attempts: 1,
    });

    createLiveTurnSummaryPipeline({
      config: {
        codex_cli_path: "codex",
        typesafe_api_key: "test-typesafe-key",
      } as never,
      configPath: "unused-turn-summary.yaml",
      modelCatalog: repositoryModelCatalog(),
      sqlResolver: {} as never,
      registry: { isAntigravityEnabled: () => true } as never,
      eventHub: { publish: vi.fn() } as never,
      commands: { router: {} as never, bridge: {} as never, timeoutMs: 100 },
      sessionBroadcaster: { append: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
      warn: vi.fn(),
      overrides: { turnSummaryCodexPath: "/codex" },
    });

    const dependencies = liveFactoryMocks.pipelineDeps as {
      persistentInstructionExtractor: PersistentInstructionExtractor;
    };
    await dependencies.persistentInstructionExtractor.extract({
      userText: "앞으로 답변 전에 근거를 확인해 줘.",
      activeInstructions: [],
    }, {
      enabled: true,
      instruction: "summary config",
      storyInstruction: "story config",
      storyFoldThreshold: 10,
      storyFoldBatchSize: 5,
      storyFoldMaxBatchesPerRun: 4,
      storyCompletedFoldMaxSummaries: 40,
      storyCompletionGraceMs: 100,
      storyCompletionMinSummaries: 1,
      storyCompletionSweepIntervalMs: 100,
      storyNarrativeMaxChars: 100,
      storyTimeoutMs: 90_000,
      fallbackTimeoutMs: 90_000,
      storyFoldFailureCooldownMs: 900_000,
      catchUpIntervalMs: 900_000,
      catchUpWindowHours: 72,
      catchUpMaxJobsPerRound: 100,
      provider: "codex",
      model: "gpt-5.6-luna",
      storyModel: "gpt-5.6-luna",
      preferredStages: [],
      reasoningEffort: "high",
      instructionExtractionModel: "gpt-6.2-sol",
      instructionExtractionReasoningEffort: "high",
      timeoutMs: 1_234,
      maxAttempts: 2,
      codexConcurrencyLimit: 3,
      codepointLimit: 100,
      historyLimit: 0,
      excludedFolderIds: [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-typesafe-key",
    });
    expect(liveFactoryMocks.generate).toHaveBeenCalledTimes(1);
    expect(liveFactoryMocks.generate.mock.calls[0]?.[1]).toMatchObject({
      model: "gpt-6.2-sol",
      reasoningEffort: "high",
      timeoutMs: 1_234,
      codexConcurrencyLimit: 3,
    });
    expect(liveFactoryMocks.generate.mock.calls[0]?.[2]).toMatchObject({
      maxAttempts: 1,
      outputSchema: { required: ["standing_instructions"] },
    });
  });
});

describe("live model chain wiring", () => {
  const limit = (code: string) => Object.assign(new Error(code), { code });
  const stageConfig: TurnSummaryConfig = {
    enabled: true,
    instruction: "summary config",
    storyInstruction: "story config",
    storyFoldThreshold: 10,
    storyFoldBatchSize: 5,
    storyFoldMaxBatchesPerRun: 4,
    storyCompletedFoldMaxSummaries: 40,
    storyCompletionGraceMs: 100,
    storyCompletionMinSummaries: 1,
    storyCompletionSweepIntervalMs: 100,
    storyNarrativeMaxChars: 100,
    storyTimeoutMs: 90_000,
    fallbackTimeoutMs: 90_000,
    storyFoldFailureCooldownMs: 900_000,
    catchUpIntervalMs: 900_000,
    catchUpWindowHours: 72,
    catchUpMaxJobsPerRound: 100,
    provider: "codex",
    model: "gpt-5.6-luna",
    storyModel: "gpt-5.6-terra",
    preferredStages: [
      { backend: "claude", model: "sonnet" },
      { backend: "antigravity", model: "gemini-4-hydrogen" },
    ],
    reasoningEffort: "high",
    instructionExtractionModel: "gpt-6.2-sol",
    instructionExtractionReasoningEffort: "xhigh",
    timeoutMs: 1_234,
    maxAttempts: 2,
    codexConcurrencyLimit: 3,
    codepointLimit: 100,
    historyLimit: 0,
    excludedFolderIds: [],
  };
  const result = (model: string, content = "요약") => ({
    content, model, latencyMs: 1, attempts: 1, spawnDurationMs: 1, peakConcurrentSpawns: 1,
  });

  function wire(claudeGenerate: ReturnType<typeof vi.fn>, agyGenerate: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      answers: { long_term_correction: { noul: 0.8 } },
    }), { status: 200 })));
    createLiveTurnSummaryPipeline({
      config: { codex_cli_path: "codex", typesafe_api_key: "test-typesafe-key" } as never,
      configPath: "unused-turn-summary.yaml",
      modelCatalog: repositoryModelCatalog(),
      sqlResolver: {} as never,
      registry: { isAntigravityEnabled: () => true } as never,
      eventHub: { publish: vi.fn() } as never,
      commands: { router: {} as never, bridge: {} as never, timeoutMs: 100 },
      sessionBroadcaster: { append: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
      warn: vi.fn(),
      claudeExecutor: { generate: claudeGenerate },
      antigravityExecutor: { generate: agyGenerate },
      overrides: { turnSummaryCodexPath: "/codex" },
    });
    return {
      dependencies: liveFactoryMocks.pipelineDeps as {
        persistentInstructionExtractor: PersistentInstructionExtractor;
        summarizer: { summarize: (...args: unknown[]) => Promise<{ model: string }> };
      },
      story: liveFactoryMocks.storyDeps as {
        generator: { generate: (...args: unknown[]) => Promise<{ model: string }> };
      },
    };
  }

  it("sends instruction extraction to claude with the claude preset model and the extraction effort", async () => {
    const claudeGenerate = vi.fn(async (request: { model: string }) =>
      result(request.model, JSON.stringify({ standing_instructions: [] })));
    const agyGenerate = vi.fn();
    const { dependencies } = wire(claudeGenerate, agyGenerate);

    await dependencies.persistentInstructionExtractor.extract(
      { userText: "앞으로 답변 전에 근거를 확인해 줘.", activeInstructions: [] },
      stageConfig,
    );

    expect(claudeGenerate).toHaveBeenCalledTimes(1);
    expect(claudeGenerate.mock.calls[0]![0]).toMatchObject({
      model: "sonnet",
      reasoningEffort: "xhigh",
      timeoutMs: 1_234,
      concurrencyLimit: 3,
      outputSchema: expect.objectContaining({ required: ["standing_instructions"] }),
    });
    expect(agyGenerate).not.toHaveBeenCalled();
    expect(liveFactoryMocks.generate).not.toHaveBeenCalled();
  });

  it("folds stories on claude then codex without ever calling antigravity", async () => {
    const claudeGenerate = vi.fn(async () => { throw limit("CLAUDE_USAGE_LIMIT"); });
    const agyGenerate = vi.fn();
    liveFactoryMocks.generate.mockResolvedValue(result("gpt-5.6-terra", "접기"));
    const { story } = wire(claudeGenerate, agyGenerate);

    const folded = await story.generator.generate(
      "접기", { ...stageConfig, model: stageConfig.storyModel }, { maxAttempts: 1 },
    );

    expect(folded).toMatchObject({ model: "gpt-5.6-terra" });
    expect(claudeGenerate).toHaveBeenCalledTimes(1);
    expect(agyGenerate).not.toHaveBeenCalled();
    expect(liveFactoryMocks.generate).toHaveBeenCalledTimes(1);
    expect(liveFactoryMocks.generate.mock.calls[0]![1]).toMatchObject({ model: "gpt-5.6-terra" });
  });

  it("sends summaries to antigravity when claude is out of quota", async () => {
    const claudeGenerate = vi.fn(async () => { throw limit("CLAUDE_USAGE_LIMIT"); });
    const agyGenerate = vi.fn(async (request: { model: string }) => result(request.model));
    const { dependencies } = wire(claudeGenerate, agyGenerate);

    await expect(dependencies.summarizer.summarize(
      { userText: "u", assistantText: "a", previousSummaries: [] }, stageConfig,
    )).resolves.toMatchObject({ model: "gemini-4-hydrogen" });
    expect(liveFactoryMocks.generate).not.toHaveBeenCalled();
  });
});

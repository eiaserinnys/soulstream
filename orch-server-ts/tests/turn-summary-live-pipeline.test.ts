import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePersistentInstructionsApplyPayload } from
  "@soulstream/wire-schema/persistent-session-instructions";

import type { SessionActionCommandDispatchOptions } from
  "../src/session/session_action_command_errors.js";
import {
  createLiveTurnSummaryPipeline,
  createPersistentInstructionCommandSender,
} from
  "../src/turn-summary/live_turn_summary_pipeline.js";
import type { PersistentInstructionExtractor } from
  "../src/turn-summary/persistent_instruction_extractor.js";

const liveFactoryMocks = vi.hoisted(() => ({
  pipelineDeps: undefined as unknown,
  generate: vi.fn(),
  summarize: vi.fn(),
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
      sqlResolver: {} as never,
      registry: {} as never,
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
      storyCompletionGraceMs: 100,
      storyCompletionMinSummaries: 1,
      storyCompletionSweepIntervalMs: 100,
      storyNarrativeMaxChars: 100,
      provider: "codex",
      model: "gpt-5.6-luna",
      storyModel: "gpt-5.6-luna",
      reasoningEffort: "high",
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
      model: "gpt-6.1-sol",
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

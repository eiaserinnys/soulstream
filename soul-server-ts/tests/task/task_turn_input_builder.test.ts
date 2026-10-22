import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import { SessionDataHostError } from "../../src/control_plane/session_data_host_client.js";
import { ExecutionContextBuilder, type ExecutionContextBuilder as ExecutionContextBuilderPort, type PreparedContext } from "../../src/context/context_builder.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  CLAUDE_ROLLOVER_PROMPT_MAX_CHARS,
  CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS,
  CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS,
  CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS,
  type TaskInitialMessagePublisherPort,
  buildFollowupInputUuid,
  TaskTurnInputBuilder,
} from "../../src/task/task_turn_input_builder.js";
import { estimateClaudeTextTokens } from "../../src/task/claude_context_recovery.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskInitialMessagePublisher } from "../../src/task/task_initial_message_publisher.js";
import type { Task } from "../../src/task/task_models.js";
import { createInputMaterialPart } from "../../src/context/input_material_parts.js";

const claudeAgent: AgentProfile = {
  id: "claude-default",
  name: "Claude Default",
  backend: "claude",
  workspace_dir: "/tmp/claude-default",
};

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-turn-input",
    prompt: "사용자 요청",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<PreparedContext> = {}): PreparedContext {
  return {
    effectiveSystemPrompt: "system instructions",
    combinedContextItems: [{ key: "session_context", label: "Session", content: "session facts" }],
    assembledPrompt: "사용자 요청",
    inputMaterialBreakdown: {
      systemParts: [createInputMaterialPart(
        "system_prompt",
        "system/task_system_prompt",
        "system instructions",
        0,
      )],
      contextParts: [[createInputMaterialPart(
        "soulstream_injection",
        "source/atom/node-1/0",
        "session facts",
        3,
      )]],
    },
    ...overrides,
  };
}

type ContextManifestSourceStatus =
  NonNullable<PreparedContext["contextManifest"]>["sources"][number]["status"];

function makeContextManifest(
  sources: Array<{ nodeId: string; status: ContextManifestSourceStatus }>,
): NonNullable<PreparedContext["contextManifest"]> {
  return {
    compiler_version: "phase-a.v1",
    spec_hash: "turn-input-test",
    source_count: sources.length,
    total_chars: sources.filter((source) => source.status === "ok").length,
    total_token_estimate: 0,
    sources: sources.map((source, index) => ({
      id: `source-${index}`,
      label: `Source ${index}`,
      instance: "atom",
      node_id: source.nodeId,
      mode: "full",
      depth: 5,
      titles_only: false,
      include_ids: true,
      priority: index,
      never_truncate: false,
      chars: source.status === "ok" ? 1 : 0,
      token_estimate: 0,
      status: source.status,
      truncated: false,
      anchor_count: 0,
    })),
  };
}

function makeSubject(options: {
  contextBuilder?: Partial<{
    build: ReturnType<typeof vi.fn>;
    buildSystemPrompt: ReturnType<typeof vi.fn>;
    buildFollowupContext: ReturnType<typeof vi.fn>;
    buildBackendRolloverContext: ReturnType<typeof vi.fn>;
    buildGenerationContext: ReturnType<typeof vi.fn>;
  }>;
  initialMessagePublisher?: Partial<{ publishInitialMessages: ReturnType<typeof vi.fn>;
    publishContextManifestBestEffort: ReturnType<typeof vi.fn> }>;
  prepareAttachmentInput?: ReturnType<typeof vi.fn>;
  waitForAttachmentRefs?: ReturnType<typeof vi.fn>;
} = {}) {
  const contextBuilder = {
    build: vi.fn().mockResolvedValue(makeContext()),
    buildSystemPrompt: vi.fn().mockResolvedValue("resume system instructions"),
    buildFollowupContext: vi.fn().mockResolvedValue({
      contextItems: [
        {
          key: "running_sessions",
          label: "Running Sessions",
          content: { status: "ok", sessions: [] },
        },
      ],
    }),
    buildBackendRolloverContext: vi.fn().mockResolvedValue({
      effectiveSystemPrompt: "rollover system instructions",
      contextItems: [],
      currentSessionExcerpt: { totalEvents: 0, turns: [] },
    }),
    buildGenerationContext: vi.fn().mockResolvedValue({
      ...makeContext(),
      checkpointStats: {
        estimatedTokens: 321,
        chars: 987,
        sections: { state: 111, story: 222, summaries: 333, recent: 321 },
        summarizedThroughTurn: 4,
        recentFromEventId: 10,
        recentToEventId: 12,
      },
    }),
    ...options.contextBuilder,
  };
  const initialMessagePublisher = {
    publishInitialMessages: vi.fn().mockResolvedValue(undefined),
    publishContextManifestBestEffort: vi.fn().mockResolvedValue(undefined),
    ...options.initialMessagePublisher,
  };
  const logger = { warn: vi.fn() } as unknown as Logger;
  const builder = new TaskTurnInputBuilder({
    contextBuilder: contextBuilder as unknown as ExecutionContextBuilderPort,
    initialMessagePublisher: initialMessagePublisher as unknown as TaskInitialMessagePublisherPort,
    logger,
    prepareAttachmentInput: options.prepareAttachmentInput,
    waitForAttachmentRefs: options.waitForAttachmentRefs,
  });

  return {
    builder,
    contextBuilder,
    initialMessagePublisher,
    logger,
  };
}

describe("TaskTurnInputBuilder", () => {
  it("waits for initial attachment refs and prepares an execution copy", async () => {
    const order: string[] = [];
    const task = makeTask({
      prompt: "",
      attachmentIds: ["asset-1"],
      attachmentPaths: ["/legacy/photo.png"],
      attachmentBindings: [{ attachment_id: "asset-1", path: "/legacy/photo.png" }],
      executionRegistration: {
        registrationId: "registration-initial",
        executionCommandId: "command:initial",
      },
    });
    const prepareAttachmentInput = vi.fn(async (source) => {
      order.push("prepare");
      return {
        text: source.text,
        attachmentPaths: ["/cache/photo.png", "/cache/report.txt"],
        imageAttachmentPaths: ["/cache/photo.png"],
      };
    });
    const { builder } = makeSubject({
      waitForAttachmentRefs: vi.fn(async () => {
        order.push("ack");
      }),
      prepareAttachmentInput,
    });
    const original = { prompt: task.prompt, ids: task.attachmentIds, paths: task.attachmentPaths };
    const input = await builder.prepareInitialTurnInput(task, claudeAgent);
    expect(order).toEqual(["ack", "prepare"]);
    expect(prepareAttachmentInput).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      attachmentIds: ["asset-1"],
      deliveryId: "command:initial",
    }));
    expect(input.originalPrompt).toBe("");
    expect(input.prompt).toContain("[첨부 파일 로컬 경로: /cache/photo.png]");
    expect(input.prompt).not.toContain("/legacy/photo.png");
    expect(input.imageAttachmentPaths).toEqual(["/cache/photo.png"]);
    expect(input.attachmentSource).toMatchObject({ text: "", attachmentIds: ["asset-1"] });
    expect(task.prompt).toBe(original.prompt);
    expect(task.attachmentIds).toBe(original.ids);
    expect(task.attachmentPaths).toBe(original.paths);
  });

  it("prepares follow-up copies but returns the original intervention", async () => {
    const interventions = [{ text: "이 파일도 확인해줘", user: "u", deliveryId: "delivery-followup",
      attachmentIds: ["asset-2"], attachmentPaths: ["/legacy/report.pdf"],
      attachmentBindings: [{ attachment_id: "asset-2", path: "/legacy/report.pdf" }] }];
    const prepareAttachmentInput = vi.fn().mockResolvedValue({
      text: interventions[0]!.text,
      attachmentPaths: ["/cache/report.pdf"], imageAttachmentPaths: [],
    });
    const waitForAttachmentRefs = vi.fn(async () => undefined);
    const { builder } = makeSubject({ prepareAttachmentInput, waitForAttachmentRefs });

    const input = await builder.prepareFollowupTurnInput(makeTask(), claudeAgent, interventions);

    expect(prepareAttachmentInput.mock.calls[0]?.[0]).toMatchObject({ attachmentIds: ["asset-2"], deliveryId: "delivery-followup" });
    expect(input.prompt).toContain("[첨부 파일 로컬 경로: /cache/report.pdf]");
    expect(input.prompt).not.toContain("/legacy/report.pdf");
    expect(input.interventions).toBe(interventions);
    expect(interventions[0]?.attachmentPaths).toEqual(["/legacy/report.pdf"]);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length);
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "intervention/0/user",
      category: "user_prompt",
    }));
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "followup/context/0",
      category: "soulstream_injection",
    }));
  });

  it("re-materializes the initial source on backend rollover", async () => {
    const source = { sessionId: "sess-turn-input", text: "원본 요청", attachmentIds: ["asset-3"],
      attachmentPaths: ["/legacy/photo.png"], attachmentBindings: [{ attachment_id: "asset-3", path: "/legacy/photo.png" }] };
    const paths = ["/cache/first/photo.png", "/cache/second/photo.png"];
    const prepareAttachmentInput = vi.fn(async (input) => ({
      text: input.text,
      attachmentPaths: [paths[prepareAttachmentInput.mock.calls.length - 1]!],
      imageAttachmentPaths: [paths[prepareAttachmentInput.mock.calls.length - 1]!],
    }));
    const { builder } = makeSubject({ prepareAttachmentInput });
    const failedInput = { prompt: "previous runtime prompt", originalPrompt: "원본 요청",
      imageAttachmentPaths: ["/old-cache/photo.png"], attachmentSource: source };
    const first = await builder.prepareBackendRolloverTurnInput(makeTask(), claudeAgent, failedInput, "backend-old");
    const second = await builder.prepareBackendRolloverTurnInput(makeTask(), claudeAgent, first, "backend-next");
    expect(prepareAttachmentInput).toHaveBeenCalledTimes(2);
    expect(second.prompt).toContain("/cache/second/photo.png");
    expect(second.prompt).not.toContain("/old-cache/photo.png");
    expect(second.imageAttachmentPaths).toEqual(["/cache/second/photo.png"]);
    expect(second.attachmentSource?.text).toBe("원본 요청");
  });

  it("rejects ID-managed initial inputs when preparation is not configured", async () => {
    const task = makeTask({ attachmentIds: ["asset-4"] });
    const { builder } = makeSubject();

    await expect(builder.prepareInitialTurnInput(task, claudeAgent))
      .rejects.toThrow("ATTACHMENT_INPUT_UNAVAILABLE");
    const failure = new Error("prepare failed");
    const { builder: failingBuilder } = makeSubject({ prepareAttachmentInput: vi.fn().mockRejectedValue(failure) });
    await expect(failingBuilder.prepareInitialTurnInput(task, claudeAgent)).rejects.toBe(failure);
  });

  it("waits for creation effects before first-turn context build", async () => {
    let finishCreationEffects!: () => void;
    const creationEffects = new Promise<void>((resolve) => {
      finishCreationEffects = resolve;
    });
    const task = makeTask({ creationEffects });
    const { builder, contextBuilder } = makeSubject();

    const turnInput = builder.prepareInitialTurnInput(task, claudeAgent);

    expect(contextBuilder.build).not.toHaveBeenCalled();
    finishCreationEffects();
    await turnInput;

    expect(contextBuilder.build).toHaveBeenCalledWith(task, claudeAgent);
  });

  it.each(["claude", "antigravity", "opencode"] as const)("prepares a new %s turn by splitting systemPrompt from prompt text", async (backend) => {
    const agent = { ...claudeAgent, backend };
    const ctx = makeContext();
    const task = makeTask({
      attachmentPaths: ["/tmp/incoming/sess/screen.png", "/tmp/incoming/sess/readme.txt"],
    });
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockResolvedValue(ctx) },
    });

    const input = await builder.prepareInitialTurnInput(task, agent);

    expect(contextBuilder.build).toHaveBeenCalledWith(task, agent);
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, ctx);
    expect(input.systemPrompt).toBe("system instructions");
    expect(input.prompt).toContain("<session_context>");
    expect(input.prompt).toContain("session facts");
    expect(input.prompt).not.toContain("system instructions");
    expect(input.prompt.endsWith("사용자 요청")).toBe(true);
    expect(input.imageAttachmentPaths).toEqual(["/tmp/incoming/sess/screen.png"]);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length + input.systemPrompt!.length);
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "system/task_system_prompt",
      approximate_tokens: 0,
      estimate_source: "manifest",
    }));
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "context/0/atom/source/atom/node-1/0",
      approximate_tokens: 3,
      estimate_source: "manifest",
    }));
  });

  it.each(["antigravity", "claude", "opencode"] as const)("preserves the approved empty-instruction first turn for %s", async backend => {
    const { builder } = makeSubject({ contextBuilder: { build: vi.fn().mockResolvedValue({ ...makeContext(), effectiveSystemPrompt: undefined }) } });
    const input = await builder.prepareInitialTurnInput(makeTask(), { ...claudeAgent, backend });
    expect(input.systemPrompt).toBe(backend === "antigravity" || backend === "opencode" ? "" : undefined);
  });

  it("binds the initial public message, prepared context, and engine input to one registered input UUID", async () => {
    const task = makeTask({ executionRegistration: {
      registrationId: "registration-initial",
      executionCommandId: "command:initial",
    } });
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject();

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);
    const inputUuid = buildDeliveryInputUuid("command:initial");

    expect(contextBuilder.build).toHaveBeenCalledWith(task, claudeAgent, inputUuid);
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, expect.any(Object), inputUuid);
    expect(input.inputUuid).toBe(inputUuid);
  });

  it("prepares a new Codex turn by prepending systemPrompt into the prompt body", async () => {
    const { builder } = makeSubject();

    const input = await builder.prepareInitialTurnInput(makeTask(), codexAgent);

    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).toContain("system instructions");
    expect(input.prompt).toContain("<session_context>");
    expect(input.prompt.endsWith("사용자 요청")).toBe(true);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length);
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "initial/user",
      category: "user_prompt",
    }));
  });

  it("starts an applying generation from checkpoint context plus the queued input", async () => {
    const task = makeTask({
      codexThreadId: "native-old",
      modelPresetBackend: "claude",
      activeGenerationRollover: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-05T00:00:00.000Z",
        fromBackendSessionId: "native-old",
        previousBackend: "claude",
        previousModelPreset: "claude-default",
      },
      needsFullContextReinjection: true,
      interventionQueue: [{
        text: "이번 요청",
        deliveryId: "delivery-generation-1",
        runnerInterventionId: "runner-intervention-1",
        callerInfo: { source: "browser", display_name: "서소영" },
        context: [
          { key: "assigned_cards", label: "stale", content: "stale assigned cards" },
          { key: "delivery_context", label: "Delivery", content: "delivery facts" },
        ],
        attachmentIds: ["generation-id"],
        attachmentPaths: ["/legacy/generation.png"],
        attachmentBindings: [{ attachment_id: "generation-id", path: "/legacy/generation.png" }],
      }],
    });
    const manifest = { compiler_version: "phase-a.v1", spec_hash: "generation-spec",
      source_count: 0, total_chars: 12, total_token_estimate: 3, sources: [] };
    const enqueueEvent = vi.fn().mockResolvedValue(undefined);
    const manifestPublisher = new TaskInitialMessagePublisher({
      persistence: { enqueueEvent } as never,
      broadcaster: {} as never,
      logger: { warn: vi.fn() } as unknown as Logger,
    });
    const prepareAttachmentInput = vi.fn().mockResolvedValue({
      text: "이번 요청", attachmentPaths: ["/cache/generation.png"],
      imageAttachmentPaths: ["/cache/generation.png"],
    });
    const waitForAttachmentRefs = vi.fn().mockResolvedValue(undefined);
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject({
      prepareAttachmentInput,
      waitForAttachmentRefs,
      initialMessagePublisher: { publishContextManifestBestEffort: vi.fn(
        (task, manifest) => manifestPublisher.publishContextManifestBestEffort(task, manifest),
      ) },
    });
    const context = await contextBuilder.buildGenerationContext();
    contextBuilder.buildGenerationContext.mockClear();
    contextBuilder.buildGenerationContext.mockResolvedValue({ ...context, contextManifest: manifest });

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledTimes(1);
    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledWith(task, manifest);
    expect(enqueueEvent.mock.calls).toEqual([[task.agentSessionId, { type: "context_manifest", ...manifest }]]);
    expect(contextBuilder.buildGenerationContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      buildDeliveryInputUuid("delivery-generation-1"),
    );
    expect(contextBuilder.buildFollowupContext).not.toHaveBeenCalled();
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
    expect(input.systemPrompt).toBe("system instructions");
    expect(input.prompt).toContain("session facts");
    expect(input.prompt).toContain("이번 요청");
    expect(input.prompt).toContain("[첨부 파일 로컬 경로: /cache/generation.png]");
    expect(input.prompt).toContain("delivery facts");
    expect(input.prompt).not.toContain("system instructions");
    expect(input.prompt).not.toContain("stale assigned cards");
    expect(input.backendSessionRolloverFrom).toBe("native-old");
    expect(input.generationRollover).toBe(true);
    expect(input.inputUuid).toBe(buildDeliveryInputUuid("delivery-generation-1"));
    expect(input.runnerInterventionId).toBe("runner-intervention-1");
    expect(input.runnerInterventionIds).toEqual(["runner-intervention-1"]);
    expect(input.turnOrigin).toEqual({
      kind: "user_message",
      id: "delivery-generation-1",
    });
    expect(input.generationCheckpointStats).toMatchObject({
      estimatedTokens: 321,
      chars: 987,
    });
    expect(waitForAttachmentRefs).toHaveBeenCalledWith(task.agentSessionId);
    expect(prepareAttachmentInput).toHaveBeenCalledTimes(1);
    expect(input.imageAttachmentPaths).toEqual(["/cache/generation.png"]);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length + input.systemPrompt!.length);
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      category: "system_prompt",
      source_key: "system/task_system_prompt",
      approximate_tokens: 0,
      estimate_source: "manifest",
    }));
    expect(input.interventions?.[0]).toMatchObject({
      attachmentIds: ["generation-id"], attachmentPaths: ["/legacy/generation.png"],
    });
    expect(task.interventionQueue).toEqual([]);
    expect(task.needsFullContextReinjection).toBe(false);
  });

  it("passes systemPrompt on the first Antigravity generation input", async () => {
    const task = makeTask({
      codexThreadId: "native-old",
      modelPresetBackend: "antigravity",
      activeGenerationRollover: {
        number: 2,
        reason: "automatic fallback",
        requestedAt: "2026-10-05T00:00:00.000Z",
        fromBackendSessionId: "native-old",
        previousBackend: "claude",
        previousModelPreset: "claude-default",
      },
      needsFullContextReinjection: true,
      interventionQueue: [{ text: "다음 요청", user: "Alice" }],
    });
    const { builder } = makeSubject();

    const input = await builder.prepareInitialTurnInput(task, { ...claudeAgent, backend: "antigravity" });

    expect(input.generationRollover).toBe(true);
    expect(input.systemPrompt).toBe("system instructions");
    expect(input.prompt).not.toContain("system instructions");
  });

  it("rejects an applying generation when its context manifest has an error source", async () => {
    const task = makeTask({
      codexThreadId: "native-old",
      modelPresetBackend: "claude",
      activeGenerationRollover: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-05T00:00:00.000Z",
        fromBackendSessionId: "native-old",
        previousBackend: "claude",
        previousModelPreset: "claude-default",
      },
      interventionQueue: [{
        text: "다음 요청",
        deliveryId: "delivery-generation-error",
        attachmentIds: ["generation-asset"],
        attachmentPaths: ["/tmp/incoming/generation.png"],
        attachmentBindings: [{
          attachment_id: "generation-asset",
          path: "/tmp/incoming/generation.png",
        }],
      }],
    });
    const manifest = makeContextManifest([
      { nodeId: "generation-node-ok", status: "ok" },
      { nodeId: "generation-node-error", status: "error" },
    ]);
    const prepareAttachmentInput = vi.fn().mockResolvedValue({
      text: "다음 요청",
      attachmentPaths: ["/tmp/cache/generation.png"],
      imageAttachmentPaths: ["/tmp/cache/generation.png"],
    });
    const waitForAttachmentRefs = vi.fn().mockResolvedValue(undefined);
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject({
      prepareAttachmentInput,
      waitForAttachmentRefs,
    });
    const generatedContext = await contextBuilder.buildGenerationContext();
    contextBuilder.buildGenerationContext.mockClear();
    contextBuilder.buildGenerationContext.mockResolvedValue({
      ...generatedContext,
      contextManifest: manifest,
    });

    await expect(builder.prepareInitialTurnInput(task, claudeAgent))
      .rejects.toThrow("Atom context compilation failed: generation-node-error");

    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledTimes(1);
    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledWith(task, manifest);
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
    expect(prepareAttachmentInput).not.toHaveBeenCalled();
    expect(waitForAttachmentRefs).not.toHaveBeenCalled();
  });

  it.each([claudeAgent, codexAgent])("carries the built checkpoint instructions into the prepared %s generation input", async (agent) => {
    const scopedAgent = { ...agent, context_scope: "minimal" } as AgentProfile;
    const standingInstructions = Array.from({ length: 36 }, (_, index) => ({
      id: `instruction-${index + 1}`,
      text: index === 35
        ? "카드 이름 인용 규칙: 카드 제목은 원문 그대로 「」로 감싸 정확히 인용한다."
        : `지속 규칙 ${index + 1}: 주어진 정보의 순서를 유지하고 중요한 조건을 빠뜨리지 않는다. 구체적인 근거를 함께 살피고 정확한 표현을 사용한다. 실행 전에 관련 범위를 확인하고 필요 없는 내용을 덧붙이지 않는다.`,
      source_turns: [`T${index + 1}`],
      source_event_ids: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      status: "active",
      origin: "user",
    }));
    const db = {
      getResumeContext: vi.fn().mockResolvedValue({
        session: null,
        folderSessions: { sessions: [], total: 0 },
        runningSessions: { sessions: [], total: 0 },
        predecessor: null,
      }),
      getGenerationCheckpointMaterial: vi.fn().mockResolvedValue({
        story: {
          highlight: null,
          narrative: "",
          unfoldedTurnSummaries: [],
          narrativeThroughEventId: null,
          foldCount: 0,
          updatedAt: null,
        },
        lastSummarizedFinalResponseEventId: null,
        recent: { records: [], omittedUnsummarized: 0 },
        childSessions: [],
        childSessionTotal: 0,
        totals: { events: 0, turnSummaries: 0 },
      }),
      getSupervisedCardContext: vi.fn().mockResolvedValue({
        capturedAt: "2026-10-05T00:00:00.000Z",
        counts: { running: 0, blocked: 0, review: 0, queued: 0, todo: 0 },
        cards: [],
        openQuestions: [],
        openQuestionTotal: 0,
      }),
      getSession: vi.fn().mockResolvedValue(null),
      getFolderById: vi.fn().mockResolvedValue(null),
      getAssignedCardContext: vi.fn().mockResolvedValue({
        capturedAt: "2026-10-05T00:00:00.000Z",
        total: 0,
        omitted: 0,
        cards: [],
      }),
    } as unknown as SessionDB;
    const logger = { warn: vi.fn() } as unknown as Logger;
    const contextBuilder = new ExecutionContextBuilder(
      db,
      new AgentRegistry([scopedAgent]),
      { nodeId: "test-node", atom: { enabled: false, serverUrl: "", apiKey: "" } },
      logger,
    );
    const builder = new TaskTurnInputBuilder({
      contextBuilder,
      initialMessagePublisher: { publishInitialMessages: vi.fn().mockResolvedValue(undefined),
        publishContextManifestBestEffort: vi.fn().mockResolvedValue(undefined) },
      logger,
    });
    const task = makeTask({
      profileId: scopedAgent.id,
      modelPresetBackend: scopedAgent.backend,
      systemPrompt: "generation system prompt",
      metadata: [{ type: "persistent_instructions", value: standingInstructions }] as never,
      activeGenerationRollover: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-05T00:00:00.000Z",
        fromBackendSessionId: "native-old",
        previousBackend: scopedAgent.backend,
        previousModelPreset: scopedAgent.id,
      },
      interventionQueue: [{ text: "계속 진행", user: "사용자" }],
    });

    const input = await builder.prepareInitialTurnInput(task, scopedAgent);

    for (const instruction of standingInstructions) {
      expect(input.prompt).toContain(instruction.text);
    }
    expect(input.prompt).not.toContain("persistent_checkpoint_instructions truncated");
    expect(input.generationCheckpointStats?.estimatedTokens).toBeLessThanOrEqual(20_000);
    if (scopedAgent.backend === "claude") {
      expect(input.systemPrompt).toBe("generation system prompt");
      expect(input.prompt).not.toContain("generation system prompt");
    } else {
      expect(input.systemPrompt).toBeUndefined();
      expect(input.prompt).toContain("generation system prompt");
    }
  });

  it("fails input assembly for an applying generation with an empty queue and preserves the request", async () => {
    const pending = {
      number: 2,
      reason: "context limit",
      requestedAt: "2026-10-05T00:00:00.000Z",
      targetModelPreset: "codex-default",
      applyingFrom: "native-old",
      previousModelPreset: "claude-default",
      previousBackend: "claude" as const,
    };
    const task = makeTask({
      persistent: false,
      codexThreadId: "native-old",
      activeGenerationRollover: {
        number: 2,
        reason: "context limit",
        requestedAt: pending.requestedAt,
        fromBackendSessionId: "native-old",
        previousModelPreset: "claude-default",
        previousBackend: "claude",
      },
      persistentGeneration: { number: 1, pending },
      interventionQueue: [],
    });
    const { builder, contextBuilder } = makeSubject();

    await expect(builder.prepareInitialTurnInput(task, claudeAgent))
      .rejects.toThrow("generation rollover requires a queued intervention");

    expect(contextBuilder.buildGenerationContext).toHaveBeenCalledWith(task, claudeAgent);
    expect(task.persistentGeneration?.pending).toEqual(pending);
    expect(task.activeGenerationRollover?.fromBackendSessionId).toBe("native-old");
  });

  it("rejects a first turn when any context source errors, even if another source is ok", async () => {
    const task = makeTask({ attachmentPaths: ["/tmp/incoming/sess/a.jpg"] });
    const manifest = makeContextManifest([
      { nodeId: "node-error", status: "error" },
      { nodeId: "node-ok", status: "ok" },
    ]);
    const context = makeContext({ contextManifest: manifest });
    const prepareAttachmentInput = vi.fn().mockResolvedValue({
      text: "사용자 요청",
      attachmentPaths: ["/tmp/cache/a.jpg"],
      imageAttachmentPaths: ["/tmp/cache/a.jpg"],
    });
    const { builder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockResolvedValue(context) },
      prepareAttachmentInput,
    });

    await expect(builder.prepareInitialTurnInput(task, claudeAgent))
      .rejects.toThrow("Atom context compilation failed: node-error");

    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledTimes(1);
    expect(initialMessagePublisher.publishContextManifestBestEffort).toHaveBeenCalledWith(task, manifest);
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
    expect(prepareAttachmentInput).not.toHaveBeenCalled();
  });

  it("keeps ok, filtered, and empty context sources eligible for a first turn", async () => {
    const task = makeTask();
    const context = makeContext({
      contextManifest: makeContextManifest([
        { nodeId: "node-ok", status: "ok" },
        { nodeId: "node-filtered", status: "filtered" },
        { nodeId: "node-empty", status: "empty" },
      ]),
    });
    const { builder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockResolvedValue(context) },
    });

    await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(initialMessagePublisher.publishContextManifestBestEffort).not.toHaveBeenCalled();
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, context);
  });

  it("propagates the original context builder failure and does not publish initial messages", async () => {
    const failure = new Error("context down");
    const { builder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockRejectedValue(failure) },
    });

    await expect(builder.prepareInitialTurnInput(makeTask(), claudeAgent))
      .rejects.toBe(failure);
    expect(initialMessagePublisher.publishContextManifestBestEffort).not.toHaveBeenCalled();
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
  });

  it("refuses to start a turn when the session-data host read fails", async () => {
    const failure = new SessionDataHostError({
      operation: "resume_context",
      retryable: true,
      message: "session-data host unavailable",
    });
    const { builder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockRejectedValue(failure) },
    });

    await expect(builder.prepareInitialTurnInput(makeTask(), claudeAgent))
      .rejects.toBe(failure);
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
  });

  it("prepares an auto-resume Claude turn without rebuilding first-turn context", async () => {
    const task = makeTask({
      codexThreadId: "claude-session-1",
      lastInjectedClaudeSessionId: "claude-session-1",
      lastInjectedCallerInfo: { source: "browser", display_name: "Alice" },
      interventionQueue: [
        {
          text: "첨부 확인",
          user: "u",
          context: [{ key: "prior", label: "Prior context", content: "remember this" }],
          attachmentPaths: ["/tmp/incoming/sess/a.png", "/tmp/incoming/sess/readme.txt"],
        },
        { text: "later", user: "u" },
      ],
    });
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject();

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(contextBuilder.build).not.toHaveBeenCalled();
    expect(contextBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({
        includeFullContext: false,
        includeClaudeSessionIdUpdate: false,
        previousCallerInfo: { source: "browser", display_name: "Alice" },
      }),
    );
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
    expect(input.systemPrompt).toBeUndefined();
    expect(input.imageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
    expect(input.prompt).toContain("<prior>");
    expect(input.prompt).toContain("remember this");
    expect(input.prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/a.png]",
    );
    expect(input.prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    );
    expect(input.prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(input.prompt).toContain("later");
    expect(input.prompt).toContain("<running_sessions>");
    expect(input.prompt.endsWith("</context>")).toBe(true);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length);
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "intervention/0/context/0",
      category: "soulstream_injection",
    }));
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "intervention/0/user",
      category: "user_prompt",
    }));
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "intervention/1/user",
      category: "user_prompt",
    }));
    expect(input.inputMaterialParts).toContainEqual(expect.objectContaining({
      source_key: "followup/context/0",
      category: "soulstream_injection",
    }));
    expect(task.interventionQueue).toEqual([]);
  });

  it("does not duplicate the user_message already persisted when auto-resume was accepted", async () => {
    const callerInfo = {
      source: "agent",
      display_name: "서소영",
      agent_id: "seosoyoung",
    };
    const context = [{ key: "handover", label: "Handover", content: "done" }];
    const intervention = {
      text: "후속 확인",
      user: "seosoyoung",
      callerInfo,
      attachmentPaths: ["/tmp/incoming/sess/screen.png"],
      context,
    };
    const task = makeTask({
      prompt: intervention.text,
      clientId: intervention.user,
      callerInfo,
      attachmentPaths: intervention.attachmentPaths,
      contextItems: context,
      codexThreadId: "claude-session-1",
      lastInjectedClaudeSessionId: "claude-session-1",
      interventionQueue: [intervention],
    });
    const persistEvent = vi.fn().mockResolvedValue(88);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;
    const initialMessagePublisher = new TaskInitialMessagePublisher({
      broadcaster: { emitEventEnvelope } as never,
      logger,
      persistence: { persistEvent, handleSideEffects } as never,
    });
    const contextBuilder = {
      build: vi.fn().mockResolvedValue(makeContext()),
      buildSystemPrompt: vi.fn().mockResolvedValue("resume system instructions"),
      buildFollowupContext: vi.fn().mockResolvedValue({
        contextItems: [],
      }),
    };
    const builder = new TaskTurnInputBuilder({
      contextBuilder: contextBuilder as unknown as ExecutionContextBuilderPort,
      initialMessagePublisher,
      logger,
    });

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(contextBuilder.build).not.toHaveBeenCalled();
    expect(contextBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({
        includeFullContext: false,
        includeClaudeSessionIdUpdate: false,
        currentCallerInfo: callerInfo,
      }),
    );
    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).toContain("후속 확인");
    expect(persistEvent).not.toHaveBeenCalled();
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(0);
    expect(task.interventionQueue).toEqual([]);
  });

  it("prepares an auto-resume Codex turn without systemPrompt option", async () => {
    const task = makeTask({
      interventionQueue: [{ text: "codex follow-up", user: "u" }],
    });
    const { builder, contextBuilder } = makeSubject();

    const input = await builder.prepareInitialTurnInput(task, codexAgent);

    expect(contextBuilder.build).not.toHaveBeenCalled();
    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      codexAgent,
      expect.objectContaining({ includeFullContext: false }),
    );
    expect(contextBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).toContain("codex follow-up");
    expect(input.prompt).toContain("<running_sessions>");
  });

  it.each([claudeAgent, codexAgent])("passes the fresh assigned-card block through the shared auto-resume input without start guidance for %s", async (agent) => {
    const { builder } = makeSubject({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({
          contextItems: [{
            key: "assigned_cards",
            content: { trust: "untrusted_card_data", cards: [{ id: "current-card", title: "현재", status: "완료" }] },
          }],
        }),
      },
    });
    const task = makeTask({
      interventionQueue: [{
        text: "이번 카드 작업을 재개해줘",
        user: "u",
        context: [{ key: "assigned_cards", content: { cards: [{ id: "stale-card", status: "todo" }] } }],
      }],
    });

    const input = await builder.prepareInitialTurnInput(task, agent);

    expect(input.prompt).toContain("이번 카드 작업을 재개해줘");
    expect(input.prompt).toContain("<assigned_cards>");
    expect(input.prompt).toContain('"id": "current-card"');
    expect(input.prompt).toContain('"status": "완료"');
    expect(input.prompt).not.toContain("stale-card");
    expect(input.prompt).not.toContain("resume_card_start_guidance");
  });

  it("adds no assigned_cards block to an auto-resume input when the session has no assigned card", async () => {
    const { builder } = makeSubject({
      contextBuilder: { buildFollowupContext: vi.fn().mockResolvedValue({ contextItems: [] }) },
    });
    const task = makeTask({
      interventionQueue: [{
        text: "확인", user: "u",
        context: [{ key: "assigned_cards", content: { cards: [{ id: "stale-card", status: "todo" }] } }],
      }],
    });

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(input.prompt).toContain("확인");
    expect(input.prompt).not.toContain("assigned_cards");
    expect(input.prompt).not.toContain("stale-card");
  });

  it("injects claude_session_id delta only once after it becomes available", async () => {
    const task = makeTask({
      codexThreadId: "claude-session-1",
      interventionQueue: [{ text: "first follow-up", user: "u" }],
    });
    const { builder, contextBuilder } = makeSubject({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({ contextItems: [] }),
      },
    });

    await builder.prepareInitialTurnInput(task, claudeAgent);
    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeClaudeSessionIdUpdate: true }),
    );
    expect(task.lastInjectedClaudeSessionId).toBe("claude-session-1");

    task.interventionQueue.push({ text: "second follow-up", user: "u" });
    await builder.prepareFollowupTurnInput(
      task,
      claudeAgent,
      [task.interventionQueue.shift()!],
    );
    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeClaudeSessionIdUpdate: false }),
    );
  });

  it.each([
    ["cache keepalive", {
      text: "캐시 유지용 호출입니다. 도구를 쓰지 말고 'ok'만 답하십시오.",
      user: "Soulstream Scheduler",
      callerInfo: { source: "system" },
      purpose: "cache_keepalive" as const,
    }, false],
    ["ordinary input", { text: "continue", user: "u" }, true],
  ])("%s %s assigned-card and resource reminder context", async (_label, intervention, shouldIncludeAssignedCards) => {
    const { builder } = makeSubject({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({
          contextItems: [
            { key: "assigned_cards", label: "Assigned Cards", content: "assigned card reminder" },
            { key: "node_resources", label: "노드 자원 상태", content: "node resource status" },
            { key: "running_sessions", label: "Running Sessions", content: "other context" },
          ],
        }),
      },
    });

    const input = await builder.prepareFollowupTurnInput(makeTask(), claudeAgent, [intervention]);

    expect(input.prompt).toContain("other context");
    expect(input.prompt.includes("assigned card reminder")).toBe(shouldIncludeAssignedCards);
    expect(input.prompt.includes("node resource status")).toBe(shouldIncludeAssignedCards);
    expect(input.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(input.prompt.length);
  });

  it("binds a durable delivery to one stable engine input UUID", async () => {
    const deliveryId = "delivery-after-worker-restart";
    const task = makeTask();
    const { builder, contextBuilder } = makeSubject();
    const intervention = {
      text: "replay me exactly once",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification" as const,
    };

    const first = await builder.prepareFollowupTurnInput(
      task,
      claudeAgent,
      [intervention],
    );
    const replay = await builder.prepareFollowupTurnInput(
      task,
      claudeAgent,
      [intervention],
    );

    expect(first.inputUuid).toBe(buildDeliveryInputUuid(deliveryId));
    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(task,claudeAgent,expect.objectContaining({inputId:first.inputUuid}));
    expect(replay.inputUuid).toBe(first.inputUuid);
    expect(first.turnOrigin).toEqual({
      kind: "completion_notification",
      id: deliveryId,
    });
    expect(replay.turnOrigin).toEqual(first.turnOrigin);
  });

  it("derives a multi-intervention UUID from every delivery in queue order", () => {
    const d1 = { text: "first delivery", user: "u", deliveryId: "d1" };
    const d2 = { text: "second delivery", user: "u", deliveryId: "d2" };
    const batchUuid = buildDeliveryInputUuid("batch:d1,d2");

    expect(buildFollowupInputUuid([d1])).toBe(buildDeliveryInputUuid("d1"));
    expect(buildFollowupInputUuid([d1, d2])).toBe(batchUuid);
    expect(batchUuid).not.toBe(buildDeliveryInputUuid("d1"));
    expect(buildFollowupInputUuid([d1, d2])).toBe(batchUuid);
    expect(buildFollowupInputUuid([d2, d1])).not.toBe(batchUuid);
    expect(buildFollowupInputUuid([d1, { text: "legacy delivery", user: "u" }])).toBeUndefined();
  });

  it("keeps the second delivery body in the follow-up prompt under the batch UUID", async () => {
    const task = makeTask();
    const d1 = { text: "first delivery body", user: "u", deliveryId: "d1" };
    const d2 = { text: "second delivery body", user: "u", deliveryId: "d2" };
    const { builder, contextBuilder } = makeSubject();

    const input = await builder.prepareFollowupTurnInput(task, claudeAgent, [d1, d2]);

    expect(input.inputUuid).toBe(buildDeliveryInputUuid("batch:d1,d2"));
    expect(input.prompt).toContain(d2.text);
    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ inputId: input.inputUuid }),
    );
  });

  it("rollover replay는 원래 turn origin과 UUID를 그대로 보존한다", async () => {
    const task = makeTask();
    const { builder } = makeSubject();
    const failedInput = {
      prompt: "runtime follow-up",
      inputUuid: "input-1",
      turnOrigin: { kind: "runtime_followup" as const, id: "delivery-1" },
      intervention: {
        text: "runtime follow-up",
        user: "system",
        source: "claude_runtime_task_followup",
      },
    };

    const replay = await builder.prepareBackendRolloverTurnInput(
      task,
      claudeAgent,
      failedInput,
      "claude-exhausted",
    );

    expect(replay.inputUuid).toBe("input-1");
    expect(replay.turnOrigin).toEqual(failedInput.turnOrigin);
  });

  it("passes caller_info delta to follow-up context and records the injected caller", async () => {
    const nextCaller = {
      source: "agent",
      display_name: "서소영",
      agent_id: "seosoyoung",
    };
    const task = makeTask({
      lastInjectedCallerInfo: { source: "browser", display_name: "Alice" },
      interventionQueue: [{ text: "caller changed", user: "u", callerInfo: nextCaller }],
    });
    const { builder, contextBuilder } = makeSubject({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({ contextItems: [] }),
      },
    });

    await builder.prepareInitialTurnInput(task, codexAgent);

    expect(contextBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      codexAgent,
      expect.objectContaining({
        previousCallerInfo: { source: "browser", display_name: "Alice" },
        currentCallerInfo: nextCaller,
      }),
    );
    expect(task.lastInjectedCallerInfo).toEqual(nextCaller);
  });

  it("rollover replay는 현재 세션 tail과 유실 범위를 싣고 모든 입력 표면을 bounded로 유지한다", async () => {
    const task = makeTask({ codexThreadId: "claude-exhausted" });
    const { builder, contextBuilder } = makeSubject({
      contextBuilder: {
        buildBackendRolloverContext: vi.fn().mockResolvedValue({
          effectiveSystemPrompt: "한".repeat(CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS * 2),
          contextItems: [{
            key: "large_context",
            label: "Large context",
            content: "맥".repeat(CLAUDE_ROLLOVER_PROMPT_MAX_CHARS * 2),
          }],
          currentSessionExcerpt: {
            totalEvents: 4_339,
            turns: [{
              event_id: 4_306,
              event_type: "assistant_message",
              text: "최근 유효 응답",
              created_at: "2026-08-12T12:00:00.000Z",
            }],
          },
        }),
      },
    });

    const input = await builder.prepareBackendRolloverTurnInput(
      task,
      claudeAgent,
      {
        prompt: "질".repeat(CLAUDE_ROLLOVER_PROMPT_MAX_CHARS * 2),
        imageAttachmentPaths: [],
      },
      "claude-exhausted",
    );

    expect(contextBuilder.buildBackendRolloverContext).toHaveBeenCalledWith(task, claudeAgent);
    expect(input.prompt.length).toBeLessThanOrEqual(CLAUDE_ROLLOVER_PROMPT_MAX_CHARS);
    expect(input.systemPrompt?.length).toBeLessThanOrEqual(
      CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS,
    );
    expect(estimateClaudeTextTokens(input.prompt)).toBeLessThanOrEqual(
      CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS,
    );
    expect(estimateClaudeTextTokens(input.systemPrompt ?? "")).toBeLessThanOrEqual(
      CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS,
    );
    expect(input.prompt).toContain("<claude_backend_rollover>");
    expect(input.prompt).toContain("4,339");
    expect(input.prompt).toContain("최근 유효 응답");
    expect(input.prompt).toContain("older or omitted");
    expect(input.backendSessionRolloverFrom).toBe("claude-exhausted");
    expect(input.inputMaterialParts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "combined_visible",
        source_key: "fallback:bounded_replay:prompt",
        raw_chars_utf16: input.prompt.length,
      }),
      expect.objectContaining({
        category: "system_prompt",
        source_key: "fallback:system_source_breakdown",
        raw_chars_utf16: input.systemPrompt?.length,
      }),
    ]));
    expect(input.inputMaterialParts?.some((part) => part.category === "history_replay")).toBe(false);
  });

  it("rollover context 조회 실패는 replay 생존을 막지 않고 metadata-only notice로 강등한다", async () => {
    const { builder, logger } = makeSubject({
      contextBuilder: {
        buildBackendRolloverContext: vi.fn().mockRejectedValue(new Error("host unavailable")),
      },
    });

    const input = await builder.prepareBackendRolloverTurnInput(
      makeTask(),
      claudeAgent,
      { prompt: "recover this", imageAttachmentPaths: [] },
      "claude-exhausted",
    );

    expect(input.prompt).toContain("recover this");
    expect(input.prompt).toContain("No prior conversation excerpt was available");
    expect(input.prompt.length).toBeLessThanOrEqual(CLAUDE_ROLLOVER_PROMPT_MAX_CHARS);
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each(["claude", "opencode"] as const)("compact 후 %s 첫 후속 턴은 full context를 한 번만 재주입한다", async backend => {
    const task = makeTask({
      needsFullContextReinjection: true,
      interventionQueue: [{ text: "after compact", user: "u" }],
    });
    const { builder, contextBuilder } = makeSubject({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({
          effectiveSystemPrompt: "full system",
          contextItems: [
            { key: "soulstream_session", label: "Soulstream", content: "full" },
            { key: "running_sessions", label: "Running Sessions", content: [] },
          ],
        }),
      },
    });

    const agent = { ...claudeAgent, backend };
    const first = await builder.prepareInitialTurnInput(task, agent);

    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      agent,
      expect.objectContaining({ includeFullContext: true }),
    );
    expect(first.systemPrompt).toBe("full system");
    expect(first.prompt).toContain("<soulstream_session>");
    expect(first.inputMaterialParts?.reduce(
      (sum, part) => sum + (part.raw_chars_utf16 ?? 0),
      0,
    )).toBe(first.prompt.length + first.systemPrompt!.length);
    expect(task.needsFullContextReinjection).toBe(false);

    task.interventionQueue.push({ text: "regular", user: "u" });
    await builder.prepareFollowupTurnInput(
      task,
      agent,
      [task.interventionQueue.shift()!],
    );

    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      agent,
      expect.objectContaining({ includeFullContext: false }),
    );
  });
});

describe("rollover assigned-card slot",()=>{
  it("replays original initial user text verbatim even when it contains a similarly named tag",async()=>{
    const task=makeTask({prompt:'<assigned_cards>사용자 예문</assigned_cards>'});
    const {builder}=makeSubject({contextBuilder:{buildBackendRolloverContext:vi.fn().mockResolvedValue({contextItems:[{key:'assigned_cards',content:'fresh server slot'}]})}});
    const first=await builder.prepareInitialTurnInput(task,claudeAgent);
    const rollover=await builder.prepareBackendRolloverTurnInput(task,claudeAgent,first,'old');
    expect(rollover.prompt).toContain(task.prompt);expect(rollover.prompt).toContain('fresh server slot');
  });
  it.each([false,true])("preserves the fresh slot beyond large dynamic context and removes replayed snapshots, subreport=%s",async subreport=>{
    const task=makeTask();
    const stale={key:"assigned_cards",content:{trust:"untrusted_card_data",cards:[{title:"stale card"}]}};
    const fresh={key:"assigned_cards",content:{trust:"untrusted_card_data",cards:[{title:"fresh card",status:"review"}]}};
    const {builder}=makeSubject({contextBuilder:{buildBackendRolloverContext:vi.fn().mockResolvedValue({
      contextItems:[{key:"page_context",content:"대형 페이지".repeat(10000)},fresh],
    })}});
    const input=await builder.prepareBackendRolloverTurnInput(task,claudeAgent,{
      prompt:'<assigned_cards>\n{"trust":"untrusted_card_data","cards":[{"title":"stale card"}]}\n</assigned_cards>\noriginal',originalPrompt:"original",imageAttachmentPaths:[],
      ...(subreport?{interventions:[{text:"하위 보고",user:"agent",context:[stale]}]}:{}),
    },"previous");
    expect(input.prompt).toContain("fresh card");expect(input.prompt).not.toContain("stale card");
    expect(input.prompt.match(/<assigned_cards>/g)).toHaveLength(1);expect(input.prompt.length).toBeLessThanOrEqual(CLAUDE_ROLLOVER_PROMPT_MAX_CHARS);
  });
});

describe("Antigravity follow-up system contract", () => {
  it("ordinary resume keeps instructions in the native conversation and does not prepend them", async () => {
    const { builder } = makeSubject();
    const input = await builder.prepareInitialTurnInput(makeTask({ codexThreadId: "agy-id", modelPresetBackend: "antigravity", interventionQueue: [{ text: "다음 요청", user: "u" }] }), claudeAgent);
    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).not.toContain("system instructions");
    expect(input.prompt).toContain("다음 요청");
  });
  it("without a native ID ordinary follow-up still omits systemPrompt (reported host limitation)", async () => {
    const { builder } = makeSubject();
    const input = await builder.prepareInitialTurnInput(makeTask({ modelPresetBackend: "antigravity", interventionQueue: [{ text: "다시", user: "u" }] }), claudeAgent);
    expect(input.systemPrompt).toBeUndefined();
  });
});

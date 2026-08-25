import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { SessionDataHostError } from "../../src/control_plane/session_data_host_client.js";
import type { ExecutionContextBuilder, PreparedContext } from "../../src/context/context_builder.js";
import {
  CLAUDE_ROLLOVER_PROMPT_MAX_CHARS,
  CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS,
  CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS,
  CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS,
  type TaskInitialMessagePublisherPort,
  TaskTurnInputBuilder,
} from "../../src/task/task_turn_input_builder.js";
import { estimateClaudeTextTokens } from "../../src/task/claude_context_recovery.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskInitialMessagePublisher } from "../../src/task/task_initial_message_publisher.js";
import type { Task } from "../../src/task/task_models.js";

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
    ...overrides,
  };
}

function makeSubject(options: {
  contextBuilder?: Partial<{
    build: ReturnType<typeof vi.fn>;
    buildSystemPrompt: ReturnType<typeof vi.fn>;
    buildFollowupContext: ReturnType<typeof vi.fn>;
    buildBackendRolloverContext: ReturnType<typeof vi.fn>;
  }>;
  initialMessagePublisher?: { publishInitialMessages: ReturnType<typeof vi.fn> };
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
    ...options.contextBuilder,
  };
  const initialMessagePublisher = options.initialMessagePublisher ?? {
    publishInitialMessages: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn() } as unknown as Logger;
  const builder = new TaskTurnInputBuilder({
    contextBuilder: contextBuilder as unknown as ExecutionContextBuilder,
    initialMessagePublisher: initialMessagePublisher as unknown as TaskInitialMessagePublisherPort,
    logger,
  });

  return {
    builder,
    contextBuilder,
    initialMessagePublisher,
    logger,
  };
}

describe("TaskTurnInputBuilder", () => {
  it("prepares a new Claude turn by publishing initial messages and splitting systemPrompt from prompt text", async () => {
    const ctx = makeContext();
    const task = makeTask({
      attachmentPaths: ["/tmp/incoming/sess/screen.png", "/tmp/incoming/sess/readme.txt"],
    });
    const { builder, contextBuilder, initialMessagePublisher } = makeSubject({
      contextBuilder: { build: vi.fn().mockResolvedValue(ctx) },
    });

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(contextBuilder.build).toHaveBeenCalledWith(task, claudeAgent);
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, ctx);
    expect(input.systemPrompt).toBe("system instructions");
    expect(input.prompt).toContain("<session_context>");
    expect(input.prompt).toContain("session facts");
    expect(input.prompt).not.toContain("system instructions");
    expect(input.prompt.endsWith("사용자 요청")).toBe(true);
    expect(input.imageAttachmentPaths).toEqual(["/tmp/incoming/sess/screen.png"]);
  });

  it("prepares a new Codex turn by prepending systemPrompt into the prompt body", async () => {
    const { builder } = makeSubject();

    const input = await builder.prepareInitialTurnInput(makeTask(), codexAgent);

    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).toContain("system instructions");
    expect(input.prompt).toContain("<session_context>");
    expect(input.prompt.endsWith("사용자 요청")).toBe(true);
  });

  it("falls back to task.prompt when contextBuilder fails and still publishes initial user message", async () => {
    const task = makeTask({ attachmentPaths: ["/tmp/incoming/sess/a.jpg"] });
    const { builder, initialMessagePublisher, logger } = makeSubject({
      contextBuilder: { build: vi.fn().mockRejectedValue(new Error("context down")) },
    });

    const input = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(input).toEqual({
      prompt: "사용자 요청",
      imageAttachmentPaths: ["/tmp/incoming/sess/a.jpg"],
      turnOrigin: { kind: "initial_prompt" },
    });
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-turn-input" }),
      "context_builder failed — falling back to task.prompt without context",
    );
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
      contextBuilder: contextBuilder as unknown as ExecutionContextBuilder,
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

  it("binds a durable delivery to one stable engine input UUID", async () => {
    const deliveryId = "delivery-after-worker-restart";
    const task = makeTask();
    const { builder } = makeSubject();
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
    expect(replay.inputUuid).toBe(first.inputUuid);
    expect(first.turnOrigin).toEqual({
      kind: "completion_notification",
      id: deliveryId,
    });
    expect(replay.turnOrigin).toEqual(first.turnOrigin);
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

  it("compact 후 첫 후속 턴은 full context를 한 번만 재주입한다", async () => {
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

    const first = await builder.prepareInitialTurnInput(task, claudeAgent);

    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeFullContext: true }),
    );
    expect(first.systemPrompt).toBe("full system");
    expect(first.prompt).toContain("<soulstream_session>");
    expect(task.needsFullContextReinjection).toBe(false);

    task.interventionQueue.push({ text: "regular", user: "u" });
    await builder.prepareFollowupTurnInput(
      task,
      claudeAgent,
      [task.interventionQueue.shift()!],
    );

    expect(contextBuilder.buildFollowupContext).toHaveBeenLastCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeFullContext: false }),
    );
  });
});

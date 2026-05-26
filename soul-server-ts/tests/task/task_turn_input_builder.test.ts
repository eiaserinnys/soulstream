import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { ExecutionContextBuilder, PreparedContext } from "../../src/context/context_builder.js";
import {
  type TaskInitialMessagePublisherPort,
  TaskTurnInputBuilder,
} from "../../src/task/task_turn_input_builder.js";
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
  contextBuilder?: {
    build: ReturnType<typeof vi.fn>;
    buildSystemPrompt?: ReturnType<typeof vi.fn>;
  };
  initialMessagePublisher?: { publishInitialMessages: ReturnType<typeof vi.fn> };
} = {}) {
  const contextBuilder = options.contextBuilder ?? {
    build: vi.fn().mockResolvedValue(makeContext()),
    buildSystemPrompt: vi.fn().mockResolvedValue("resume system instructions"),
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
    });
    expect(initialMessagePublisher.publishInitialMessages).toHaveBeenCalledWith(task, undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-turn-input" }),
      "context_builder failed — falling back to task.prompt without context",
    );
  });

  it("prepares an auto-resume Claude turn by dequeuing one intervention and rebuilding only systemPrompt", async () => {
    const task = makeTask({
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
    expect(contextBuilder.buildSystemPrompt).toHaveBeenCalledWith(task, claudeAgent);
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
    expect(input.systemPrompt).toBe("resume system instructions");
    expect(input.imageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
    expect(input.prompt).toContain("<prior>");
    expect(input.prompt).toContain("remember this");
    expect(input.prompt).toContain("<attached_files>");
    expect(input.prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(input.prompt).not.toContain("/tmp/incoming/sess/a.png");
    expect(input.prompt.endsWith("첨부 확인")).toBe(true);
    expect(task.interventionQueue.map((item) => item.text)).toEqual(["later"]);
  });

  it("prepares an auto-resume Codex turn without systemPrompt option", async () => {
    const task = makeTask({
      interventionQueue: [{ text: "codex follow-up", user: "u" }],
    });
    const { builder, contextBuilder } = makeSubject();

    const input = await builder.prepareInitialTurnInput(task, codexAgent);

    expect(contextBuilder.build).not.toHaveBeenCalled();
    expect(contextBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(input.systemPrompt).toBeUndefined();
    expect(input.prompt).toBe("codex follow-up");
  });
});

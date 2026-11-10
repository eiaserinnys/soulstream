import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeSdkEventMapper } from "../../src/engine/claude_sdk_event_mapper.js";
import { ClaudeRuntimeState } from "../../src/engine/claude_sdk_runtime_state.js";

const AGENT_TOOL_USE_ID = "toolu-agent-1";
const AGENT_TASK_ID = "task-agent-1";

function asSdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function mapAssistantToolUse(
  mapper: ClaudeSdkEventMapper,
  toolUseId: string,
  options: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    parentToolUseId?: string | null;
  } = {},
): void {
  mapper.mapSdkMessage(asSdkMessage({
    type: "assistant",
    uuid: `assistant-${toolUseId}`,
    session_id: "sdk-session",
    parent_tool_use_id: options.parentToolUseId === undefined
      ? null
      : options.parentToolUseId,
    message: {
      content: [{
        type: "tool_use",
        id: toolUseId,
        name: options.toolName ?? "Agent",
        input: options.toolInput ?? {},
      }],
    },
  }));
}

function mapSystem(
  mapper: ClaudeSdkEventMapper,
  message: Record<string, unknown>,
): ClaudeClientEvent[] {
  return mapper.mapSdkMessage(asSdkMessage({
    type: "system",
    session_id: "sdk-session",
    ...message,
  }));
}

function mapToolResult(mapper: ClaudeSdkEventMapper, toolUseId: string): void {
  mapper.mapSdkMessage(asSdkMessage({
    type: "user",
    uuid: `user-${toolUseId}`,
    session_id: "sdk-session",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
    },
  }));
}

function progressEvents(events: ClaudeClientEvent[]): ClaudeClientEvent[] {
  return events.filter((event) => event.type === "progress");
}

function startForegroundAgent(mapper: ClaudeSdkEventMapper): void {
  mapAssistantToolUse(mapper, AGENT_TOOL_USE_ID);
  mapSystem(mapper, {
    subtype: "task_started",
    task_id: AGENT_TASK_ID,
    tool_use_id: AGENT_TOOL_USE_ID,
  });
}

function mapForegroundProgress(mapper: ClaudeSdkEventMapper): ClaudeClientEvent[] {
  return progressEvents(mapSystem(mapper, {
    subtype: "task_progress",
    task_id: AGENT_TASK_ID,
    summary: "Reviewing files",
  }));
}

describe("foreground Agent task progress", () => {
  it("marks task_progress without a message tool_use_id through the task_started link", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    startForegroundAgent(mapper);

    expect(mapForegroundProgress(mapper)).toEqual([
      {
        type: "progress",
        text: "Reviewing files",
        foregroundToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it("marks task_progress that carries its own tool_use_id", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapAssistantToolUse(mapper, AGENT_TOOL_USE_ID);

    expect(progressEvents(mapSystem(mapper, {
      subtype: "task_progress",
      task_id: AGENT_TASK_ID,
      tool_use_id: AGENT_TOOL_USE_ID,
      summary: "Reviewing files",
    }))).toEqual([
      {
        type: "progress",
        text: "Reviewing files",
        foregroundToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it("leaves task_progress without any tool link unmarked", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());

    expect(progressEvents(mapSystem(mapper, {
      subtype: "task_progress",
      task_id: "task-unknown",
      summary: "Working",
    }))).toEqual([{ type: "progress", text: "Working" }]);
  });

  it("leaves task_progress from a sidechain Agent tool use unmarked", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapAssistantToolUse(mapper, AGENT_TOOL_USE_ID, { parentToolUseId: "parent-toolu" });
    mapSystem(mapper, {
      subtype: "task_started",
      task_id: AGENT_TASK_ID,
      tool_use_id: AGENT_TOOL_USE_ID,
    });

    expect(mapForegroundProgress(mapper)).toEqual([
      { type: "progress", text: "Reviewing files" },
    ]);
  });

  it("leaves task_progress from a run_in_background Agent tool use unmarked", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapAssistantToolUse(mapper, AGENT_TOOL_USE_ID, {
      toolInput: { run_in_background: true },
    });
    mapSystem(mapper, {
      subtype: "task_started",
      task_id: AGENT_TASK_ID,
      tool_use_id: AGENT_TOOL_USE_ID,
    });

    expect(mapForegroundProgress(mapper)).toEqual([
      { type: "progress", text: "Reviewing files" },
    ]);
  });

  it("leaves task_progress unmarked after the SDK moves the task into background membership", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    startForegroundAgent(mapper);
    mapSystem(mapper, {
      subtype: "background_tasks_changed",
      tasks: [{ task_id: AGENT_TASK_ID, tool_use_id: AGENT_TOOL_USE_ID }],
    });

    expect(mapForegroundProgress(mapper)).toEqual([
      { type: "progress", text: "Reviewing files" },
    ]);
  });

  it("leaves late task_progress unmarked after the Agent tool result was emitted", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    startForegroundAgent(mapper);
    expect(mapForegroundProgress(mapper)).toEqual([
      {
        type: "progress",
        text: "Reviewing files",
        foregroundToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);

    mapToolResult(mapper, AGENT_TOOL_USE_ID);

    expect(mapForegroundProgress(mapper)).toEqual([
      { type: "progress", text: "Reviewing files" },
    ]);
  });

  it("leaves task_progress linked to a non-Agent tool unmarked", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    mapAssistantToolUse(mapper, AGENT_TOOL_USE_ID, { toolName: "Bash" });
    mapSystem(mapper, {
      subtype: "task_started",
      task_id: AGENT_TASK_ID,
      tool_use_id: AGENT_TOOL_USE_ID,
    });

    expect(mapForegroundProgress(mapper)).toEqual([
      { type: "progress", text: "Reviewing files" },
    ]);
  });

  it("never marks hook_progress or api_retry progress even while a foreground Agent runs", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    startForegroundAgent(mapper);

    expect(progressEvents(mapSystem(mapper, {
      subtype: "hook_progress",
      output: "hook output",
    }))).toEqual([{ type: "progress", text: "hook output" }]);
    expect(progressEvents(mapSystem(mapper, {
      subtype: "api_retry",
      attempt: 1,
      max_retries: 3,
    }))).toEqual([{ type: "progress", text: "API 요청 재시도 중 (1/3)" }]);
  });
});

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeSdkEventMapper } from
  "../../src/engine/claude_sdk_event_mapper.js";
import { claudeEngineEventMetadata } from "../../src/engine/claude_adapter.js";
import { ClaudeRuntimeState } from
  "../../src/engine/claude_sdk_runtime_state.js";
import { assertRunnerJsonValue } from "../../src/runner/frame_protocol.js";

describe("ClaudeSdkEventMapper runner JSON contract", () => {
  it("omits every absent rate-limit field from the live incident shape", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());

    const [event] = mapper.mapSdkMessage(asSdkMessage({
      type: "rate_limit_event",
      rate_limit_info: {},
    }));

    expect(event).toEqual({ type: "rate_limit" });
    expect(() => assertRunnerJsonValue(event, "rate-limit mapper output")).not.toThrow();
  });

  it.each(sdkMapperFixtures)("keeps every $name mapper output inside the runner JSON contract", ({ message }) => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    const events = mapper.mapSdkMessage(asSdkMessage(message));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const metadata = claudeEngineEventMetadata(event);
      expect(() => assertRunnerJsonValue(
        { event: { ...event }, ...(metadata ? { metadata } : {}) },
        `${message.type} mapper output`,
      )).not.toThrow();
    }
  });
});

const sdkMapperFixtures: Array<{ name: string; message: Record<string, unknown> }> = [
  { name: "system init", message: { type: "system", subtype: "init", session_id: "session-1" } },
  {
    name: "system session state",
    message: { type: "system", subtype: "session_state_changed", state: "running" },
  },
  {
    name: "system background membership",
    message: {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-bg" }],
    },
  },
  {
    name: "system away summary",
    message: { type: "system", subtype: "away_summary", data: { content: "away" } },
  },
  {
    name: "system compact boundary",
    message: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } },
  },
  {
    name: "system task started",
    message: { type: "system", subtype: "task_started", task_id: "task-1" },
  },
  {
    name: "system task notification",
    message: { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" },
  },
  {
    name: "system task updated",
    message: { type: "system", subtype: "task_updated", task_id: "task-1", patch: {} },
  },
  {
    name: "system notification",
    message: { type: "system", subtype: "notification", text: "notice" },
  },
  {
    name: "system mirror error",
    message: {
      type: "system",
      subtype: "mirror_error",
      key: { projectKey: "project", sessionId: "transcript" },
      error: "mirror failed",
    },
  },
  {
    name: "system permission denied",
    message: { type: "system", subtype: "permission_denied", tool_name: "Write" },
  },
  {
    name: "system task progress",
    message: { type: "system", subtype: "task_progress", task_id: "task-1", summary: "working" },
  },
  {
    name: "system hook progress",
    message: { type: "system", subtype: "hook_progress", output: "hook" },
  },
  {
    name: "assistant content",
    message: {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "checking" },
          { type: "tool_use", name: "Read", input: {} },
        ],
      },
    },
  },
  {
    name: "assistant error",
    message: { type: "assistant", error: "rate_limit", message: { content: [] } },
  },
  {
    name: "user tool result",
    message: {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-unknown", content: "done" }],
      },
    },
  },
  {
    name: "user remote origin",
    message: {
      type: "user",
      uuid: "remote-1",
      origin: { kind: "agent" },
      message: { content: "continue" },
    },
  },
  {
    name: "result success",
    message: { type: "result", subtype: "success", result: "done" },
  },
  {
    name: "result failure",
    message: { type: "result", subtype: "error_during_execution", is_error: true, errors: ["failed"] },
  },
  {
    name: "prompt suggestion",
    message: { type: "prompt_suggestion", suggestion: "next" },
  },
  {
    name: "rate limit incident",
    message: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
  },
];

function asSdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

import { describe, expect, it } from "vitest";

import { applyClaudeRuntimeStoreEvent } from "./claude-runtime-state";
import type { SoulSSEEvent } from "@shared/types";

describe("applyClaudeRuntimeStoreEvent", () => {
  it("accumulates P0-A Claude runtime wire into background task state", () => {
    let state = applyClaudeRuntimeStoreEvent(null, {
      type: "claude_runtime_session_state",
      state: "running",
      session_id: "claude-sess-1",
      timestamp: 10,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_task_started",
      task_id: "bg-1",
      tool_use_id: "toolu-bash",
      description: "Background Bash task",
      task_type: "bash",
      timestamp: 11,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_task_updated",
      task_id: "bg-1",
      patch: {
        status: "running",
        is_backgrounded: true,
        output_file: "/tmp/bg-1.out",
        summary: "sleeping",
      },
      timestamp: 12,
    } as unknown as SoulSSEEvent);

    expect(state).toMatchObject({
      sessionState: "running",
      runtimeSessionId: "claude-sess-1",
      tasks: {
        "bg-1": {
          taskId: "bg-1",
          status: "running",
          toolUseId: "toolu-bash",
          taskType: "bash",
          outputFile: "/tmp/bg-1.out",
          summary: "sleeping",
          isBackgrounded: true,
        },
      },
    });
  });
});

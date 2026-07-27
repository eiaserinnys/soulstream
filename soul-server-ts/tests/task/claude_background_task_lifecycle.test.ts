import { describe, expect, it, vi } from "vitest";

import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";

describe("ClaudeBackgroundTaskLifecycle provenance boundary", () => {
  it("does not persist synchronous foreground Bash/Agent terminal events", async () => {
    const observe = vi.fn();
    const terminalize = vi.fn();
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observe,
        terminalize,
      } as never,
      sourceNode: "node-test",
    });

    for (const taskId of ["foreground-bash", "foreground-agent"]) {
      await expect(lifecycle.observe("caller-session", {
        type: "claude_runtime_task_notification",
        taskId,
        status: "completed",
        summary: "already returned in the foreground tool result",
      })).resolves.toBe(true);
    }

    expect(observe).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it("persists a terminal event after SDK background membership is proven", async () => {
    const terminalize = vi.fn(async () => ({
      accepted: true,
      delivery: {
        delivery_id: "delivery-background-agent",
        completion_id: "completion:background-agent",
        relation_key: "claude_runtime:caller-session:background-agent",
        producer_terminal_revision: "1785081600000",
        created_at: new Date("2026-07-27T00:00:00.000Z"),
        source: "claude_runtime_task_followup",
        payload: { text: "done", user: "system" },
        payload_hash: "hash-background-agent",
      },
    }));
    const lifecycle = new ClaudeBackgroundTaskLifecycle({
      repository: {
        observe: vi.fn(),
        terminalize,
      } as never,
      sourceNode: "node-test",
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    });
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_notification",
      taskId: "background-agent",
      status: "completed",
      summary: "detached work done",
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");

    await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);

    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "caller-session",
      taskId: "background-agent",
      status: "completed",
    }));
  });
});

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

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_task_created",
      task_id: "sdk-task-1",
      subject: "Investigate queue",
      description: "Check pending queue",
      teammate_name: "analyst",
      team_name: "runtime",
      timestamp: 13,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_task_completed",
      task_id: "sdk-task-1",
      subject: "Investigate queue",
      description: "Check pending queue",
      teammate_name: "analyst",
      team_name: "runtime",
      timestamp: 14,
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
        "sdk-task-1": {
          taskId: "sdk-task-1",
          status: "completed",
          subject: "Investigate queue",
          description: "Check pending queue",
          teammateName: "analyst",
          teamName: "runtime",
        },
      },
    });
  });

  it("tracks plan and worktree mode state without creating task rows", () => {
    let state = applyClaudeRuntimeStoreEvent(null, {
      type: "claude_runtime_mode_state",
      mode: "plan",
      active: true,
      source: "tool_use",
      tool_use_id: "toolu-plan",
      tool_name: "EnterPlanMode",
      timestamp: 20,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_mode_state",
      mode: "worktree",
      active: true,
      source: "hook",
      worktree_name: "feature-x",
      timestamp: 21,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_hook_event",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      timestamp: 22,
    } as unknown as SoulSSEEvent);

    expect(state).toMatchObject({
      planMode: {
        active: true,
        source: "tool_use",
        toolUseId: "toolu-plan",
        toolName: "EnterPlanMode",
      },
      worktreeMode: {
        active: true,
        source: "hook",
        worktreeName: "feature-x",
      },
      tasks: {},
    });
  });

  it("tracks durable schedule update/delete wire and derives the next active run", () => {
    let state = applyClaudeRuntimeStoreEvent(null, {
      type: "claude_runtime_schedule_updated",
      schedule_id: "sched-late",
      session_id: "sess-1",
      schedule_kind: "cron",
      status: "active",
      prompt: "later",
      recurring: true,
      next_run_at: "2026-01-01T01:00:00.000Z",
      timestamp: 10,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_schedule_updated",
      schedule_id: "sched-soon",
      session_id: "sess-1",
      schedule_kind: "wakeup",
      status: "active",
      prompt: "soon",
      recurring: false,
      next_run_at: "2026-01-01T00:30:00.000Z",
      timestamp: 11,
    } as unknown as SoulSSEEvent);

    expect(state).toMatchObject({
      nextScheduleRunAt: "2026-01-01T00:30:00.000Z",
      schedules: {
        "sched-late": { scheduleId: "sched-late", kind: "cron" },
        "sched-soon": { scheduleId: "sched-soon", kind: "wakeup" },
      },
    });

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_schedule_deleted",
      schedule_id: "sched-soon",
      session_id: "sess-1",
      status: "cancelled",
      timestamp: 12,
    } as unknown as SoulSSEEvent);

    expect(state?.nextScheduleRunAt).toBe("2026-01-01T01:00:00.000Z");
    expect(state?.schedules["sched-soon"]).toBeUndefined();
  });

  it("tracks runtime notifications, remote triggers, and transcript mirror errors", () => {
    let state = applyClaudeRuntimeStoreEvent(null, {
      type: "claude_runtime_notification",
      notification_id: "notif-1",
      source: "tool_use",
      title: "Approval",
      message: "Confirm the handoff",
      notification_type: "permission",
      session_id: "claude-sess-1",
      timestamp: 20,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_remote_trigger",
      trigger_id: "remote-1",
      source: "message_origin",
      origin_kind: "peer",
      origin_name: "orchestrator",
      prompt: "Continue the session",
      session_id: "claude-sess-1",
      timestamp: 21,
    } as unknown as SoulSSEEvent);

    state = applyClaudeRuntimeStoreEvent(state, {
      type: "claude_runtime_transcript_mirror_error",
      mirror_id: "mirror-1",
      session_id: "claude-sess-1",
      project_key: "soulstream",
      transcript_session_id: "claude-sess-1",
      error: "write failed",
      timestamp: 22,
    } as unknown as SoulSSEEvent);

    expect(state).toMatchObject({
      runtimeSessionId: "claude-sess-1",
      notifications: {
        "notif-1": {
          notificationId: "notif-1",
          source: "tool_use",
          title: "Approval",
          message: "Confirm the handoff",
          notificationType: "permission",
        },
      },
      remoteTriggers: {
        "remote-1": {
          triggerId: "remote-1",
          source: "message_origin",
          originKind: "peer",
          originName: "orchestrator",
          prompt: "Continue the session",
        },
      },
      transcriptMirror: {
        mirrorId: "mirror-1",
        errorCount: 1,
        lastError: "write failed",
      },
    });
  });
});

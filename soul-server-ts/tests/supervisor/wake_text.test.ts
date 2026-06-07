import { describe, expect, it } from "vitest";

import {
  buildSupervisorWakeText,
  wakeSessionSummaryFromRow,
} from "../../src/supervisor/wake_text.js";
import type { SupervisorWakeEvent } from "../../src/supervisor/wake_router.js";

describe("Supervisor wake text", () => {
  it("groups wake events by session and surfaces meaningful message context", () => {
    const events: SupervisorWakeEvent[] = [
      {
        offset: 11,
        sourceSessionId: "sess-a",
        eventType: "text_delta",
        payload: { type: "text_delta", text: "streaming noise" },
      },
      {
        offset: 12,
        sourceSessionId: "sess-a",
        eventType: "user_message",
        payload: { type: "user_message", text: "Please inspect the failed job." },
      },
      {
        offset: 13,
        sourceSessionId: "sess-a",
        eventType: "assistant_message",
        payload: { type: "assistant_message", content: "I found the failing step." },
      },
      {
        offset: 14,
        sourceSessionId: "sess-a",
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          tool_name: "Bash",
          result: "exit 1: missing file",
          is_error: true,
        },
      },
    ];

    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events,
      sessions: {
        "sess-a": {
          sessionId: "sess-a",
          title: "Deploy check",
          agentId: "worker-codex",
          callerDisplayName: "Alice",
          callerSource: "slack",
          status: "running",
          lastMessagePreview: "Previous preview",
        },
      },
      maxTextChars: 80,
    });

    expect(text).toContain("[supervisor wake] role=ariela_codex class=wake");
    expect(text).toContain("trigger_sessions=sess-a");
    expect(text).toContain("## session sess-a");
    expect(text).toContain("title=Deploy check");
    expect(text).toContain("agent=worker-codex");
    expect(text).toContain("caller=Alice (slack)");
    expect(text).toContain("status=running");
    expect(text).toContain("last_user=Please inspect the failed job.");
    expect(text).toContain("last_assistant=I found the failing step.");
    expect(text).toContain("tool_error=Bash: exit 1: missing file");
    expect(text).toContain("noise=text_delta:1");
    expect(text).not.toContain("streaming noise");
  });

  it("includes session_ended summary and caps session count", () => {
    const events: SupervisorWakeEvent[] = [
      {
        offset: 21,
        sourceSessionId: "sess-a",
        eventType: "session_ended",
        payload: {
          type: "session_ended",
          status: "completed",
          termination_reason: "completed_ok",
        },
      },
      {
        offset: 22,
        sourceSessionId: "sess-b",
        eventType: "assistant_message",
        payload: { type: "assistant_message", content: "B content" },
      },
      {
        offset: 23,
        sourceSessionId: "sess-c",
        eventType: "assistant_message",
        payload: { type: "assistant_message", content: "C content" },
      },
    ];

    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events,
      sessions: {
        "sess-a": {
          sessionId: "sess-a",
          title: "Finished task",
          status: "completed",
          awaySummary: "The task ended after checking the queue.",
          terminationReason: "completed_ok",
        },
        "sess-b": { sessionId: "sess-b", title: "B" },
        "sess-c": { sessionId: "sess-c", title: "C" },
      },
      maxSessions: 2,
      maxTextChars: 120,
    });

    expect(text).toContain("## session sess-a");
    expect(text).toContain("session_summary=The task ended after checking the queue.");
    expect(text).toContain("termination=completed_ok");
    expect(text).toContain("## session sess-b");
    expect(text).not.toContain("## session sess-c");
    expect(text).toContain("omitted_sessions=1");
  });

  it("truncates long message bodies", () => {
    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "batch",
      events: [
        {
          offset: 31,
          sourceSessionId: "sess-a",
          eventType: "assistant_message",
          payload: {
            type: "assistant_message",
            content: "abcdefghijklmnopqrstuvwxyz",
          },
        },
      ],
      maxTextChars: 10,
    });

    expect(text).toContain("last_assistant=abcdefg...");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("derives session display metadata from SessionRow", () => {
    const summary = wakeSessionSummaryFromRow("sess-a", {
      display_name: "Session title",
      status: "running",
      agent_id: "agent-a",
      last_message: { preview: "last preview" },
      away_summary: "away summary",
      termination_reason: null,
      termination_detail: null,
      metadata: [
        {
          type: "caller_info",
          value: { source: "browser", display_name: "Browser User" },
        },
      ],
    });

    expect(summary).toEqual({
      sessionId: "sess-a",
      title: "Session title",
      status: "running",
      agentId: "agent-a",
      callerDisplayName: "Browser User",
      callerSource: "browser",
      lastMessagePreview: "last preview",
      awaySummary: "away summary",
      terminationReason: null,
      terminationDetail: null,
    });
  });
});

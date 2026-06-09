import { describe, expect, it } from "vitest";

import {
  buildSupervisorSnapshotWakeText,
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

    expect(text).toContain("[supervisor wake] wake · 세션 1개");
    expect(text).toContain("▸ Deploy check");
    expect(text).toContain("sess-a · worker-codex · 호출: Alice (slack)");
    expect(text).toContain("상태: running");
    expect(text).toContain("사용자: Please inspect the failed job.");
    expect(text).toContain("최근: I found the failing step.");
    expect(text).toContain("⚠ 오류: Bash: exit 1: missing file");
    expect(text).toContain("활동: 이벤트 4개");
    expect(text).toContain("오류 1건");
    expect(text).not.toContain("#14");
    expect(text).not.toContain("tool_result");
    expect(text).not.toContain("streaming noise");
  });

  it("drops tool and streaming noise while keeping only errored tool results", () => {
    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "batch",
      events: [
        {
          offset: 37906,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "tool_start",
          payload: { type: "tool_start", tool_name: "Bash" },
        },
        {
          offset: 37907,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "tool_result",
          payload: { type: "tool_result", tool_name: "Bash", result: "ok", is_error: false },
        },
        {
          offset: 37908,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "progress",
          payload: { type: "progress", message: "87%" },
        },
        {
          offset: 37909,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "tool_result",
          payload: {
            type: "tool_result",
            tool_name: "Bash",
            result: "exit 1: failing test",
            is_error: true,
          },
        },
        {
          offset: 37919,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "assistant_message",
          payload: {
            type: "assistant_message",
            content: "깨진 테스트 기대값을 갱신했습니다.",
          },
        },
      ],
      sessions: {
        "c06cd339-1111-4222-9333-aaaaaaaaaaaa": {
          sessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          title: "Supervisor 페이즈A 잔여",
          agentId: "roselin_codex",
          callerDisplayName: "서소영",
          callerSource: "agent",
          status: "completed",
        },
      },
      maxTextChars: 120,
    });

    expect(text).toContain("[supervisor wake] batch · 세션 1개");
    expect(text).toContain("c06cd339 · roselin_codex · 호출: 서소영 (agent)");
    expect(text).toContain("상태: completed");
    expect(text).toContain("최근: 깨진 테스트 기대값을 갱신했습니다.");
    expect(text).toContain("⚠ 오류: Bash: exit 1: failing test");
    expect(text).toContain("진행·도구 위주");
    expect(text).not.toContain("#37906");
    expect(text).not.toContain("tool_start");
    expect(text).not.toContain("ok");
    expect(text).not.toContain("87%");
  });

  it("renders current time, completion time, and relative time when timestamps are present", () => {
    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "batch",
      now: new Date("2026-06-08T23:15:30.000Z"),
      events: [
        {
          offset: 1,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "session_ended",
          payload: { type: "session_ended", status: "completed" },
          createdAt: new Date("2026-06-08T23:03:45.000Z"),
        },
        {
          offset: 2,
          sourceSessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          eventType: "assistant_message",
          payload: { type: "assistant_message", content: "완료 보고입니다." },
          createdAt: new Date("2026-06-08T23:03:40.000Z"),
        },
      ],
      sessions: {
        "c06cd339-1111-4222-9333-aaaaaaaaaaaa": {
          sessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          title: "Finished task",
          status: "completed",
        },
      },
    });

    expect(text).toContain("현재 2026-06-09 08:15:30 (KST)");
    expect(text).toContain("상태: completed · 완료 08:03:45 (12분 전)");
  });

  it("omits time fields instead of fabricating timestamps when timestamps are absent", () => {
    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "batch",
      events: [
        {
          offset: 1,
          sourceSessionId: "sess-a",
          eventType: "assistant_message",
          payload: { type: "assistant_message", content: "No timestamp here." },
        },
      ],
      sessions: {
        "sess-a": {
          sessionId: "sess-a",
          title: "No timestamp task",
          status: "running",
        },
      },
    });

    expect(text).not.toContain("현재");
    expect(text).not.toContain("최근활동");
    expect(text).not.toContain("완료 ");
    expect(text).toContain("상태: running");
  });

  it("renders cold-start snapshot from session summaries without event replay", () => {
    const text = buildSupervisorSnapshotWakeText({
      supervisorId: "ariela_codex",
      now: new Date("2026-06-08T23:15:30.000Z"),
      sessions: [
        {
          sessionId: "c06cd339-1111-4222-9333-aaaaaaaaaaaa",
          title: "Supervisor 페이즈A 잔여",
          agentId: "roselin_codex",
          callerDisplayName: "서소영",
          callerSource: "agent",
          status: "completed",
          updatedAt: new Date("2026-06-08T23:03:45.000Z"),
          eventCount: 100,
          lastMessagePreview: "깨진 테스트 기대값을 갱신했습니다.",
        },
      ],
    });

    expect(text).toContain("[supervisor wake] snapshot · 세션 1개");
    expect(text).toContain("현재 2026-06-09 08:15:30 (KST)");
    expect(text).toContain("상태: completed · 완료 08:03:45 (12분 전)");
    expect(text).toContain("최근: 깨진 테스트 기대값을 갱신했습니다.");
    expect(text).toContain("활동: 이벤트 100개 · 오류 없음");
    expect(text).not.toContain("#");
    expect(text).not.toContain("tool_start");
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

    expect(text).toContain("▸ Finished task");
    expect(text).toContain("최근: The task ended after checking the queue.");
    expect(text).toContain("상태: completed");
    expect(text).toContain("▸ B");
    expect(text).not.toContain("▸ C");
    expect(text).toContain("외 1개 세션 생략");
  });

  it("prioritizes trigger sessions over earlier noise-only sessions when applying the session cap", () => {
    const events: SupervisorWakeEvent[] = [
      ...Array.from({ length: 5 }, (_, index) => ({
        offset: index + 1,
        sourceSessionId: `noise-${index + 1}`,
        eventType: "text_delta",
        payload: { type: "text_delta", text: `noise ${index + 1}` },
      })),
      {
        offset: 6,
        sourceSessionId: "trigger-session",
        eventType: "credential_alert",
        payload: { type: "credential_alert", message: "OAuth token expired" },
      },
    ];

    const text = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "critical",
      events,
      sessions: {
        "trigger-session": {
          sessionId: "trigger-session",
          title: "Needs intervention",
          status: "running",
        },
      },
      maxSessions: 5,
      maxTextChars: 120,
    });

    expect(text).toContain("[supervisor wake] critical · 세션 6개");
    expect(text).toContain("▸ Needs intervention");
    expect(text).toContain("외 1개 세션 생략");
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

    expect(text).toContain("최근: abcdefg...");
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
      updatedAt: null,
      lastMessagePreview: "last preview",
      awaySummary: "away summary",
      terminationReason: null,
      terminationDetail: null,
    });
  });
});

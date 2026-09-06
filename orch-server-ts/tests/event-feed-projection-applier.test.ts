import { describe, expect, it, vi } from "vitest";

import {
  applyEventFeedProjection,
  attentionMutation,
  sessionNotice,
} from "../src/node/event_feed_projection_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope } from "../src/node/event_ingress_types.js";

describe("event feed projection", () => {
  it("keeps simultaneous input and approval requests under independent identities", () => {
    const first = attentionMutation(envelope("input_request", {
      request_id: "request-1",
      questions: [{
        question: "First?",
        header: "First",
        options: [{ label: "Yes", description: "Proceed" }],
      }],
      timeout_sec: 30,
    }), 10);
    const second = attentionMutation(envelope("input_request", {
      request_id: "request-2",
      questions: [{ question: "Second?", options: [] }],
    }), 11);
    const approval = attentionMutation(envelope("tool_approval_requested", {
      approval_id: "approval-1",
      tool_use_id: "tool-1",
      tool_name: "shell",
      tool_input: { command: "git status", cwd: "/workspace" },
    }), 12);

    expect([first, second, approval]).toMatchObject([
      { kind: "upsert", attention: { id: "input_request:request-1" } },
      { kind: "upsert", attention: { id: "input_request:request-2" } },
      { kind: "upsert", attention: { id: "tool_approval:approval-1" } },
    ]);
    expect(new Set([first, second, approval].map((item) =>
      item.kind === "upsert" ? item.attention.id : "",
    )).size).toBe(3);
  });

  it("emits an identity tombstone for the matching resolved request", () => {
    expect(attentionMutation(envelope("input_request_responded", {
      request_id: "request-2",
    }), 13)).toEqual({
      kind: "remove",
      attentionId: "input_request:request-2",
    });
    expect(attentionMutation(envelope("tool_approval_resolved", {
      approval_id: "approval-1",
    }), 14)).toEqual({
      kind: "remove",
      attentionId: "tool_approval:approval-1",
    });
  });

  it("omits an oversized tool input and requires the detail stream", () => {
    const mutation = attentionMutation(envelope("tool_approval_requested", {
      approval_id: "approval-big",
      tool_name: "shell",
      tool_input: { command: "x".repeat(17 * 1024) },
    }), 20);

    expect(mutation).toMatchObject({
      kind: "upsert",
      attention: {
        id: "tool_approval:approval-big",
        requiresDetail: true,
      },
    });
    if (mutation.kind !== "upsert") throw new Error("expected upsert");
    expect(mutation.attention).not.toHaveProperty("toolInput");
    expect(Buffer.byteLength(JSON.stringify(mutation.attention), "utf8")).toBeLessThan(16 * 1024);
  });

  it("creates a stable notice identity from the committed session event id", () => {
    expect(sessionNotice(envelope("error", { message: "boom" }), 31)).toEqual({
      id: "session-a:31",
      sourceEventId: 31,
      sessionId: "session-a",
      kind: "error",
      title: "세션 오류",
      body: "boom",
      createdAt: "2026-09-06T12:00:00.000Z",
    });
  });

  it("preserves session notification text in the global notice projection", () => {
    expect(sessionNotice(envelope("session_notification", {
      delivery_id: "delivery-42",
      delivery_intent: "completion_notification",
      source: "background-agent",
      disposition: "auto_resume",
      text: "Background work finished",
    }), 42)).toEqual({
      id: "session-a:42",
      sourceEventId: 42,
      sessionId: "session-a",
      kind: "response_wait",
      title: "Soul Dashboard",
      body: "Background work finished",
      createdAt: "2026-09-06T12:00:00.000Z",
    });
  });

  it("returns a revisioned tombstone and prunes the durable notice journal", async () => {
    const statements: string[] = [];
    const sql = Object.assign(async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("INSERT INTO session_feed_notices")) {
        return [{ source_event_id: 40 }];
      }
      return [];
    }, { json: (value: unknown) => value }) as unknown as EventIngressQuerySql;

    const result = await applyEventFeedProjection(sql, {
      nodeId: "node-a",
      eventId: 40,
      envelope: envelope("input_request", {
        request_id: "request-40",
        questions: [{ question: "Continue?", options: [] }],
      }),
    });

    expect(result).toMatchObject({
      attention_revision: 40,
      pending_attentions_delta: {
        "input_request:request-40": {
          revision: 40,
          value: { sourceEventId: 40 },
        },
      },
      notices: [{ id: "session-a:40" }],
      notification_watermark: 40,
    });
    expect(statements.some((statement) =>
      statement.includes("DELETE FROM session_feed_notices") && statement.includes("LIMIT"),
    )).toBe(true);
  });

  it("does not clear attention or notify for a rejected terminal transition", async () => {
    const sql = Object.assign(vi.fn(async () => []), {
      json: (value: unknown) => value,
    }) as unknown as EventIngressQuerySql;

    await expect(applyEventFeedProjection(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope("session_ended", { status: "completed" }),
      sessionEffectApplication: {
        applied: false,
        canonicalSession: null,
      },
    })).resolves.toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });
});

function envelope(
  eventType: string,
  payload: Record<string, unknown>,
): EventIngressEnvelope {
  return {
    stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
    source_seq: 1,
    session_id: "session-a",
    event_type: eventType,
    payload: { type: eventType, ...payload },
    searchable_text: null,
    created_at: "2026-09-06T12:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
    payload_hash: "a".repeat(64),
  };
}

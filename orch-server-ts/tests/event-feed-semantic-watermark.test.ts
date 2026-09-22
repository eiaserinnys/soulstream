import { describe, expect, it } from "vitest";

import type { EventFeedProjectionApplication } from
  "../src/node/event_feed_projection_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type {
  EventSessionEffect,
  EventSessionEffectApplication,
} from "../src/node/event_ingress_types.js";
import {
  advanceSessionFeedLastEventId,
  hasFeedSemanticIngressChange,
} from "../src/node/event_feed_semantic_watermark.js";

const CREATED_AT = "2026-09-22T00:00:00.000Z";

function application(
  overrides: Partial<EventSessionEffectApplication>,
): EventSessionEffectApplication {
  return {
    applied: false,
    canonicalSession: null,
    ...overrides,
  };
}

describe("event feed semantic watermark", () => {
  it.each<{
    name: string;
    effect: EventSessionEffect | null;
    sessionEffectApplication?: EventSessionEffectApplication;
    feedProjectionApplication?: EventFeedProjectionApplication | null;
    expected: boolean;
  }>([
    {
      name: "persists an applied last-message projection",
      effect: {
        kind: "last_message",
        last_message: {
          type: "assistant_message",
          preview: "visible answer",
          timestamp: CREATED_AT,
        },
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: true,
        canonicalLastMessage: {
          type: "assistant_message",
          preview: "visible answer",
          timestamp: CREATED_AT,
        },
      }),
      expected: true,
    },
    {
      name: "persists an applied canonical lifecycle projection",
      effect: {
        kind: "running_transition",
        review_state: "not_required",
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: true,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: CREATED_AT,
          last_event_id: 21,
        },
      }),
      expected: true,
    },
    {
      name: "persists an applied execution registration projection",
      effect: {
        kind: "execution_registration",
        registration_id: "registration-a",
        execution_command_id: "command-a",
        review_state: "not_required",
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: true,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: CREATED_AT,
          last_event_id: 22,
        },
      }),
      expected: true,
    },
    {
      name: "persists an applied execution acquire projection",
      effect: {
        kind: "execution_acquire",
        owner_kind: "runner_process",
        manifest_id: "manifest-a",
        runtime_env_identity: "env-a",
        registration_id: "registration-a",
        pid: 123,
        start_identity: "start-a",
        execution_command_id: "command-a",
        lease_expires_at: "2026-09-22T00:01:00.000Z",
        review_state: "not_required",
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: true,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: CREATED_AT,
          last_event_id: 23,
        },
      }),
      expected: true,
    },
    {
      name: "persists an applied terminal projection",
      effect: {
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed",
        termination_detail: null,
        review_state: "not_required",
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: true,
        canonicalSession: {
          status: "completed",
          termination_reason: "completed",
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: "done",
          termination_event_id: 23,
          updated_at: CREATED_AT,
          last_event_id: 23,
        },
      }),
      expected: true,
    },
    {
      name: "persists an actual attention or notice projection",
      effect: null,
      feedProjectionApplication: {
        updated_at: CREATED_AT,
        attention_revision: 21,
        pending_attentions_delta: {},
      },
      expected: true,
    },
    {
      name: "does not advance for a rejected lifecycle transition",
      effect: {
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed",
        termination_detail: null,
        review_state: "not_required",
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({
        applied: false,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: CREATED_AT,
          last_event_id: 20,
        },
      }),
      expected: false,
    },
    {
      name: "does not advance for backend identity or metadata only effects",
      effect: { kind: "set_backend_session_id", backend_session_id: "sdk-1" },
      sessionEffectApplication: application({ applied: true }),
      expected: false,
    },
    {
      name: "does not advance for backend rotation",
      effect: {
        kind: "rotate_backend_session_id",
        expected_backend_session_id: "sdk-1",
        backend_session_id: "sdk-2",
      },
      sessionEffectApplication: application({ applied: true }),
      expected: false,
    },
    {
      name: "does not advance for metadata-only updates",
      effect: {
        kind: "append_metadata",
        entry: { type: "note", value: "internal" },
        updated_at: CREATED_AT,
      },
      sessionEffectApplication: application({ applied: true }),
      expected: false,
    },
    {
      name: "does not advance for a no-op cleanup projection",
      effect: null,
      feedProjectionApplication: null,
      expected: false,
    },
  ])("$name", ({ effect, sessionEffectApplication, feedProjectionApplication, expected }) => {
    expect(hasFeedSemanticIngressChange({
      effect,
      sessionEffectApplication,
      feedProjectionApplication,
    })).toBe(expected);
  });

  it("writes the positive event id monotonically without inventing a legacy value", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return [{ feed_last_event_id: 42 }];
    }) as EventIngressQuerySql;

    await expect(advanceSessionFeedLastEventId(sql, {
      sessionId: "session-a",
      eventId: 42,
      createdAt: CREATED_AT,
    })).resolves.toBe(42);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("feed_last_event_id");
    expect(calls[0]?.text).toContain("session_feed_state.feed_last_event_id IS NULL");
    expect(calls[0]?.values).toEqual([
      "session-a",
      42,
      new Date(CREATED_AT),
    ]);
  });
});

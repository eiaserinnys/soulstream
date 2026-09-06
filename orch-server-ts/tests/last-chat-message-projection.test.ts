import { describe, expect, it } from "vitest";

import { lastChatMessageFromEnvelope } from
  "../src/node/last_chat_message_projection.js";
import type { EventIngressEnvelope } from
  "../src/node/event_ingress_types.js";

describe("lastChatMessageFromEnvelope", () => {
  it.each([
    ["missing", undefined],
    ["false", false],
  ] as const)(
    "rejects a realtime transcript when final is %s",
    (_label, final) => {
      expect(lastChatMessageFromEnvelope(
        realtimeTranscriptEnvelope(final),
        42,
      )).toBeNull();
    },
  );

  it("projects a realtime transcript only when final is exactly true", () => {
    expect(lastChatMessageFromEnvelope(realtimeTranscriptEnvelope(true), 42)).toEqual({
      type: "user_message",
      eventId: 42,
      preview: "confirmed speech",
      timestamp: "2026-08-06T00:00:00.000Z",
    });
  });
});

function realtimeTranscriptEnvelope(final: boolean | undefined): EventIngressEnvelope {
  return {
    stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
    source_seq: 1,
    session_id: "session-a",
    event_type: "realtime_transcript",
    payload: {
      type: "realtime_transcript",
      role: "user",
      text: "confirmed speech",
      ...(final === undefined ? {} : { final }),
    },
    searchable_text: "confirmed speech",
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
    payload_hash: "a".repeat(64),
  };
}

import { describe, expect, it } from "vitest";

import { parseEventAppendBatch } from "../src/node/event_ingress_types.js";
import { sanitizePgJsonValue, sanitizePgText } from "../src/node/pg_text_sanitizer.js";

const STREAM_ID = "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10";
const PAYLOAD_HASH = "a".repeat(64);

describe("sanitizePgText", () => {
  it("strips NUL characters PostgreSQL cannot store", () => {
    expect(sanitizePgText("NUL \u0000 문자")).toBe("NUL  문자");
    expect(sanitizePgText("\u0000\u0000")).toBe("");
  });

  it("replaces lone surrogates but keeps valid pairs", () => {
    expect(sanitizePgText("a\ud800b")).toBe("a�b");
    expect(sanitizePgText("tail\udfff")).toBe("tail�");
    expect(sanitizePgText("emoji 😀 ok")).toBe("emoji 😀 ok");
  });

  it("returns clean text unchanged", () => {
    expect(sanitizePgText("한국어 텍스트 \\u0000 리터럴은 무사")).toBe(
      "한국어 텍스트 \\u0000 리터럴은 무사",
    );
  });
});

describe("sanitizePgJsonValue", () => {
  it("sanitizes strings recursively including object keys", () => {
    expect(
      sanitizePgJsonValue({
        "k\u0000ey": ["v\u0000alue", { nested: "\ud800" }],
        count: 3,
        flag: null,
      }),
    ).toEqual({ key: ["value", { nested: "�" }], count: 3, flag: null });
  });
});

describe("parseEventAppendBatch sanitization", () => {
  it("accepts exactly the closed running_transition field set", () => {
    const effect = {
      kind: "running_transition",
      review_state: "none",
      updated_at: "2026-08-11T00:00:00.000Z",
    };

    expect(
      parseEventAppendBatch(batchWithEffect(effect)).events[0]!.session_effect,
    ).toEqual(effect);
    expect(() =>
      parseEventAppendBatch(
        batchWithEffect({
          ...effect,
          unexpected: "must not be discarded",
        }),
      ),
    ).toThrow("session_effect has unexpected fields: unexpected");
  });

  it("sanitizes payload, searchable_text, dedupe key, and session effect", () => {
    const batch = parseEventAppendBatch({
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: STREAM_ID,
      first_seq: 7,
      events: [
        {
          stream_id: STREAM_ID,
          source_seq: 7,
          session_id: "session-a",
          event_type: "tool_start",
          payload: { prompt: "PG 비호환 문자(NUL \u0000, 서로게이트)" },
          searchable_text: "검색\u0000텍스트",
          created_at: "2026-08-07T09:00:00.000Z",
          semantic_dedupe_key: "key\u0000",
          session_effect: {
            kind: "last_message",
            last_message: {
              type: "complete",
              preview: "미리\u0000보기",
              timestamp: "2026-08-07T09:00:00.000Z",
            },
            updated_at: "2026-08-07T09:00:00.000Z",
          },
          payload_hash: PAYLOAD_HASH,
        },
      ],
    });

    const envelope = batch.events[0]!;
    expect(envelope.payload).toEqual({ prompt: "PG 비호환 문자(NUL , 서로게이트)" });
    expect(envelope.searchable_text).toBe("검색텍스트");
    expect(envelope.semantic_dedupe_key).toBe("key");
    expect(envelope.session_effect).toEqual({
      kind: "last_message",
      last_message: {
        type: "complete",
        preview: "미리보기",
        timestamp: "2026-08-07T09:00:00.000Z",
      },
      updated_at: "2026-08-07T09:00:00.000Z",
    });
    expect(envelope.payload_hash).toBe(PAYLOAD_HASH);
  });

  it("keeps clean envelopes byte-identical", () => {
    const payload = { type: "assistant_message", content: "정상 본문 🙂" };
    const batch = parseEventAppendBatch({
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: STREAM_ID,
      first_seq: 1,
      events: [
        {
          stream_id: STREAM_ID,
          source_seq: 1,
          session_id: "session-a",
          event_type: "assistant_message",
          payload,
          searchable_text: "정상 본문 🙂",
          created_at: "2026-08-07T09:00:00.000Z",
          semantic_dedupe_key: null,
          session_effect: null,
          payload_hash: PAYLOAD_HASH,
        },
      ],
    });
    expect(JSON.stringify(batch.events[0]!.payload)).toBe(JSON.stringify(payload));
    expect(batch.events[0]!.searchable_text).toBe("정상 본문 🙂");
  });
});

function batchWithEffect(sessionEffect: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: STREAM_ID,
    first_seq: 1,
    events: [{
      stream_id: STREAM_ID,
      source_seq: 1,
      session_id: "session-a",
      event_type: "system_message",
      payload: { type: "system_message", content: "running" },
      searchable_text: null,
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: "running_transition:session-a:start",
      session_effect: sessionEffect,
      payload_hash: PAYLOAD_HASH,
    }],
  };
}

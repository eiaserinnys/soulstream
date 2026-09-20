import { describe, expect, it } from "vitest";

import {
  UI_EVENT_ATTRS,
  UI_EVENT_FLOW_REQUIRED,
  UI_EVENT_QUERY_TEXT_MAX,
  UI_EVENT_TYPES,
  validateUiEvent,
} from "../src/index.js";

const RECEIVED_AT = Date.parse("2026-09-21T00:00:00.000Z");

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "11111111-2222-4333-8444-555555555555",
    seq: 1,
    occurredAt: "2026-09-20T23:59:00.000Z",
    type: "view_open",
    ...overrides,
  };
}

describe("ui event contract", () => {
  it("accepts a minimal navigation event", () => {
    const result = validateUiEvent(event(), RECEIVED_AT);
    expect(result.ok).toBe(true);
  });

  it("closes the event type enum", () => {
    expect(validateUiEvent(event({ type: "view_closed" }), RECEIVED_AT))
      .toEqual({ ok: false, reason: "unknown_type" });
  });

  it("rejects an attrs key that is not on the allowlist", () => {
    // 초안 원문을 담으려는 시도는 키 이름이 무엇이든 allowlist 밖이라 거절된다.
    const result = validateUiEvent(
      event({
        type: "compose_abandon",
        flowId: "compose-1",
        attrs: { draftPresent: true, draftLength: 12, draftText: "쓰다 만 문장" },
      }),
      RECEIVED_AT,
    );
    expect(result).toEqual({ ok: false, reason: "unknown_attr:draftText" });
  });

  it("keeps the draft length when the text itself is absent", () => {
    const result = validateUiEvent(
      event({
        type: "compose_abandon",
        flowId: "compose-1",
        attrs: { draftPresent: true, draftLength: 12 },
      }),
      RECEIVED_AT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attrs).toEqual({ draftPresent: true, draftLength: 12 });
  });

  it("requires the declared attrs for a type", () => {
    expect(
      validateUiEvent(
        event({ type: "compose_submit", flowId: "compose-1", attrs: { mode: "chat" } }),
        RECEIVED_AT,
      ),
    ).toEqual({ ok: false, reason: "missing_attr:draftLength" });
  });

  it("requires a flow id on the search, compose and action families", () => {
    for (const type of UI_EVENT_FLOW_REQUIRED) {
      const attrs = Object.fromEntries(
        UI_EVENT_ATTRS[type].required.map((key) => [key, placeholder(key)]),
      );
      expect(validateUiEvent(event({ type, attrs }), RECEIVED_AT))
        .toEqual({ ok: false, reason: "missing_flow_id" });
    }
  });

  it("never demands a flow id outside those families", () => {
    const standalone = UI_EVENT_TYPES.filter((type) => !UI_EVENT_FLOW_REQUIRED.has(type));
    expect(standalone).toEqual([
      "view_open",
      "notification_open",
      "app_active",
      "app_inactive",
    ]);
  });

  it("truncates an overlong search query instead of rejecting it", () => {
    const query = "가".repeat(UI_EVENT_QUERY_TEXT_MAX + 50);
    const result = validateUiEvent(
      event({
        type: "search_submit",
        flowId: "search-1",
        attrs: { queryText: query, trigger: "typing" },
      }),
      RECEIVED_AT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attrs.queryText).toHaveLength(UI_EVENT_QUERY_TEXT_MAX);
  });

  it("rejects an event from a clock that runs more than a day ahead", () => {
    expect(
      validateUiEvent(event({ occurredAt: "2026-09-23T00:00:00.000Z" }), RECEIVED_AT),
    ).toEqual({ ok: false, reason: "occurred_at_future" });
  });

  it("accepts a clock that lags, because late delivery is normal", () => {
    expect(validateUiEvent(event({ occurredAt: "2026-09-01T00:00:00.000Z" }), RECEIVED_AT).ok)
      .toBe(true);
  });

  it("closes the entry and target vocabularies", () => {
    expect(validateUiEvent(event({ entry: "telepathy" }), RECEIVED_AT))
      .toEqual({ ok: false, reason: "unknown_entry" });
    expect(validateUiEvent(event({ target: { kind: "spaceship", id: "x" } }), RECEIVED_AT))
      .toEqual({ ok: false, reason: "invalid_target" });
  });

  it("marks an automatic transition as not user initiated", () => {
    const result = validateUiEvent(event({ entry: "auto" }), RECEIVED_AT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entry).toBe("auto");
  });

  it("rejects a sequence number that is not a positive integer", () => {
    expect(validateUiEvent(event({ seq: 0 }), RECEIVED_AT))
      .toEqual({ ok: false, reason: "invalid_seq" });
  });

  it("rejects an event id that is not a uuid", () => {
    expect(validateUiEvent(event({ eventId: "not-a-uuid" }), RECEIVED_AT))
      .toEqual({ ok: false, reason: "invalid_event_id" });
  });
});

function placeholder(key: string): string | number | boolean {
  if (key.endsWith("Length") || key.endsWith("Ms") || key === "rank") return 1;
  if (key === "status") return "ok";
  if (key === "trigger") return "typing";
  if (key === "surface") return "feed_card";
  if (key.startsWith("draftPresent")) return true;
  return "x";
}

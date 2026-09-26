import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SSE_EVENT_TYPES as WIRE_SSE_EVENT_TYPES,
  type SSEEventTextSnapshot,
} from "@soulstream/wire-schema";

import { SSE_EVENT_TYPES } from "./constants";
import type { TextSnapshotEvent } from "./sse-events";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../wire-schema/fixtures/runtime_event_contract.json", import.meta.url),
    "utf8",
  ),
) as { textSnapshot: SSEEventTextSnapshot };

describe("text_snapshot generated wire contract", () => {
  it("uses the schema-generated snapshot shape at the web SSE boundary", () => {
    const event: TextSnapshotEvent = fixture.textSnapshot;

    expect(event).toMatchObject({
      type: "text_snapshot",
      basedOnEventId: 102,
      throughLiveSeq: 7,
      streams: [{ streamIdentity: "codex_sdk:contract-stream" }],
    });
  });
});

describe("dashboard SSE subscription contract", () => {
  it("uses every generated event except the explicitly unhandled events", () => {
    const excluded = new Set([
      "init",
      "reconnected",
      "realtime_status",
      "realtime_transcript",
      "session_ended",
    ]);
    const expected = WIRE_SSE_EVENT_TYPES.filter((eventType) => !excluded.has(eventType)).sort();

    expect([...SSE_EVENT_TYPES].sort()).toEqual(expected);
  });
});

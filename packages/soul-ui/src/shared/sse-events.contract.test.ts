import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SSEEventTextSnapshot } from "@soulstream/wire-schema";

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

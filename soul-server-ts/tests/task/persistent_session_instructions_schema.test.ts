import { describe, expect, it } from "vitest";

import {
  parsePersistentInstruction,
  parsePersistentInstructionsApplyPayload,
} from "@soulstream/wire-schema/persistent-session-instructions";

describe("persistent session instruction wire schema", () => {
  it("parses an instruction and trims its text", () => {
    expect(parsePersistentInstruction({
      id: "instruction-1",
      text: "  Keep replies concise.  ",
      source_turns: ["T195"],
      source_event_ids: [42],
      created_at: "2026-10-06T12:00:00.000Z",
      updated_at: "2026-10-06T12:00:00.000Z",
      status: "active",
      origin: "extracted",
    })).toEqual({
      ok: true,
      value: {
        id: "instruction-1",
        text: "Keep replies concise.",
        source_turns: ["T195"],
        source_event_ids: [42],
        created_at: "2026-10-06T12:00:00.000Z",
        updated_at: "2026-10-06T12:00:00.000Z",
        status: "active",
        origin: "extracted",
      },
    });
  });

  it("rejects blank text and unknown keys in items and apply payloads", () => {
    expect(parsePersistentInstruction({
      id: "instruction-1",
      text: "  ",
      source_turns: [],
      source_event_ids: [],
      created_at: "2026-10-06T12:00:00.000Z",
      updated_at: "2026-10-06T12:00:00.000Z",
      status: "active",
      origin: "agent",
    }).ok).toBe(false);

    expect(parsePersistentInstruction({
      id: "instruction-1",
      text: "Keep replies concise.",
      source_turns: [],
      source_event_ids: [],
      created_at: "2026-10-06T12:00:00.000Z",
      updated_at: "2026-10-06T12:00:00.000Z",
      status: "active",
      origin: "agent",
      extra: true,
    }).ok).toBe(false);

    expect(parsePersistentInstructionsApplyPayload({
      session_id: "session-1",
      origin: "extracted",
      ops: [{ op: "add", text: "Keep replies concise." }],
      unexpected: true,
    }).ok).toBe(false);
  });
});

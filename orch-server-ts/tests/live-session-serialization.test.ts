import { describe, expect, it } from "vitest";

import { serializeSessionRow } from "../src/runtime/live_session_serialization.js";

describe("serializeSessionRow predecessor contract", () => {
  it("exposes the additive predecessorSessionId field", () => {
    expect(serializeSessionRow({
      session_id: "sess-next",
      predecessor_session_id: "sess-previous",
      created_at: new Date("2026-07-14T00:00:00.000Z"),
      updated_at: new Date("2026-07-14T00:00:00.000Z"),
    })).toMatchObject({
      agentSessionId: "sess-next",
      predecessorSessionId: "sess-previous",
    });
  });
});

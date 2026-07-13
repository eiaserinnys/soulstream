import { describe, expect, it } from "vitest";

import { toSessionSummary } from "./mappers";

describe("SessionSummary binding warnings", () => {
  it("normalizes snake_case durable projection warnings", () => {
    expect(toSessionSummary({
      agent_session_id: "sess-recovered",
      status: "running",
      binding_warnings: [{
        code: "PAGE_BINDING_MANUAL_REPAIR",
        message: "Manual repair is required.",
      }],
    })).toMatchObject({
      agentSessionId: "sess-recovered",
      bindingWarnings: [{
        code: "PAGE_BINDING_MANUAL_REPAIR",
        message: "Manual repair is required.",
      }],
    });
  });

  it("drops malformed warning entries at the external boundary", () => {
    expect(toSessionSummary({
      agent_session_id: "sess-clean",
      status: "running",
      bindingWarnings: [
        { code: "UNKNOWN", message: "bad" },
        { code: "PAGE_BINDING_PENDING", message: 3 },
      ],
    }).bindingWarnings).toEqual([]);
  });
});

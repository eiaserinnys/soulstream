import { describe, expect, it } from "vitest";

import { detectMissingSupervisors } from "../../src/supervisor/watchdog.js";

describe("Supervisor watchdog", () => {
  it("alerts when an active supervisor has not been seen past threshold", () => {
    const alerts = detectMissingSupervisors(
      [
        {
          role: "ariela_codex",
          activeSessionId: "sess-supervisor",
          lastSeenAt: new Date("2026-06-07T00:00:00.000Z"),
        },
      ],
      new Date("2026-06-07T00:05:01.000Z"),
      5 * 60 * 1000,
    );

    expect(alerts).toEqual([
      {
        role: "ariela_codex",
        activeSessionId: "sess-supervisor",
        missingForMs: 301_000,
        lastSeenAt: new Date("2026-06-07T00:00:00.000Z"),
      },
    ]);
  });

  it("does not alert inactive or recently seen supervisors", () => {
    const alerts = detectMissingSupervisors(
      [
        { role: "inactive", activeSessionId: null, lastSeenAt: null },
        {
          role: "fresh",
          activeSessionId: "sess-fresh",
          lastSeenAt: new Date("2026-06-07T00:04:00.000Z"),
        },
      ],
      new Date("2026-06-07T00:05:00.000Z"),
      5 * 60 * 1000,
    );

    expect(alerts).toEqual([]);
  });
});

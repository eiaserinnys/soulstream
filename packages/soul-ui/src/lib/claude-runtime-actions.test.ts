import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getResumeAfterLimitEligibility,
  scheduleResumeAfterLimit,
} from "./claude-runtime-actions";

describe("resume-after-limit API actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads eligibility only through the session endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      eligible: false,
      reason: "reset unavailable",
      resets_at: null,
      schedule: null,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResumeAfterLimitEligibility("session/a")).resolves.toEqual({
      eligible: false,
      reason: "reset unavailable",
      resets_at: null,
      schedule: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%2Fa/resume-after-limit");
  });

  it("posts an empty JSON object and returns only the schedule response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      schedule_id: "resume-after-limit:session-a:32:0",
      run_at: "2026-09-28T11:00:00.000Z",
      status: "active",
      reused: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleResumeAfterLimit("session-a")).resolves.toEqual({
      schedule_id: "resume-after-limit:session-a:32:0",
      run_at: "2026-09-28T11:00:00.000Z",
      status: "active",
      reused: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-a/resume-after-limit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

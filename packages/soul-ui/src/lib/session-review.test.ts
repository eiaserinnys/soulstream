import { afterEach, describe, expect, it, vi } from "vitest";

import { acknowledgeSessionReview } from "./session-review";

afterEach(() => vi.unstubAllGlobals());

describe("acknowledgeSessionReview", () => {
  it("uses the cookie-authenticated additive endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        agentSessionId: "sess/a",
        reviewState: "acknowledged",
        changed: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(acknowledgeSessionReview("sess/a")).resolves.toMatchObject({
      reviewState: "acknowledged",
      changed: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/sess%2Fa/review/acknowledge",
      { method: "POST", credentials: "same-origin" },
    );
  });

  it("surfaces the server's explicit review error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "REVIEW_NOT_REQUIRED", message: "not human-owned" },
      }),
    }));

    await expect(acknowledgeSessionReview("sess-1")).rejects.toThrow(
      "REVIEW_NOT_REQUIRED: not human-owned",
    );
  });
});

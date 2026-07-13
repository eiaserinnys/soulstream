import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
} from "./session-review";

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

    const error = await acknowledgeSessionReview("sess-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionReviewAcknowledgeError);
    expect(error).toMatchObject({
      status: 409,
      code: "REVIEW_NOT_REQUIRED",
      message: "REVIEW_NOT_REQUIRED: not human-owned",
    });
  });

  it("keeps a malformed server failure distinguishable from a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => { throw new Error("invalid json"); },
    }));

    const error = await acknowledgeSessionReview("missing").catch((caught) => caught);
    expect(error).toMatchObject({
      status: 404,
      code: "REVIEW_ACKNOWLEDGE_FAILED",
    });
  });
});

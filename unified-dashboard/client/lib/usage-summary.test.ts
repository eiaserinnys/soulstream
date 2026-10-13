import { describe, expect, it, vi } from "vitest";

import { HttpResponseError } from "./http-response-error";
import { fetchUsageSummary } from "./usage-summary";

describe("fetchUsageSummary", () => {
  it("reads the authenticated same-origin summary endpoint", async () => {
    const payload = { generatedAt: "2026-10-11T00:00:00.000Z", collectedAt: null, nodes: [] };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));

    await expect(fetchUsageSummary(request)).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith("/api/usage/summary", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });

  it("preserves HTTP status so the hook can distinguish server pending", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 }));

    await expect(fetchUsageSummary(request)).rejects.toMatchObject({
      name: "HttpResponseError",
      status: 404,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { createExpoPushProvider } from "../src/index.js";

describe("Expo push provider", () => {
  it.each([
    { data: { status: "ok", id: "ticket-a" } },
    { data: [{ status: "ok", id: "ticket-a" }] },
  ])("accepts Expo dict and list success responses", async (payload) => {
    const fetch = fakeFetch(payload);
    const provider = createExpoPushProvider({ fetch });

    await expect(provider.send("token", "title", "body", { key: "value" }))
      .resolves.toEqual({ ok: true, invalidToken: false });
    expect(fetch).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          to: "token",
          title: "title",
          body: "body",
          data: { key: "value" },
          sound: "default",
          priority: "high",
        }),
      }),
    );
  });

  it("marks DeviceNotRegistered as an invalid token", async () => {
    const provider = createExpoPushProvider({
      fetch: fakeFetch({
        data: {
          status: "error",
          details: { error: "DeviceNotRegistered" },
        },
      }),
    });

    await expect(provider.send("token", "title", "body", {})).resolves.toEqual({
      ok: false,
      invalidToken: true,
      error: "DeviceNotRegistered",
    });
  });

  it("keeps non-token Expo errors without invalidating the registration", async () => {
    const provider = createExpoPushProvider({
      fetch: fakeFetch({
        data: [{ status: "error", details: { error: "MessageRateExceeded" } }],
      }),
    });

    await expect(provider.send("token", "title", "body", {})).resolves.toEqual({
      ok: false,
      invalidToken: false,
      error: "MessageRateExceeded",
    });
  });

  it("returns a failed result when fetch rejects", async () => {
    const provider = createExpoPushProvider({
      fetch: vi.fn(async () => { throw new Error("network down"); }),
    });

    await expect(provider.send("token", "title", "body", {})).resolves.toEqual({
      ok: false,
      invalidToken: false,
      error: "network down",
    });
  });
});

function fakeFetch(payload: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

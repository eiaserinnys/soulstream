import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveAuthHttpClient } from "../src/index.js";

describe("live auth OAuth HTTP client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts route-provided OAuth form data to the route-provided URL", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ access_token: "google-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const httpClient = createLiveAuthHttpClient({ fetch, timeoutMs: 1234 });

    await expect(
      httpClient.post({
        url: "https://oauth2.googleapis.com/token",
        data: {
          code: "auth-code",
          client_id: "google-client",
          client_secret: "google-secret",
          redirect_uri: "https://orch.example.test/api/auth/google/callback",
          grant_type: "authorization_code",
        },
      }),
    ).resolves.toEqual({
      statusCode: 200,
      body: { access_token: "google-access-token" },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).toBe(
      new URLSearchParams({
        code: "auth-code",
        client_id: "google-client",
        client_secret: "google-secret",
        redirect_uri: "https://orch.example.test/api/auth/google/callback",
        grant_type: "authorization_code",
      }).toString(),
    );
  });

  it("gets route-provided userinfo URL with forwarded Authorization header", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ email: "oauth@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const httpClient = createLiveAuthHttpClient({ fetch });

    await expect(
      httpClient.get({
        url: "https://www.googleapis.com/oauth2/v2/userinfo",
        headers: { Authorization: "Bearer google-access-token" },
      }),
    ).resolves.toEqual({
      statusCode: 200,
      body: { email: "oauth@example.com" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer google-access-token" },
      }),
    );
  });

  it("returns non-200 text bodies without throwing", async () => {
    const httpClient = createLiveAuthHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) =>
        new Response("bad_code", { status: 400 }),
      ),
    });

    await expect(
      httpClient.post({
        url: "https://oauth2.googleapis.com/token",
        data: { code: "bad" },
      }),
    ).resolves.toEqual({
      statusCode: 400,
      body: "bad_code",
    });
  });

  it("lets invalid JSON and fetch failures propagate to the auth route catch", async () => {
    const invalidJsonClient = createLiveAuthHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) =>
        new Response("not-json", { status: 200 }),
      ),
    });
    await expect(
      invalidJsonClient.post({
        url: "https://oauth2.googleapis.com/token",
        data: { code: "bad-json" },
      }),
    ).rejects.toThrow();

    const failedClient = createLiveAuthHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) => {
        throw new Error("network unavailable");
      }),
    });
    await expect(
      failedClient.get({
        url: "https://www.googleapis.com/oauth2/v2/userinfo",
        headers: { Authorization: "Bearer google-access-token" },
      }),
    ).rejects.toThrow("network unavailable");
  });

  it("aborts with the injected and default timeout boundaries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const injected = createLiveAuthHttpClient({ fetch, timeoutMs: 5 });
    const injectedPending = injected.post({
      url: "https://oauth2.googleapis.com/token",
      data: { code: "slow" },
    });
    const injectedAssertion = expect(injectedPending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5);
    await injectedAssertion;

    const defaultClient = createLiveAuthHttpClient({ fetch });
    const defaultPending = defaultClient.get({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
      headers: { Authorization: "Bearer slow" },
    });
    const defaultAssertion = expect(defaultPending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);
    await defaultAssertion;
  });
});

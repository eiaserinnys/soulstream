import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveAtomHttpClient } from "../src/index.js";

describe("live atom HTTP client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards the route-built URL, API key header, and GET method without a body", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify([{ id: "atom-node" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const httpClient = createLiveAtomHttpClient({ fetch, timeoutMs: 1234 });

    await expect(
      httpClient.get({
        url: "https://atom.example.test/api/tree/root/children?depth=1",
        headers: { "x-api-key": "atom-secret" },
      }),
    ).resolves.toEqual({
      statusCode: 200,
      body: [{ id: "atom-node" }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://atom.example.test/api/tree/root/children?depth=1");
    expect(init).toMatchObject({
      method: "GET",
      headers: { "x-api-key": "atom-secret" },
    });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns non-2xx status and response bodies without throwing", async () => {
    const httpClient = createLiveAtomHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ detail: "Node not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      httpClient.get({
        url: "https://atom.example.test/api/tree/missing/children",
        headers: { "x-api-key": "atom-secret" },
      }),
    ).resolves.toEqual({
      statusCode: 404,
      body: { detail: "Node not found" },
    });
  });

  it("lets successful invalid JSON and fetch failures propagate to the route catch", async () => {
    const invalidJsonClient = createLiveAtomHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) =>
        new Response("not-json", { status: 200 }),
      ),
    });
    await expect(
      invalidJsonClient.get({
        url: "https://atom.example.test/api/tree",
        headers: { "x-api-key": "atom-secret" },
      }),
    ).rejects.toThrow();

    const failedClient = createLiveAtomHttpClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) => {
        throw new Error("network unavailable");
      }),
    });
    await expect(
      failedClient.get({
        url: "https://atom.example.test/api/tree",
        headers: { "x-api-key": "atom-secret" },
      }),
    ).rejects.toThrow("network unavailable");
  });

  it("aborts at the injected and Python-compatible default timeout boundaries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const request = {
      url: "https://atom.example.test/api/tree",
      headers: { "x-api-key": "atom-secret" },
    };

    const injectedPending = createLiveAtomHttpClient({ fetch, timeoutMs: 5 }).get(
      request,
    );
    const injectedAssertion = expect(injectedPending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5);
    await injectedAssertion;

    const defaultPending = createLiveAtomHttpClient({ fetch }).get(request);
    const defaultAssertion = expect(defaultPending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);
    await defaultAssertion;
  });

  it("rejects invalid timeout configuration before making a request", () => {
    expect(() => createLiveAtomHttpClient({ timeoutMs: 0 })).toThrow(
      "Atom HTTP timeoutMs must be a positive integer: 0",
    );
  });
});

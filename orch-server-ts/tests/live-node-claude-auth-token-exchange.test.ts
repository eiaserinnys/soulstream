import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveNodeClaudeAuthTokenExchangeClient,
  type ClaudeAuthTokenExchangeRequest,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

const tokenExchangeCases: Array<{
  readonly flow: ClaudeAuthTokenExchangeRequest["flow"];
  readonly data: Record<string, string>;
}> = [
  {
    flow: "browser",
    data: {
      grant_type: "authorization_code",
      client_id: "browser-client",
      code: "browser-code",
      redirect_uri: "https://orch.example.test/api/nodes/claude-auth/callback",
      code_verifier: "browser-verifier",
      state: "browser-state",
    },
  },
  {
    flow: "headless",
    data: {
      grant_type: "authorization_code",
      client_id: "headless-client",
      code: "headless-code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: "headless-verifier",
      state: "headless-state",
    },
  },
];

describe("live node Claude auth token exchange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(tokenExchangeCases)(
    "posts $flow OAuth data as x-www-form-urlencoded to the route-provided URL",
    async ({ flow, data }) => {
      const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: `${flow}-access-token`,
            refresh_token: `${flow}-refresh-token`,
            expires_in: 3600,
            scope: "user:profile",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
      const tokenExchange = createLiveNodeClaudeAuthTokenExchangeClient({
        fetch,
        timeoutMs: 1234,
      });

      await expect(
        tokenExchange({
          url: "https://platform.claude.com/v1/oauth/token",
          flow,
          data,
        }),
      ).resolves.toEqual({
        statusCode: 200,
        body: {
          access_token: `${flow}-access-token`,
          refresh_token: `${flow}-refresh-token`,
          expires_in: 3600,
          scope: "user:profile",
        },
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      const call = fetch.mock.calls[0];
      if (call === undefined) throw new Error("fetch was not called");
      const [url, init] = call;
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(String(init.body)).toBe(new URLSearchParams(data).toString());
    },
  );

  it("returns non-200 response text without throwing", async () => {
    const tokenExchange = createLiveNodeClaudeAuthTokenExchangeClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) =>
        new Response("bad_code", { status: 400 }),
      ),
    });

    await expect(
      tokenExchange({
        url: "https://platform.claude.com/v1/oauth/token",
        flow: "headless",
        data: { code: "bad" },
      }),
    ).resolves.toEqual({
      statusCode: 400,
      text: "bad_code",
    });
  });

  it("aborts the fetch with the injected timeout boundary", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const tokenExchange = createLiveNodeClaudeAuthTokenExchangeClient({
      fetch,
      timeoutMs: 5,
    });

    const pending = tokenExchange({
      url: "https://platform.claude.com/v1/oauth/token",
      flow: "browser",
      data: { code: "slow" },
    });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5);

    await assertion;
  });

  it("lets browser route network failures propagate instead of mapping them to token failure detail", async () => {
    const tokenExchange = createLiveNodeClaudeAuthTokenExchangeClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) => {
        throw new Error("network unavailable");
      }),
    });
    const harness = createClaudeAuthHarness({ tokenExchange });
    harness.sessionStore.seed("state-network", {
      verifier: "verifier-network",
      metadata: { node_id: "fake-node" },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=callback-code&state=state-network",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("Token exchange failed");
    await harness.app.close();
  });

  it("lets headless route network failures propagate instead of mapping them to token failure detail", async () => {
    const tokenExchange = createLiveNodeClaudeAuthTokenExchangeClient({
      fetch: vi.fn(async (_url: string, _init: RequestInit) => {
        throw new Error("network unavailable");
      }),
    });
    const harness = createClaudeAuthHarness({ tokenExchange });
    harness.sessionStore.seed("state-network", {
      verifier: "verifier-network",
      metadata: { node_id: "fake-node" },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "headless-code#state-network" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("token_exchange_failed");
    await harness.app.close();
  });
});

import { describe, expect, it, vi } from "vitest";

import { OAUTH_STATE_COOKIE_NAME, createApp } from "../src/index.js";
import {
  config,
  createAuthRouteOptions,
  createHttpClient,
} from "./auth-route-test-helpers.js";

describe("Auth OAuth callback failure routes", () => {
  it("keeps token exchange non-200 and malformed body on auth_failed redirect", async () => {
    const tokenNon200 = createHttpClient();
    tokenNon200.post = vi.fn(async () => ({ statusCode: 400, body: "bad_code" }));
    const non200App = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient: tokenNon200 }),
    });

    const non200 = await non200App.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=bad&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });

    expect(non200.statusCode).toBe(302);
    expect(non200.headers.location).toBe("/?error=auth_failed");
    expect(tokenNon200.get).not.toHaveBeenCalled();
    await non200App.close();

    const tokenMalformed = createHttpClient();
    tokenMalformed.post = vi.fn(async () => ({ statusCode: 200, body: "not-json" }));
    const malformedApp = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient: tokenMalformed }),
    });

    const malformed = await malformedApp.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=bad-body&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });

    expect(malformed.statusCode).toBe(302);
    expect(malformed.headers.location).toBe("/?error=auth_failed");
    expect(tokenMalformed.get).not.toHaveBeenCalled();
    await malformedApp.close();
  });

  it("keeps userinfo non-200, malformed body, and fetch failure on auth_failed redirect", async () => {
    const userinfoNon200 = createHttpClient();
    userinfoNon200.get = vi.fn(async () => ({ statusCode: 401, body: "bad_token" }));
    const non200App = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient: userinfoNon200 }),
    });

    const non200 = await non200App.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });

    expect(non200.statusCode).toBe(302);
    expect(non200.headers.location).toBe("/?error=auth_failed");
    await non200App.close();

    const userinfoMalformed = createHttpClient();
    userinfoMalformed.get = vi.fn(async () => ({ statusCode: 200, body: {} }));
    const malformedApp = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient: userinfoMalformed }),
    });

    const malformed = await malformedApp.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });

    expect(malformed.statusCode).toBe(302);
    expect(malformed.headers.location).toBe("/?error=auth_failed");
    await malformedApp.close();

    const fetchFailure = createHttpClient();
    fetchFailure.get = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const failedApp = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient: fetchFailure }),
    });

    const failed = await failedApp.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });

    expect(failed.statusCode).toBe(302);
    expect(failed.headers.location).toBe("/?error=auth_failed");
    await failedApp.close();
  });
});

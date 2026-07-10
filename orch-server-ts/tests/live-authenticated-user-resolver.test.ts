import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveAuthenticatedUserResolvers,
  type AuthJwtHelper,
} from "../src/index.js";

describe("live authenticated user resolver", () => {
  it("resolves the dashboard JWT cookie before a bearer header", async () => {
    const jwt = createJwtHelper({
      "cookie-jwt": { email: "cookie@example.com", name: "Cookie" },
      "bearer-jwt": { email: "bearer@example.com", name: "Bearer" },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });

    await expect(
      resolvers.resolveUser(requestWithHeaders({
        cookie: "other=value; soul_dashboard_auth=cookie-jwt",
        authorization: "Bearer bearer-jwt",
      })),
    ).resolves.toMatchObject({ email: "cookie@example.com", name: "Cookie" });
    expect(jwt.verifyToken).toHaveBeenCalledTimes(1);
    expect(jwt.verifyToken).toHaveBeenCalledWith("cookie-jwt");
  });

  it("accepts a bearer JWT when the dashboard cookie is absent", async () => {
    const jwt = createJwtHelper({
      "native-jwt": { email: "native@example.com" },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });

    await expect(
      resolvers.resolveUser(requestWithHeaders({ authorization: "Bearer native-jwt" })),
    ).resolves.toEqual({ email: "native@example.com" });
  });

  it("rejects missing, malformed, and non-JWT service bearer credentials", async () => {
    const jwt = createJwtHelper({});
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });

    await expect(resolvers.resolveUser(requestWithHeaders({}))).resolves.toBeNull();
    await expect(
      resolvers.resolveUser(requestWithHeaders({ authorization: "Basic value" })),
    ).resolves.toBeNull();
    await expect(
      resolvers.resolveUser(requestWithHeaders({ authorization: "Bearer service-token" })),
    ).resolves.toBeNull();
  });

  it("exposes the same verified identity as an authenticated-email resolver", async () => {
    const jwt = createJwtHelper({
      "user-jwt": { email: "User@Example.com" },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });

    await expect(
      resolvers.resolveEmail(
        requestWithHeaders({ cookie: "soul_dashboard_auth=user-jwt" }),
      ),
    ).resolves.toBe("User@Example.com");
    await expect(resolvers.resolveEmail(requestWithHeaders({}))).resolves.toBeNull();
  });

  it("preserves a truthy body caller_info before JWT classification", async () => {
    const jwt = createJwtHelper({
      "minimal-jwt": { email: "cron@example.com" },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });
    const supplied = { source: "agent", agent_node: "node-a", agent_id: "roselin" };

    await expect(resolvers.resolveCallerInfo(
      requestWithHeaders({ authorization: "Bearer minimal-jwt" }),
      supplied,
      "ignored-node",
    )).resolves.toEqual(supplied);
    expect(jwt.verifyToken).not.toHaveBeenCalled();
  });

  it("classifies a name-less JWT as system caller_info", async () => {
    const jwt = createJwtHelper({
      "minimal-jwt": { email: "cron@example.com" },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });

    await expect(resolvers.resolveCallerInfo(
      requestWithHeaders({ authorization: "Bearer minimal-jwt" }),
      undefined,
      "node-a",
    )).resolves.toEqual({
      source: "system",
      agent_node: "node-a",
      display_name: "Soulstream",
      user_id: null,
      avatar_url: "/api/system/portraits/system",
    });
  });

  it("builds browser caller_info from HTTP metadata and a named JWT", async () => {
    const jwt = createJwtHelper({
      "user-jwt": {
        email: "alice@example.com",
        name: "Alice",
        picture: "https://example.com/alice.png",
      },
    });
    const resolvers = createLiveAuthenticatedUserResolvers({ jwt });
    const request = requestWithHeaders({
      authorization: "Bearer user-jwt",
      "user-agent": "TestClient/1.0",
      referer: "https://dashboard.example.com",
      "x-forwarded-for": "203.0.113.8",
    });
    Object.assign(request, { ip: "198.51.100.4" });

    await expect(resolvers.resolveCallerInfo(request, undefined, "ignored")).resolves.toEqual({
      source: "browser",
      ip: "198.51.100.4",
      user_agent: "TestClient/1.0",
      referer: "https://dashboard.example.com",
      forwarded_for: "203.0.113.8",
      display_name: "Alice",
      user_id: "alice@example.com",
      avatar_url: "https://example.com/alice.png",
      email: "alice@example.com",
    });
  });
});

function createJwtHelper(
  payloads: Readonly<Record<string, Awaited<ReturnType<AuthJwtHelper["verifyToken"]>>>>,
): AuthJwtHelper {
  return {
    issueToken: vi.fn(async () => "unused"),
    verifyToken: vi.fn(async (token) => payloads[token] ?? null),
  };
}

function requestWithHeaders(
  headers: Readonly<Record<string, string>>,
): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

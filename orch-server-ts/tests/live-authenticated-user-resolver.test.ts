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

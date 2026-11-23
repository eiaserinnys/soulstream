import { describe, expect, it, vi } from "vitest";

import {
  NODE_FORWARD_JWT_TTL_SECONDS,
  buildNodeForwardAuthHeaders,
  type NodeForwardAuthIssuer,
} from "../src/node/node_forward_auth_headers.js";
import { signJwt, verifySignedJwt } from "../src/runtime/live_auth_route_provider.js";

const JWT_SECRET = "forward-test-secret";
const tailscaleUser = {
  payload: { email: "owner@example.com", name: "owner@example.com" },
  carrier: "tailscale" as const,
};

function createIssuer(overrides: Partial<NodeForwardAuthIssuer> = {}) {
  const resolveUser = vi.fn(overrides.resolveUser ?? (async () => tailscaleUser));
  const sign = vi.fn(overrides.signJwt ?? signJwt);
  const issuer: NodeForwardAuthIssuer = {
    resolveUser,
    readJwtSecret: overrides.readJwtSecret ?? (async () => JWT_SECRET),
    signJwt: sign,
  };
  return { issuer, resolveUser, sign };
}

describe("buildNodeForwardAuthHeaders", () => {
  it("cookie가 있으면 그대로 넘기고 새 토큰을 만들지 않는다", async () => {
    const { issuer, resolveUser, sign } = createIssuer();
    await expect(buildNodeForwardAuthHeaders({
      cookie: "soul_dashboard_auth=browser-cookie",
      "tailscale-user-login": "owner@example.com",
    }, issuer)).resolves.toEqual({ cookie: "soul_dashboard_auth=browser-cookie" });
    expect(resolveUser).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("authorization만 있으면 그대로 넘긴다", async () => {
    const { issuer, sign } = createIssuer();
    await expect(buildNodeForwardAuthHeaders({
      authorization: "Bearer node-token",
    }, issuer)).resolves.toEqual({ authorization: "Bearer node-token" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("둘 다 없고 사용자가 확인되면 soul_dashboard_auth 쿠키를 넘긴다", async () => {
    const { issuer } = createIssuer();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const headers = await buildNodeForwardAuthHeaders({
      "tailscale-user-login": "owner@example.com",
    }, issuer);
    expect(Object.keys(headers ?? {})).toEqual(["cookie"]);
    const token = headers?.cookie?.match(/^soul_dashboard_auth=(.+)$/)?.[1];
    expect(token).toBeDefined();
    const payload = verifySignedJwt(token!, JWT_SECRET, nowSeconds);
    expect(payload).toMatchObject({ sub: "owner@example.com", email: "owner@example.com" });
    const exp = payload?.exp as number;
    expect(exp).toBeGreaterThan(nowSeconds);
    expect(exp).toBeLessThanOrEqual(nowSeconds + NODE_FORWARD_JWT_TTL_SECONDS + 1);
    expect(verifySignedJwt(token!, "other-secret", nowSeconds)).toBeNull();
  });

  it("둘 다 없고 사용자가 없으면 아무것도 넘기지 않는다", async () => {
    const { issuer, sign } = createIssuer({ resolveUser: async () => null });
    await expect(buildNodeForwardAuthHeaders({}, issuer)).resolves.toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });

  it("jwt_secret이 비었으면 아무것도 넘기지 않고 예외가 없다", async () => {
    const { issuer, sign } = createIssuer({ readJwtSecret: async () => "" });
    await expect(buildNodeForwardAuthHeaders({
      "tailscale-user-login": "owner@example.com",
    }, issuer)).resolves.toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });
});

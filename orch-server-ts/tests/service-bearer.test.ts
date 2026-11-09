import { describe, expect, it, vi } from "vitest";

import {
  extractBearerToken,
  verifyServiceBearerAuthorization,
} from "../src/auth/service_bearer.js";
import type { NodeCredentialResolver, NodePrincipal } from "../src/node_credentials/types.js";

const PRINCIPAL: NodePrincipal = {
  credential_id: "credential-1",
  node_id: "node-1",
  company_pc: false,
};

function resolverFor(principal: NodePrincipal | null): NodeCredentialResolver {
  return {
    resolve: vi.fn((_token: string) => principal),
    onRevoked: vi.fn(() => () => {}),
  };
}

describe("service bearer authorization", () => {
  it("parses the Authorization header in one shared place", () => {
    expect(extractBearerToken("bEaReR   service-token ")).toBe("service-token");
    expect(extractBearerToken(["Basic service-token", "Bearer later-token"]))
      .toBeUndefined();
    expect(extractBearerToken("Bearer token extra")).toBeUndefined();
  });

  it("uses one development bypass and fail-closed production result", () => {
    expect(verifyServiceBearerAuthorization(undefined, {
      configuredToken: "",
      environment: "development",
      nodeCredentials: null,
    })).toEqual({ ok: true, developmentBypass: true });
    expect(verifyServiceBearerAuthorization(undefined, {
      configuredToken: "",
      environment: "production",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "not_configured", statusCode: 503 });
  });

  it("defaults the environment to production when it is omitted", () => {
    expect(verifyServiceBearerAuthorization(undefined, {
      configuredToken: "",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "not_configured", statusCode: 503 });
  });

  it("keeps missing and malformed headers at 401", () => {
    expect(verifyServiceBearerAuthorization(undefined, {
      configuredToken: "expected",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "missing", statusCode: 401 });
    expect(verifyServiceBearerAuthorization("Basic expected", {
      configuredToken: "expected",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "malformed", statusCode: 401 });
  });

  it("uses 401 for a configured service token mismatch", () => {
    expect(verifyServiceBearerAuthorization("Bearer wrong", {
      configuredToken: "expected",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "invalid", statusCode: 401 });
  });

  it("accepts the shared service token without a principal", () => {
    const resolver = resolverFor(PRINCIPAL);
    expect(verifyServiceBearerAuthorization("Bearer service-token", {
      configuredToken: "service-token",
      nodeCredentials: resolver,
    })).toEqual({ ok: true });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("accepts a node credential token with its principal", () => {
    expect(verifyServiceBearerAuthorization("Bearer node-token", {
      configuredToken: "service-token",
      nodeCredentials: resolverFor(PRINCIPAL),
    })).toEqual({ ok: true, principal: PRINCIPAL });
  });

  it("rejects unknown and revoked node tokens", () => {
    expect(verifyServiceBearerAuthorization("Bearer unknown", {
      configuredToken: "service-token",
      nodeCredentials: resolverFor(null),
    })).toEqual({ ok: false, reason: "invalid", statusCode: 401 });
  });

  it("rejects node-shaped tokens when the resolver is null", () => {
    expect(verifyServiceBearerAuthorization("Bearer node-token", {
      configuredToken: "service-token",
      nodeCredentials: null,
    })).toEqual({ ok: false, reason: "invalid", statusCode: 401 });
  });
});

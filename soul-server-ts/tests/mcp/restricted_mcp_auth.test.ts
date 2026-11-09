/**
 * ssr1 restricted 자격 증명(§3)과 principal 판정 검증.
 *
 * 형식·길이·HMAC 상수 시간 재계산·DB 존재·정책 공급 실패 경로, full 경로 불변,
 * 같은 listener의 REST가 ssr1을 받지 않는 것까지 확인한다.
 */
import { describe, expect, it } from "vitest";

import {
  createRestrictedMcpToken,
  extractBearerToken,
  isRestrictedMcpToken,
  RESTRICTED_MCP_TOKEN_PREFIX,
  verifyRestrictedMcpToken,
} from "../../src/security/restricted_mcp_auth.js";
import {
  defaultIsolationPolicyPath,
  loadIsolationPolicyFile,
} from "../../src/security/session_isolation_policy.js";
import {
  resolveMcpPrincipal,
  type McpAuthConfig,
  type McpRestrictedAuthConfig,
} from "../../src/mcp/auth.js";
import { buildServer } from "../../src/server.js";
import { makeLlmHarness, silentLogger } from "../llm/llm_test_helpers.js";

const KEY = "test-bearer-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const HEX_SESSION = "abcdefab-cdef-4abc-8def-abcdefabcdef";

const loadedPolicy = loadIsolationPolicyFile(defaultIsolationPolicyPath());

function authConfig(overrides: Partial<McpAuthConfig> = {}): McpAuthConfig {
  return {
    requireAuth: true,
    bearerToken: KEY,
    allowedHosts: ["localhost", "127.0.0.1"],
    ...overrides,
  };
}

function restrictedConfig(
  overrides: Partial<McpRestrictedAuthConfig> = {},
): McpRestrictedAuthConfig {
  return {
    policyProvider: { get: () => loadedPolicy },
    sessionExists: async () => true,
    ...overrides,
  };
}

describe("restricted MCP token format", () => {
  it("issues ssr1.<session>.<base64url hmac> for canonical session ids", () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    expect(token.startsWith(RESTRICTED_MCP_TOKEN_PREFIX)).toBe(true);
    expect(isRestrictedMcpToken(token)).toBe(true);
    const [prefix, sessionId, signature, ...rest] = token.split(".");
    expect(prefix).toBe("ssr1");
    expect(sessionId).toBe(SESSION_A);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rest).toEqual([]);
    expect(token.length).toBeLessThanOrEqual(256);
  });

  it("rejects non-canonical session ids and empty keys at issue time", () => {
    expect(() => createRestrictedMcpToken(HEX_SESSION.toUpperCase(), KEY)).toThrow();
    expect(() => createRestrictedMcpToken("not-a-uuid", KEY)).toThrow();
    expect(() => createRestrictedMcpToken(SESSION_A, "")).toThrow();
  });

  it("recomputes the HMAC in constant time and rejects forgery", () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    expect(verifyRestrictedMcpToken(token, KEY)).toEqual({ ok: true, sessionId: SESSION_A });

    expect(verifyRestrictedMcpToken(token, "another-key")).toEqual({ ok: false, reason: "signature" });

    const [prefix, , signature] = token.split(".");
    const borrowed = `${prefix}.${SESSION_B}.${signature}`;
    expect(verifyRestrictedMcpToken(borrowed, KEY)).toEqual({ ok: false, reason: "signature" });

    expect(verifyRestrictedMcpToken(token, "")).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("rejects malformed, over-long and non-canonical tokens before hashing", () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    expect(verifyRestrictedMcpToken("ssr1.", KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken("bearer-token", KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken(`ssr1.${SESSION_A}`, KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken(`ssr1.${SESSION_A}.short`, KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken(`ssr1.${SESSION_A}.${"a".repeat(43)}.extra`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken(`ssr1.${HEX_SESSION.toUpperCase()}.${"a".repeat(43)}`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyRestrictedMcpToken(`ssr1.${SESSION_A}.${"a".repeat(43)}`.padEnd(300, "a"), KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(isRestrictedMcpToken(token)).toBe(true);
  });

  it("extracts exactly one bearer value from the Authorization header", () => {
    expect(extractBearerToken(`Bearer ${KEY}`)).toBe(KEY);
    expect(extractBearerToken(`bearer ${KEY}`)).toBe(KEY);
    expect(extractBearerToken(`BEARER   ${KEY}`)).toBe(KEY);
    expect(extractBearerToken(KEY)).toBeUndefined();
    expect(extractBearerToken(`Basic ${KEY}`)).toBeUndefined();
    expect(extractBearerToken(`Bearer ${KEY} extra`)).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});

describe("resolveMcpPrincipal", () => {
  it("returns a restricted principal with the loaded policy for a valid ssr1", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const resolution = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost:4205", authorization: `Bearer ${token}` },
      restrictedConfig(),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.principal).toEqual({ tier: "restricted", sessionId: SESSION_A });
    expect(resolution.policy).toEqual(loadedPolicy.policy);
    expect(resolution.policyDigest).toBe(loadedPolicy.digest);
  });

  it("refuses ssr1 when auth is disabled or restricted config is absent", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const disabled = await resolveMcpPrincipal(
      authConfig({ requireAuth: false }),
      { host: "localhost", authorization: `Bearer ${token}` },
      restrictedConfig(),
    );
    expect(disabled).toMatchObject({ ok: false, status: 401 });

    const absent = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token}` },
    );
    expect(absent).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses forged tokens, unknown sessions and missing server keys", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const forged = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token.slice(0, -1)}x` },
      restrictedConfig(),
    );
    expect(forged).toMatchObject({ ok: false, status: 401 });

    const missing = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token}` },
      restrictedConfig({ sessionExists: async () => false }),
    );
    expect(missing).toMatchObject({ ok: false, status: 401 });

    const unconfigured = await resolveMcpPrincipal(
      authConfig({ bearerToken: "" }),
      { host: "localhost", authorization: `Bearer ${token}` },
      restrictedConfig(),
    );
    expect(unconfigured).toMatchObject({ ok: false, status: 500 });
  });

  it("rejects forbidden Host for both tiers", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const restricted = await resolveMcpPrincipal(
      authConfig(),
      { host: "evil.example", authorization: `Bearer ${token}` },
      restrictedConfig(),
    );
    expect(restricted).toMatchObject({ ok: false, status: 403 });
    expect(restricted.ok ? "" : restricted.message).toContain("host not allowed");

    const full = await resolveMcpPrincipal(
      authConfig(),
      { host: "evil.example", authorization: `Bearer ${KEY}` },
    );
    expect(full).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed with 503 when session lookup or policy loading is unavailable", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const lookup = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token}` },
      restrictedConfig({ sessionExists: async () => { throw new Error("db down"); } }),
    );
    expect(lookup).toMatchObject({ ok: false, status: 503, message: "ISOLATION_AUTH_UNAVAILABLE" });

    const policy = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token}` },
      restrictedConfig({ policyProvider: { get: () => { throw new Error("bad policy"); } } }),
    );
    expect(policy).toMatchObject({ ok: false, status: 503 });
    expect(policy.ok ? "" : policy.message).toBe("ISOLATION_POLICY_UNAVAILABLE");
  });

  it("keeps full bearer semantics unchanged", async () => {
    const ok = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${KEY}` },
      restrictedConfig(),
    );
    expect(ok).toEqual({ ok: true, principal: { tier: "full" } });

    const wrong = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: "Bearer other" },
      restrictedConfig(),
    );
    expect(wrong).toMatchObject({ ok: false, status: 401 });

    const noAuth = await resolveMcpPrincipal(
      authConfig({ requireAuth: false }),
      { host: "localhost" },
      restrictedConfig(),
    );
    expect(noAuth).toEqual({ ok: true, principal: { tier: "full" } });
  });

  it("never echoes the token or the server key in rejection results", async () => {
    const token = createRestrictedMcpToken(SESSION_A, KEY);
    const results = await Promise.all([
      resolveMcpPrincipal(authConfig(), { host: "evil.example", authorization: `Bearer ${token}` }, restrictedConfig()),
      resolveMcpPrincipal(authConfig(), { host: "localhost", authorization: `Bearer ${token}` }, restrictedConfig({ sessionExists: async () => false })),
      resolveMcpPrincipal(authConfig(), { host: "localhost", authorization: `Bearer ${token}` }, restrictedConfig({ policyProvider: { get: () => { throw new Error(KEY); } } })),
    ]);
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(KEY);
    }
  });
});

describe("same-listener REST rejects ssr1", () => {
  it("returns 401 on /llm/completions for a restricted token", async () => {
    const harness = makeLlmHarness();
    const { LlmExecutor } = await import("../../src/llm/executor.js");
    const executor = new LlmExecutor({
      adapters: { openai: harness.adapter },
      taskManager: harness.taskManager,
      persistence: harness.persistence,
      broadcaster: harness.broadcaster,
      nodeId: "test-node",
      logger: silentLogger,
    });
    const server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: silentLogger,
      llm: { executor, authBearerToken: KEY, isProduction: false, logger: silentLogger },
    });
    try {
      const token = createRestrictedMcpToken(SESSION_A, KEY);
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ detail: { error: { code: "UNAUTHORIZED" } } });
    } finally {
      await server.close();
    }
  });
});

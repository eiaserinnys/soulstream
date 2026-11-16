/**
 * ssf1 full 세션 자격 증명 검증.
 *
 * ssr1과 같은 형식·HMAC·상수 시간 비교를 쓰되 접두사와 서명 컨텍스트가
 * 달라 서로 바꿔 쓸 수 없다. full 세션 토큰은 서비스 토큰과 같은 full 등급의
 * principal이 되고 토큰이 묶은 세션 ID를 채운다. 위조·변조는 401이다.
 */
import { describe, expect, it } from "vitest";

import {
  createFullSessionMcpToken,
  createRestrictedMcpToken,
  FULL_SESSION_MCP_TOKEN_PREFIX,
  isFullSessionMcpToken,
  isRestrictedMcpToken,
  RESTRICTED_MCP_TOKEN_PREFIX,
  verifyFullSessionMcpToken,
  verifyRestrictedMcpToken,
} from "../../src/security/restricted_mcp_auth.js";
import { resolveMcpPrincipal, type McpAuthConfig } from "../../src/mcp/auth.js";

const KEY = "test-bearer-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const HEX_SESSION = "abcdefab-cdef-4abc-8def-abcdefabcdef";

function authConfig(overrides: Partial<McpAuthConfig> = {}): McpAuthConfig {
  return {
    requireAuth: true,
    bearerToken: KEY,
    allowedHosts: ["localhost", "127.0.0.1"],
    ...overrides,
  };
}

describe("full session MCP token format", () => {
  it("issues ssf1.<session>.<base64url hmac> for canonical session ids", () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    expect(token.startsWith(FULL_SESSION_MCP_TOKEN_PREFIX)).toBe(true);
    expect(isFullSessionMcpToken(token)).toBe(true);
    expect(isRestrictedMcpToken(token)).toBe(false);
    const [prefix, sessionId, signature, ...rest] = token.split(".");
    expect(prefix).toBe("ssf1");
    expect(sessionId).toBe(SESSION_A);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rest).toEqual([]);
    expect(token.length).toBeLessThanOrEqual(256);
  });

  it("rejects non-canonical session ids and empty keys at issue time", () => {
    expect(() => createFullSessionMcpToken(HEX_SESSION.toUpperCase(), KEY)).toThrow();
    expect(() => createFullSessionMcpToken("not-a-uuid", KEY)).toThrow();
    expect(() => createFullSessionMcpToken(SESSION_A, "")).toThrow();
  });

  it("recomputes the HMAC in constant time and rejects forgery", () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    expect(verifyFullSessionMcpToken(token, KEY)).toEqual({ ok: true, sessionId: SESSION_A });

    expect(verifyFullSessionMcpToken(token, "another-key"))
      .toEqual({ ok: false, reason: "signature" });

    const [prefix, , signature] = token.split(".");
    const borrowed = `${prefix}.${SESSION_B}.${signature}`;
    expect(verifyFullSessionMcpToken(borrowed, KEY)).toEqual({ ok: false, reason: "signature" });

    expect(verifyFullSessionMcpToken(token, "")).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("rejects malformed, over-long and non-canonical tokens before hashing", () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    expect(verifyFullSessionMcpToken("ssf1.", KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken("bearer-token", KEY)).toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken(`ssf1.${SESSION_A}`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken(`ssf1.${SESSION_A}.short`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken(`ssf1.${SESSION_A}.${"a".repeat(43)}.extra`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken(`ssf1.${HEX_SESSION.toUpperCase()}.${"a".repeat(43)}`, KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(verifyFullSessionMcpToken(`ssf1.${SESSION_A}.${"a".repeat(43)}`.padEnd(300, "a"), KEY))
      .toEqual({ ok: false, reason: "format" });
    expect(isFullSessionMcpToken(token)).toBe(true);
  });

  it("keeps ssr1 and ssf1 apart in both directions", () => {
    const restricted = createRestrictedMcpToken(SESSION_A, KEY);
    const full = createFullSessionMcpToken(SESSION_A, KEY);

    expect(isRestrictedMcpToken(restricted)).toBe(true);
    expect(isFullSessionMcpToken(restricted)).toBe(false);
    expect(verifyFullSessionMcpToken(restricted, KEY)).toEqual({ ok: false, reason: "format" });

    expect(isFullSessionMcpToken(full)).toBe(true);
    expect(isRestrictedMcpToken(full)).toBe(false);
    expect(verifyRestrictedMcpToken(full, KEY)).toEqual({ ok: false, reason: "format" });

    // 같은 세션·같은 키라도 서명 컨텍스트가 달라 서명이 겹치지 않는다.
    expect(restricted.split(".")[2]).not.toBe(full.split(".")[2]);
    expect(RESTRICTED_MCP_TOKEN_PREFIX).not.toBe(FULL_SESSION_MCP_TOKEN_PREFIX);
  });
});

describe("resolveMcpPrincipal for full session credentials", () => {
  it("accepts a valid ssf1 as a full principal bound to its session", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const resolution = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost:3105", authorization: `Bearer ${token}` },
    );
    expect(resolution).toEqual({
      ok: true,
      principal: { tier: "full", sessionId: SESSION_A },
    });
    if (!resolution.ok) return;
    expect(resolution.policy).toBeUndefined();
    expect(resolution.policyDigest).toBeUndefined();
  });

  it("does not require the restricted DB lookup or policy for a full session token", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const sessionExists = async () => {
      throw new Error("must not be called");
    };
    const resolution = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${token}` },
      { policyProvider: { get: () => { throw new Error("must not be called"); } }, sessionExists },
    );
    expect(resolution).toEqual({
      ok: true,
      principal: { tier: "full", sessionId: SESSION_A },
    });
  });

  it("rejects tampered, wrong-key and cross-session ssf1 tokens with 401", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const tampered = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${flipped}` },
    );
    expect(tampered).toMatchObject({ ok: false, status: 401 });

    const otherKey = createFullSessionMcpToken(SESSION_A, "another-key");
    const wrongKey = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${otherKey}` },
    );
    expect(wrongKey).toMatchObject({ ok: false, status: 401 });

    const [prefix, , signature] = token.split(".");
    const borrowed = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${prefix}.${SESSION_B}.${signature}` },
    );
    expect(borrowed).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts ssf1 when auth is disabled, attaching the session only on a valid signature", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const disabled = await resolveMcpPrincipal(
      authConfig({ requireAuth: false }),
      { host: "localhost", authorization: `Bearer ${token}` },
    );
    expect(disabled).toEqual({
      ok: true,
      principal: { tier: "full", sessionId: SESSION_A },
    });

    // 키가 없어도 인증을 요구하지 않는 설정에서는 다른 값과 똑같이 통과한다.
    const unconfigured = await resolveMcpPrincipal(
      authConfig({ requireAuth: false, bearerToken: "" }),
      { host: "localhost", authorization: `Bearer ${token}` },
    );
    expect(unconfigured).toEqual({ ok: true, principal: { tier: "full" } });

    // 서명이 맞지 않으면 세션 ID만 붙이지 않고 full로 통과한다.
    const foreignKey = createFullSessionMcpToken(SESSION_A, "another-key");
    const unchecked = await resolveMcpPrincipal(
      authConfig({ requireAuth: false }),
      { host: "localhost", authorization: `Bearer ${foreignKey}` },
    );
    expect(unchecked).toEqual({ ok: true, principal: { tier: "full" } });
  });

  it("returns 500 for ssf1 when auth is required but the server key is missing", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const unconfigured = await resolveMcpPrincipal(
      authConfig({ bearerToken: "" }),
      { host: "localhost", authorization: `Bearer ${token}` },
    );
    expect(unconfigured).toMatchObject({ ok: false, status: 500 });
  });

  it("rejects a forbidden Host before looking at ssf1", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const resolution = await resolveMcpPrincipal(
      authConfig(),
      { host: "evil.example", authorization: `Bearer ${token}` },
    );
    expect(resolution).toMatchObject({ ok: false, status: 403 });
    expect(resolution.ok ? "" : resolution.message).toContain("host not allowed");
  });

  it("keeps the service token a full principal without a session id", async () => {
    const resolution = await resolveMcpPrincipal(
      authConfig(),
      { host: "localhost", authorization: `Bearer ${KEY}` },
    );
    expect(resolution).toEqual({ ok: true, principal: { tier: "full" } });
  });

  it("never echoes the token or the server key in rejection results", async () => {
    const token = createFullSessionMcpToken(SESSION_A, KEY);
    const results = await Promise.all([
      resolveMcpPrincipal(authConfig(), {
        host: "evil.example",
        authorization: `Bearer ${token}`,
      }),
      resolveMcpPrincipal(authConfig(), {
        host: "localhost",
        authorization: `Bearer ${token.slice(0, -1)}x`,
      }),
      resolveMcpPrincipal(authConfig({ bearerToken: "" }), {
        host: "localhost",
        authorization: `Bearer ${token}`,
      }),
    ]);
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(KEY);
    }
  });
});

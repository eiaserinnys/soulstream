import { describe, expect, it } from "vitest";

import { checkMcpAuth, extractHost } from "../../src/mcp/auth.js";

describe("extractHost", () => {
  it("hostname:port → hostname", () => {
    expect(extractHost("example.com:8080")).toBe("example.com");
  });
  it("hostname → hostname", () => {
    expect(extractHost("example.com")).toBe("example.com");
  });
  it("IPv6 [::1]:8080 → ::1", () => {
    expect(extractHost("[::1]:8080")).toBe("::1");
  });
  it("undefined → 빈 문자열", () => {
    expect(extractHost(undefined)).toBe("");
  });
});

describe("checkMcpAuth — allowedHosts", () => {
  it("allowedHosts가 비어 있으면 Host 제한을 사용하지 않는다", () => {
    const result = checkMcpAuth(
      { requireAuth: true, bearerToken: "secret", allowedHosts: [] },
      { host: "anything.example.com", authorization: "Bearer secret" },
    );
    expect(result.ok).toBe(true);
  });

  it("Host가 allowedHosts에 포함 → 통과", () => {
    const result = checkMcpAuth(
      { requireAuth: false, bearerToken: "", allowedHosts: ["localhost", "127.0.0.1"] },
      { host: "127.0.0.1:4205" },
    );
    expect(result.ok).toBe(true);
  });

  it("Host가 allowedHosts에 없음 → 403", () => {
    const result = checkMcpAuth(
      { requireAuth: false, bearerToken: "", allowedHosts: ["localhost"] },
      { host: "evil.example.com" },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe("checkMcpAuth — bearer", () => {
  it("requireAuth true + 올바른 토큰 → 통과", () => {
    const result = checkMcpAuth(
      { requireAuth: true, bearerToken: "secret", allowedHosts: [] },
      { authorization: "Bearer secret" },
    );
    expect(result.ok).toBe(true);
  });

  it("requireAuth true + 토큰 누락 → 401", () => {
    const result = checkMcpAuth(
      { requireAuth: true, bearerToken: "secret", allowedHosts: [] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("requireAuth true + 잘못된 토큰 → 401", () => {
    const result = checkMcpAuth(
      { requireAuth: true, bearerToken: "secret", allowedHosts: [] },
      { authorization: "Bearer wrong" },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("requireAuth true + bearerToken 설정 누락 → 500 (server misconfig)", () => {
    const result = checkMcpAuth(
      { requireAuth: true, bearerToken: "", allowedHosts: [] },
      { authorization: "Bearer anything" },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

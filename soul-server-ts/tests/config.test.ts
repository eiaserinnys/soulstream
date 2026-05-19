import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseEnv } from "../src/config.js";

describe("parseEnv", () => {
  const minimal = {
    SOULSTREAM_NODE_ID: "eias-shopping-ts",
    SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
    DATABASE_URL: "postgres://test:test@localhost:5432/soulstream_test",
  };

  it("필수 키만 있으면 default들이 채워진다", () => {
    const env = parseEnv(minimal);
    expect(env.SOULSTREAM_NODE_ID).toBe("eias-shopping-ts");
    expect(env.AUTH_BEARER_TOKEN).toBe("");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(4205);
    expect(env.ENVIRONMENT).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DASH_USER_NAME).toBe("");
    expect(env.DASH_USER_PORTRAIT).toBe("");
  });

  it("SOULSTREAM_NODE_ID 부재 시 ZodError", () => {
    expect(() =>
      parseEnv({ SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node" }),
    ).toThrow(ZodError);
  });

  it("SOULSTREAM_UPSTREAM_URL 부재 시 ZodError", () => {
    expect(() => parseEnv({ SOULSTREAM_NODE_ID: "x" })).toThrow(ZodError);
  });

  it("SOULSTREAM_UPSTREAM_URL이 ws:// 또는 wss://가 아니면 거부", () => {
    expect(() =>
      parseEnv({ ...minimal, SOULSTREAM_UPSTREAM_URL: "http://localhost:5200/ws/node" }),
    ).toThrow(ZodError);
  });

  it("wss://는 허용", () => {
    const env = parseEnv({ ...minimal, SOULSTREAM_UPSTREAM_URL: "wss://example.com/ws/node" });
    expect(env.SOULSTREAM_UPSTREAM_URL).toBe("wss://example.com/ws/node");
  });

  it("PORT 문자열 → 숫자 coerce", () => {
    const env = parseEnv({ ...minimal, PORT: "4205" });
    expect(env.PORT).toBe(4205);
  });

  it("production이면서 AUTH_BEARER_TOKEN 부재 → ZodError", () => {
    expect(() =>
      parseEnv({
        ...minimal,
        ENVIRONMENT: "production",
        AUTH_BEARER_TOKEN: "",
      }),
    ).toThrow(ZodError);
  });

  it("production + AUTH_BEARER_TOKEN 있음 → 통과", () => {
    const env = parseEnv({
      ...minimal,
      ENVIRONMENT: "production",
      AUTH_BEARER_TOKEN: "secret",
    });
    expect(env.AUTH_BEARER_TOKEN).toBe("secret");
    expect(env.ENVIRONMENT).toBe("production");
  });

  it("LOG_LEVEL이 enum 범위 외면 거부", () => {
    expect(() => parseEnv({ ...minimal, LOG_LEVEL: "verbose" })).toThrow(ZodError);
  });

  // Phase B-3 — DATABASE_URL + AGENTS_CONFIG_PATH
  it("DATABASE_URL 부재 시 ZodError", () => {
    const { DATABASE_URL: _, ...rest } = minimal;
    void _;
    expect(() => parseEnv(rest)).toThrow(ZodError);
  });

  it("DATABASE_URL이 postgres:// 또는 postgresql://가 아니면 거부", () => {
    expect(() =>
      parseEnv({ ...minimal, DATABASE_URL: "mysql://localhost/x" }),
    ).toThrow(ZodError);
  });

  it("postgresql:// 스킴 허용", () => {
    const env = parseEnv({
      ...minimal,
      DATABASE_URL: "postgresql://test:test@localhost/x",
    });
    expect(env.DATABASE_URL).toBe("postgresql://test:test@localhost/x");
  });

  it("AGENTS_CONFIG_PATH 미지정 시 default 'config/agents.yaml'", () => {
    const env = parseEnv(minimal);
    expect(env.AGENTS_CONFIG_PATH).toBe("config/agents.yaml");
  });

  it("AGENTS_CONFIG_PATH 절대 경로 override 허용", () => {
    const env = parseEnv({
      ...minimal,
      AGENTS_CONFIG_PATH: "/etc/soulstream/agents.yaml",
    });
    expect(env.AGENTS_CONFIG_PATH).toBe("/etc/soulstream/agents.yaml");
  });

  // MCP Streamable HTTP env (본 카드 신규)
  describe("MCP env", () => {
    it("MCP_ENABLED default false (string -> bool)", () => {
      const env = parseEnv(minimal);
      expect(env.MCP_ENABLED).toBe(false);
    });

    it('MCP_ENABLED "true" 문자열 → true', () => {
      const env = parseEnv({ ...minimal, MCP_ENABLED: "true" });
      expect(env.MCP_ENABLED).toBe(true);
    });

    it("MCP_PATH default '/mcp'", () => {
      const env = parseEnv(minimal);
      expect(env.MCP_PATH).toBe("/mcp");
    });

    it("MCP_REQUIRE_AUTH default false", () => {
      const env = parseEnv(minimal);
      expect(env.MCP_REQUIRE_AUTH).toBe(false);
    });

    it("MCP_ALLOWED_HOSTS default csv → string[] 변환", () => {
      const env = parseEnv(minimal);
      expect(env.MCP_ALLOWED_HOSTS).toEqual(["localhost", "127.0.0.1"]);
    });

    it("MCP_ALLOWED_HOSTS override csv → trim + filter empty", () => {
      const env = parseEnv({
        ...minimal,
        MCP_ALLOWED_HOSTS: "a.example.com, b.example.com, ,c.example.com",
      });
      expect(env.MCP_ALLOWED_HOSTS).toEqual([
        "a.example.com",
        "b.example.com",
        "c.example.com",
      ]);
    });

    it("production + MCP_ENABLED + MCP_REQUIRE_AUTH 누락 → ZodError (P1-2 분기 2)", () => {
      expect(() =>
        parseEnv({
          ...minimal,
          ENVIRONMENT: "production",
          AUTH_BEARER_TOKEN: "secret",
          MCP_ENABLED: "true",
          MCP_REQUIRE_AUTH: "false",
        }),
      ).toThrow(ZodError);
    });

    it("production + MCP_ENABLED + MCP_REQUIRE_AUTH true → 통과", () => {
      const env = parseEnv({
        ...minimal,
        ENVIRONMENT: "production",
        AUTH_BEARER_TOKEN: "secret",
        MCP_ENABLED: "true",
        MCP_REQUIRE_AUTH: "true",
      });
      expect(env.MCP_ENABLED).toBe(true);
      expect(env.MCP_REQUIRE_AUTH).toBe(true);
    });

    it("비-loopback HOST + MCP_ENABLED + REQUIRE_AUTH 없음 + ALLOWED_HOSTS 비어있음 → ZodError (P1-2 분기 3)", () => {
      expect(() =>
        parseEnv({
          ...minimal,
          HOST: "0.0.0.0",
          MCP_ENABLED: "true",
          MCP_REQUIRE_AUTH: "false",
          MCP_ALLOWED_HOSTS: "",
        }),
      ).toThrow(ZodError);
    });

    it("비-loopback HOST + MCP_ENABLED + ALLOWED_HOSTS 명시 → 통과", () => {
      const env = parseEnv({
        ...minimal,
        HOST: "0.0.0.0",
        MCP_ENABLED: "true",
        MCP_ALLOWED_HOSTS: "example.com",
      });
      expect(env.MCP_ALLOWED_HOSTS).toEqual(["example.com"]);
    });

    it("loopback HOST 기본 + MCP_ENABLED → 통과 (REQUIRE_AUTH 미강제, development)", () => {
      const env = parseEnv({ ...minimal, MCP_ENABLED: "true" });
      expect(env.MCP_ENABLED).toBe(true);
      expect(env.HOST).toBe("127.0.0.1");
    });
  });
});

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseEnv } from "../src/config.js";

describe("parseEnv", () => {
  const minimal = {
    SOULSTREAM_NODE_ID: "eias-shopping-ts",
    BOARD_YJS_HOST_NODE_ID: "eias-shopping-ts",
    SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
    DATABASE_URL: "postgres://test:test@localhost:5432/soulstream_test",
  };

  it("필수 키만 있으면 default들이 채워진다", () => {
    const env = parseEnv(minimal);
    expect(env.SOULSTREAM_NODE_ID).toBe("eias-shopping-ts");
    expect(env.BOARD_YJS_HOST_NODE_ID).toBe("eias-shopping-ts");
    expect(env.AUTH_BEARER_TOKEN).toBe("");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(4205);
    expect(env.ENVIRONMENT).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DASH_USER_NAME).toBe("");
    expect(env.DASH_USER_PORTRAIT).toBe("");
    expect(env.LLM_OPENAI_API_KEY).toBeUndefined();
    expect(env.LLM_ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_CLI_PATH).toBeUndefined();
    expect(env.CODEX_ADAPTER_MODE).toBe("sdk");
    expect(env.MCP_TOOL_PROFILE).toBe("default");
    expect(env.SUPERVISOR_ENABLED).toBe(false);
    expect(env.SUPERVISOR_EVENT_INGEST_ENABLED).toBe(false);
    expect(env.SUPERVISOR_ROLES).toEqual([]);
    expect(env.SUPERVISOR_WAKE_DEBOUNCE_MS).toBe(250);
    expect(env.SUPERVISOR_WAKE_BATCH_LIMIT).toBe(100);
    expect(env.SUPERVISOR_SOFT_TOKEN_THRESHOLD).toBe(1_000_000);
    expect(env.SUPERVISOR_HARD_TOKEN_THRESHOLD).toBe(1_500_000);
    expect(env.SUPERVISOR_HANDOVER_MIN_INTERVAL_MS).toBe(600_000);
    expect(env.SUPERVISOR_HANDOVER_DRAIN_LIMIT).toBe(100);
    expect(env.SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT).toBe(20);
    expect(env.SUPERVISOR_WATCHDOG_INTERVAL_MS).toBe(60_000);
    expect(env.SUPERVISOR_WATCHDOG_MISSING_THRESHOLD_MS).toBe(300_000);
  });

  it("SOULSTREAM_NODE_ID 부재 시 ZodError", () => {
    expect(() =>
      parseEnv({
        BOARD_YJS_HOST_NODE_ID: "x",
        SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
      }),
    ).toThrow(ZodError);
  });

  it("BOARD_YJS_HOST_NODE_ID 부재 시 ZodError", () => {
    const { BOARD_YJS_HOST_NODE_ID: _, ...rest } = minimal;
    void _;
    expect(() => parseEnv(rest)).toThrow(ZodError);
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

  it("LLM provider API key는 optional이며 명시 값만 보존한다", () => {
    const env = parseEnv({
      ...minimal,
      LLM_OPENAI_API_KEY: "openai-key",
      LLM_ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(env.LLM_OPENAI_API_KEY).toBe("openai-key");
    expect(env.LLM_ANTHROPIC_API_KEY).toBe("anthropic-key");
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

  it("CLAUDE_AUTH_TOKEN_PATH는 default 없이 명시된 값만 정본으로 사용", () => {
    expect(parseEnv(minimal).CLAUDE_AUTH_TOKEN_PATH).toBeUndefined();
    const env = parseEnv({
      ...minimal,
      CLAUDE_AUTH_TOKEN_PATH: "/var/lib/soulstream-ts/claude-auth.json",
    });
    expect(env.CLAUDE_AUTH_TOKEN_PATH).toBe("/var/lib/soulstream-ts/claude-auth.json");
  });

  it("CODEX_ADAPTER_MODE는 sdk가 기본이고 app-server만 opt-in 허용", () => {
    expect(parseEnv(minimal).CODEX_ADAPTER_MODE).toBe("sdk");
    expect(parseEnv({ ...minimal, CODEX_ADAPTER_MODE: "app-server" }).CODEX_ADAPTER_MODE).toBe(
      "app-server",
    );
    expect(() =>
      parseEnv({ ...minimal, CODEX_ADAPTER_MODE: "appserver" }),
    ).toThrow(ZodError);
  });

  it("CODEX_CLI_PATH는 default 없이 명시된 값만 사용한다", () => {
    expect(parseEnv(minimal).CODEX_CLI_PATH).toBeUndefined();
    const env = parseEnv({
      ...minimal,
      CODEX_CLI_PATH: "/home/eias/.npm-global/bin/codex",
    });
    expect(env.CODEX_CLI_PATH).toBe("/home/eias/.npm-global/bin/codex");
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

    it("MCP_TOOL_PROFILE은 default 또는 supervisor_readonly만 허용", () => {
      expect(parseEnv(minimal).MCP_TOOL_PROFILE).toBe("default");
      expect(
        parseEnv({ ...minimal, MCP_TOOL_PROFILE: "supervisor_readonly" }).MCP_TOOL_PROFILE,
      ).toBe("supervisor_readonly");
      expect(() =>
        parseEnv({ ...minimal, MCP_TOOL_PROFILE: "readonly" }),
      ).toThrow(ZodError);
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

  describe("Supervisor activation env", () => {
    it('SUPERVISOR_ENABLED "true" requires at least one role', () => {
      expect(() =>
        parseEnv({
          ...minimal,
          SUPERVISOR_ENABLED: "true",
        }),
      ).toThrow(ZodError);
    });

    it("parses supervisor roles, folder, and tuning values", () => {
      const env = parseEnv({
        ...minimal,
        SUPERVISOR_ENABLED: "true",
        SUPERVISOR_EVENT_INGEST_ENABLED: "true",
        SUPERVISOR_ROLES: "ariella-ashwood-codex, backup-supervisor",
        SUPERVISOR_FOLDER_ID: "fa1a7018-6262-4452-b1e3-1f7e9c61d7d0",
        SUPERVISOR_WAKE_DEBOUNCE_MS: "500",
        SUPERVISOR_WAKE_BATCH_LIMIT: "50",
        SUPERVISOR_SOFT_TOKEN_THRESHOLD: "900000",
        SUPERVISOR_HARD_TOKEN_THRESHOLD: "1200000",
        SUPERVISOR_HANDOVER_MIN_INTERVAL_MS: "300000",
        SUPERVISOR_HANDOVER_DRAIN_LIMIT: "75",
        SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT: "15",
        SUPERVISOR_WATCHDOG_INTERVAL_MS: "45000",
        SUPERVISOR_WATCHDOG_MISSING_THRESHOLD_MS: "180000",
      });

      expect(env.SUPERVISOR_ENABLED).toBe(true);
      expect(env.SUPERVISOR_EVENT_INGEST_ENABLED).toBe(true);
      expect(env.SUPERVISOR_ROLES).toEqual([
        "ariella-ashwood-codex",
        "backup-supervisor",
      ]);
      expect(env.SUPERVISOR_FOLDER_ID).toBe(
        "fa1a7018-6262-4452-b1e3-1f7e9c61d7d0",
      );
      expect(env.SUPERVISOR_WAKE_DEBOUNCE_MS).toBe(500);
      expect(env.SUPERVISOR_WAKE_BATCH_LIMIT).toBe(50);
      expect(env.SUPERVISOR_SOFT_TOKEN_THRESHOLD).toBe(900_000);
      expect(env.SUPERVISOR_HARD_TOKEN_THRESHOLD).toBe(1_200_000);
      expect(env.SUPERVISOR_HANDOVER_MIN_INTERVAL_MS).toBe(300_000);
      expect(env.SUPERVISOR_HANDOVER_DRAIN_LIMIT).toBe(75);
      expect(env.SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT).toBe(15);
      expect(env.SUPERVISOR_WATCHDOG_INTERVAL_MS).toBe(45_000);
      expect(env.SUPERVISOR_WATCHDOG_MISSING_THRESHOLD_MS).toBe(180_000);
    });

    it("rejects hard threshold below soft threshold", () => {
      expect(() =>
        parseEnv({
          ...minimal,
          SUPERVISOR_ENABLED: "true",
          SUPERVISOR_ROLES: "ariella-ashwood-codex",
          SUPERVISOR_SOFT_TOKEN_THRESHOLD: "100",
          SUPERVISOR_HARD_TOKEN_THRESHOLD: "99",
        }),
      ).toThrow(ZodError);
    });

    it("allows supervisor event ingest without supervisor activation", () => {
      const env = parseEnv({
        ...minimal,
        SUPERVISOR_EVENT_INGEST_ENABLED: "true",
      });

      expect(env.SUPERVISOR_ENABLED).toBe(false);
      expect(env.SUPERVISOR_EVENT_INGEST_ENABLED).toBe(true);
      expect(env.SUPERVISOR_ROLES).toEqual([]);
    });
  });
});

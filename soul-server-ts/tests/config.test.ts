import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseEnv } from "../src/config.js";

describe("parseEnv", () => {
  const minimal = {
    SOULSTREAM_NODE_ID: "eias-shopping-ts",
    SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
    EVENT_OUTBOX_DIR: "/tmp/soulstream-event-outbox-test",
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
    expect(env.LLM_OPENAI_API_KEY).toBeUndefined();
    expect(env.LLM_ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_CLI_PATH).toBeUndefined();
    expect(env.CODEX_ADAPTER_MODE).toBe("sdk");
    expect(env.EVENT_OUTBOX_DIR).toBe("/tmp/soulstream-event-outbox-test");
    expect(env.CLAUDE_SESSION_RUNTIME_V2_ENABLED).toBe(true);
    expect(env.SOUL_RUNNER_PROCESS_ENABLED).toBe(false);
  });

  it("SOULSTREAM_NODE_ID 부재 시 ZodError", () => {
    expect(() =>
      parseEnv({
        SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
      }),
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

  it("LLM provider API key는 optional이며 명시 값만 보존한다", () => {
    const env = parseEnv({
      ...minimal,
      LLM_OPENAI_API_KEY: "openai-key",
      LLM_ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(env.LLM_OPENAI_API_KEY).toBe("openai-key");
    expect(env.LLM_ANTHROPIC_API_KEY).toBe("anthropic-key");
  });

  it("워커 설정은 DATABASE_URL 없이 성립한다", () => {
    expect(parseEnv(minimal)).not.toHaveProperty("DATABASE_URL");
  });

  it("EVENT_OUTBOX_DIR는 fallback 없이 필수다", () => {
    const { EVENT_OUTBOX_DIR: _, ...rest } = minimal;
    void _;
    expect(() => parseEnv(rest)).toThrow(ZodError);
  });

  it("session runner process는 default off이며 opt-in state·release pool을 함께 요구한다", () => {
    expect(parseEnv(minimal).SOUL_RUNNER_PROCESS_ENABLED).toBe(false);
    expect(parseEnv(minimal).SOUL_RUNNER_LEASE_TIMEOUT_MS).toBe(1_800_000);
    expect(parseEnv(minimal).SOUL_RUNNER_REAPER_INTERVAL_MS).toBe(15_000);
    expect(() => parseEnv({
      ...minimal,
      SOUL_RUNNER_PROCESS_ENABLED: "true",
    })).toThrow(ZodError);
    expect(parseEnv({
      ...minimal,
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_STATE_DIR: "/var/lib/soulstream/runners",
      SOUL_RUNNER_ARTIFACT_DIR: "/srv/soulstream/soul-server-ts/dist/runner",
      SOUL_RUNNER_RELEASES_DIR: "/var/lib/soulstream/runner-releases",
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
      SOUL_RUNNER_REAPER_INTERVAL_MS: "10000",
    })).toMatchObject({
      SOUL_RUNNER_PROCESS_ENABLED: true,
      SOUL_RUNNER_STATE_DIR: "/var/lib/soulstream/runners",
      SOUL_RUNNER_ARTIFACT_DIR: "/srv/soulstream/soul-server-ts/dist/runner",
      SOUL_RUNNER_RELEASES_DIR: "/var/lib/soulstream/runner-releases",
      SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
      SOUL_RUNNER_REAPER_INTERVAL_MS: 10_000,
    });
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

  it("MODEL_CATALOG_PATH는 config 기본 경로와 명시 override를 사용한다", () => {
    expect(parseEnv(minimal).MODEL_CATALOG_PATH).toBe("config/model-catalog.yaml");
    expect(parseEnv({
      ...minimal,
      MODEL_CATALOG_PATH: "/etc/soulstream/model-catalog.yaml",
    }).MODEL_CATALOG_PATH).toBe("/etc/soulstream/model-catalog.yaml");
  });

  it("CLAUDE_AUTH_TOKEN_PATH는 default 없이 명시된 값만 정본으로 사용", () => {
    expect(parseEnv(minimal).CLAUDE_AUTH_TOKEN_PATH).toBeUndefined();
    const env = parseEnv({
      ...minimal,
      CLAUDE_AUTH_TOKEN_PATH: "/var/lib/soulstream-ts/claude-auth.json",
    });
    expect(env.CLAUDE_AUTH_TOKEN_PATH).toBe("/var/lib/soulstream-ts/claude-auth.json");
  });

  it("Claude session runtime v2는 미설정 시 기본 ON이고 명시 false가 kill-switch다", () => {
    const defaults = parseEnv(minimal);
    expect(defaults.CLAUDE_SESSION_RUNTIME_V2_ENABLED).toBe(true);
    expect(defaults.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS).toBe(300_000);
    expect(defaults.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES).toBe(16);
    expect(defaults.CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS).toBe(1_800_000);
    expect(
      parseEnv({
        ...minimal,
        CLAUDE_SESSION_RUNTIME_V2_ENABLED: "false",
        CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: "60000",
        CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: "8",
        CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: "120000",
      }).CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    ).toBe(false);
    expect(parseEnv({
      ...minimal,
      CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: "60000",
      CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: "8",
      CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: "120000",
    })).toMatchObject({
      CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 60_000,
      CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 8,
      CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 120_000,
    });
    expect(() =>
      parseEnv({
        ...minimal,
        CLAUDE_SESSION_RUNTIME_V2_ENABLED: "1",
      }),
    ).toThrow(ZodError);
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

    it("MCP_STATELESS_TRANSPORT_ENABLED defaults off and requires explicit opt-in", () => {
      expect(parseEnv(minimal).MCP_STATELESS_TRANSPORT_ENABLED).toBe(false);
      expect(parseEnv({
        ...minimal,
        MCP_ENABLED: "true",
        MCP_STATELESS_TRANSPORT_ENABLED: "true",
      }).MCP_STATELESS_TRANSPORT_ENABLED).toBe(true);
    });

    it("rejects stateless transport when the MCP route itself is disabled", () => {
      expect(() => parseEnv({
        ...minimal,
        MCP_STATELESS_TRANSPORT_ENABLED: "true",
      })).toThrow(/MCP_ENABLED/);
    });

    it("requires stateless MCP before runner process cutover when MCP is enabled", () => {
      expect(() => parseEnv({
        ...minimal,
        MCP_ENABLED: "true",
        SOUL_RUNNER_PROCESS_ENABLED: "true",
        SOUL_RUNNER_STATE_DIR: "/tmp/runners",
        SOUL_RUNNER_ARTIFACT_DIR: "/tmp/artifacts",
        SOUL_RUNNER_RELEASES_DIR: "/tmp/releases",
      })).toThrow(/MCP_STATELESS_TRANSPORT_ENABLED/);
      expect(parseEnv({
        ...minimal,
        MCP_ENABLED: "true",
        MCP_STATELESS_TRANSPORT_ENABLED: "true",
        SOUL_RUNNER_PROCESS_ENABLED: "true",
        SOUL_RUNNER_STATE_DIR: "/tmp/runners",
        SOUL_RUNNER_ARTIFACT_DIR: "/tmp/artifacts",
        SOUL_RUNNER_RELEASES_DIR: "/tmp/releases",
      })).toMatchObject({
        MCP_ENABLED: true,
        MCP_STATELESS_TRANSPORT_ENABLED: true,
        SOUL_RUNNER_PROCESS_ENABLED: true,
      });
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

import { describe, expect, it } from "vitest";

import { ISOLATION_POLICY_UNAVAILABLE } from "../../src/runner/session_filesystem_errors.js";
import {
  RESTRICTED_ENV_REMOVED_KEYS,
  buildRestrictedSessionEnv,
} from "../../src/runner/session_env.js";

const FULL_SECRET = "host-full-bearer-value";

function baseEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/eias",
    LANG: "ko_KR.UTF-8",
    LC_ALL: "ko_KR.UTF-8",
    TZ: "Asia/Seoul",
    SCRATCH_WORKSPACE_DIR: "/home/eias/workspace/.local",
    MCP_INTERNAL_PORT: "3115",
    MCP_PATH: "/mcp/internal",
    AUTH_BEARER_TOKEN: FULL_SECRET,
    DATABASE_URL: "postgres://prod@127.0.0.1/soulstream",
    TEST_DATABASE_URL: "postgres://tester@127.0.0.1/soulstream_test",
    SSH_AUTH_SOCK: "/run/user/1000/ssh.sock",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    DOCKER_HOST: "unix:///run/docker.sock",
    PM2_HOME: "/home/eias/.pm2",
    RUSTC_WRAPPER: "/usr/local/bin/sccache",
    RUSTC_WORKSPACE_WRAPPER: "/usr/local/bin/sccache",
    SCCACHE_DIR: "/home/eias/.cache/sccache",
    WSL_INTEROP: "/run/WSL/8_interop",
    ATOM_API_KEY: "atom-key",
    KIMI_API_KEY: "kimi-key",
    SERENDIPITY_API_KEY: "serendipity-key",
    CLAUDE_CODE_MESSAGING_TOKEN: "messaging-token",
    CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1",
    XDG_CACHE_HOME: "/home/eias/.cache",
    npm_config_cache: "/home/eias/.npm",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Soulstream",
    ANTHROPIC_BASE_URL: "https://api.example.test",
    OPENAI_API_KEY: "openai-key",
  };
}

function build(
  overrides: Partial<Parameters<typeof buildRestrictedSessionEnv>[0]> = {},
): Record<string, string> {
  return buildRestrictedSessionEnv({
    baseEnv: baseEnv(),
    additions: {},
    restrictedCredential: "ssr1.s1.signature",
    fullSecrets: [FULL_SECRET],
    wsl: false,
    ...overrides,
  });
}

describe("buildRestrictedSessionEnv", () => {
  it("keeps only the allowed host keys and the allowed session values", () => {
    const env = build({
      additions: {
        TEST_DATABASE_URL: "postgres://tester@127.0.0.1:15432/soulstream_test",
        GH_TOKEN: "gh-token",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/eias");
    expect(env.LC_ALL).toBe("ko_KR.UTF-8");
    expect(env.TZ).toBe("Asia/Seoul");
    expect(env.SCRATCH_WORKSPACE_DIR).toBe("/home/eias/workspace/.local");
    expect(env.XDG_CACHE_HOME).toBe("/home/eias/.cache");
    expect(env.npm_config_cache).toBe("/home/eias/.npm");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.example.test");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe("1");
    expect(env.AUTH_BEARER_TOKEN).toBe("ssr1.s1.signature");
    expect(env.TEST_DATABASE_URL).toBe(
      "postgres://tester@127.0.0.1:15432/soulstream_test",
    );
    expect(env.GH_TOKEN).toBe("gh-token");

    // 호스트 서비스 설정과 임의 API 키는 상자 안 base로 넘어가지 않는다.
    for (const key of [
      "MCP_INTERNAL_PORT",
      "MCP_PATH",
      "ATOM_API_KEY",
      "KIMI_API_KEY",
      "SERENDIPITY_API_KEY",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "WSL_INTEROP",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    for (const key of RESTRICTED_ENV_REMOVED_KEYS) {
      if (key === "AUTH_BEARER_TOKEN" || key === "TEST_DATABASE_URL") continue;
      expect(env).not.toHaveProperty(key);
    }
    expect(env).not.toHaveProperty("SCCACHE_DIR");
  });

  it("admits a session-specific key referenced by its model preset", () => {
    const env = build({ sessionKeys: ["KIMI_API_KEY"] });

    // 그 세션의 preset이 ${KIMI_API_KEY}를 참조할 때만 넘어간다.
    expect(env.KIMI_API_KEY).toBe("kimi-key");
    expect(env).not.toHaveProperty("ATOM_API_KEY");
    expect(build()).not.toHaveProperty("KIMI_API_KEY");
  });

  it("removes forbidden keys introduced by additions and keeps the approved test DB and isolated sccache directory", () => {
    const env = build({
      additions: {
        SSH_AUTH_SOCK: "/run/user/1000/ssh.sock",
        DATABASE_URL: "postgres://prod@127.0.0.1/soulstream",
        DOCKER_HOST: "unix:///run/docker.sock",
        SCCACHE_DIR: "/home/eias/.local/share/soulstream/isolated-cache/sccache",
        SCCACHE_CACHE_SIZE: "10G",
        TEST_DATABASE_URL: "postgres://tester@127.0.0.1:15432/soulstream_test",
      },
    });

    for (const key of [
      "SSH_AUTH_SOCK",
      "DATABASE_URL",
      "DOCKER_HOST",
      "SCCACHE_CACHE_SIZE",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    // additions가 준 격리 캐시 SCCACHE_DIR 하나만 남는다(base의 값이 아니다).
    expect(env.SCCACHE_DIR).toBe(
      "/home/eias/.local/share/soulstream/isolated-cache/sccache",
    );
    expect(env.TEST_DATABASE_URL).toBe(
      "postgres://tester@127.0.0.1:15432/soulstream_test",
    );

    // additions가 승인 시험 DB를 주지 않으면 base의 값도 남지 않는다.
    const withoutApproval = build({ additions: { SSH_AUTH_SOCK: "/tmp/ssh.sock" } });
    expect(withoutApproval).not.toHaveProperty("TEST_DATABASE_URL");
    expect(withoutApproval).not.toHaveProperty("SCCACHE_DIR");
  });

  it("does not carry WSL_INTEROP even inside WSL", () => {
    expect(build({ wsl: true })).not.toHaveProperty("WSL_INTEROP");
  });

  it("rejects a full host secret duplicated under another key without printing it", () => {
    let thrown: unknown;
    try {
      build({
        baseEnv: { ...baseEnv(), OPENAI_API_KEY: FULL_SECRET },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: ISOLATION_POLICY_UNAVAILABLE });
    expect(String((thrown as Error).message)).not.toContain(FULL_SECRET);
  });

  it("rejects a restricted credential that equals a host secret", () => {
    expect(() => build({ restrictedCredential: FULL_SECRET })).toThrowError(
      expect.objectContaining({ code: ISOLATION_POLICY_UNAVAILABLE }),
    );
  });

  it("merges the restricted git configuration after existing entries", () => {
    const env = build({
      baseEnv: {
        ...baseEnv(),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Soulstream",
      },
    });

    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Soulstream");
    expect(env.GIT_CONFIG_KEY_1).toBe("gc.auto");
    expect(env.GIT_CONFIG_VALUE_1).toBe("0");
    expect(env.GIT_CONFIG_KEY_2).toBe("maintenance.auto");
    expect(env.GIT_CONFIG_VALUE_2).toBe("false");
    expect(env.GIT_CONFIG_KEY_3).toBe("fetch.writeCommitGraph");
    expect(env.GIT_CONFIG_VALUE_3).toBe("false");
  });

  it("keeps the approved local MCP address and key that the plan added", () => {
    const env = build({
      additions: {
        ATOM_SERVER_URL: "http://127.0.0.1:4200",
        ATOM_API_KEY: "atom-session-key",
      },
    });

    // 승인된 로컬 MCP에서 온 값은 제거 목록에 걸리지 않고 상자 env에 남는다.
    expect(env.ATOM_SERVER_URL).toBe("http://127.0.0.1:4200");
    expect(env.ATOM_API_KEY).toBe("atom-session-key");
  });

  it("does not mutate the caller environment", () => {
    const base = baseEnv();
    buildRestrictedSessionEnv({
      baseEnv: base,
      additions: {},
      restrictedCredential: "ssr1.s1.signature",
      fullSecrets: [],
      wsl: false,
    });
    expect(base.AUTH_BEARER_TOKEN).toBe(FULL_SECRET);
  });
});

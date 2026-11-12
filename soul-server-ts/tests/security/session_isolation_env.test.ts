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
  it("removes host management credentials and keeps the allowed session values", () => {
    const env = build({
      additions: {
        TEST_DATABASE_URL: "postgres://tester@127.0.0.1:15432/soulstream_test",
        GH_TOKEN: "gh-token",
      },
    });

    expect(env.PATH).toBe("/home/eias/.cargo/bin:/usr/bin:/bin");
    expect(env.SCRATCH_WORKSPACE_DIR).toBe("/home/eias/workspace/.local");
    expect(env.MCP_INTERNAL_PORT).toBe("3115");
    expect(env.MCP_PATH).toBe("/mcp/internal");
    expect(env.AUTH_BEARER_TOKEN).toBe("ssr1.s1.signature");
    expect(env.TEST_DATABASE_URL).toBe(
      "postgres://tester@127.0.0.1:15432/soulstream_test",
    );
    expect(env.GH_TOKEN).toBe("gh-token");

    for (const key of RESTRICTED_ENV_REMOVED_KEYS) {
      if (key === "AUTH_BEARER_TOKEN" || key === "TEST_DATABASE_URL") continue;
      expect(env).not.toHaveProperty(key);
    }
    expect(env).not.toHaveProperty("SCCACHE_DIR");
    expect(env.WSL_INTEROP).toBe("/run/WSL/8_interop");
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

  it("removes WSL_INTEROP only inside WSL", () => {
    expect(build({ wsl: true })).not.toHaveProperty("WSL_INTEROP");
  });

  it("rejects a full host secret duplicated under another key without printing it", () => {
    let thrown: unknown;
    try {
      build({
        baseEnv: { ...baseEnv(), UNRELATED_TOKEN: FULL_SECRET },
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

  it("prepends HOME/.cargo/bin to PATH", () => {
    const env = build();

    expect(env.PATH).toBe("/home/eias/.cargo/bin:/usr/bin:/bin");
  });

  it("does not duplicate HOME/.cargo/bin when a second pass sees it already on PATH", () => {
    const first = build({
      baseEnv: { ...baseEnv(), PATH: "/home/eias/.cargo/bin:/usr/bin:/bin" },
    });
    expect(first.PATH).toBe("/home/eias/.cargo/bin:/usr/bin:/bin");

    // 같은 함수는 서버, 상자 안 runner, Codex 전송에서 여러 번 거친다.
    const second = buildRestrictedSessionEnv({
      baseEnv: first,
      additions: {},
      restrictedCredential: "ssr1.s1.signature",
      fullSecrets: [],
      wsl: false,
    });
    expect(second.PATH).toBe("/home/eias/.cargo/bin:/usr/bin:/bin");
  });

  it("leaves PATH unchanged when HOME is missing", () => {
    const base = baseEnv();
    delete base.HOME;

    expect(build({ baseEnv: base }).PATH).toBe("/usr/bin:/bin");
  });

  it("does not create PATH when PATH is missing", () => {
    const base = baseEnv();
    delete base.PATH;

    expect(build({ baseEnv: base })).not.toHaveProperty("PATH");
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

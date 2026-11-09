import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { parseEnv } from "../../src/config.js";
import { ISOLATION_AUTH_UNAVAILABLE } from "../../src/runner/session_filesystem_errors.js";
import type { IsolationPolicy } from "../../src/security/session_isolation_contract.js";
import {
  applyNodeIsolationPolicy,
  classifyIsolatedAuth,
  createSessionIsolationPolicySource,
  createSessionIsolationRuntime,
  parseIsolationLocalMcpList,
  parseIsolationTestDatabasePair,
  sessionIsolationSettingsFromEnv,
  ISOLATION_TOOL_PATHS,
} from "../../src/security/session_isolation_runtime.js";
import {
  computeIsolationPolicyDigest,
  parseIsolationPolicy,
} from "../../src/security/session_isolation_policy.js";

const BASE_POLICY: IsolationPolicy = parseIsolationPolicy({
  version: 1,
  tools: { add_card_note: { category: "allow" } },
  localMcp: { requiredServerId: "soulstream", optional: [] },
  filesystem: {
    sessionWorktreeRelativeRoot: ".projects/.isolated",
    credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
    isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
    writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
    additionalSensitiveRoots: [],
  },
  testDatabases: [],
  network: {
    mode: "pasta-nft",
    dnsForward4: "192.0.2.53",
    deniedIpv4: [],
    deniedIpv6: [],
  },
});

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    SOULSTREAM_NODE_ID: "node-a",
    SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:9300",
    EVENT_OUTBOX_DIR: ".local/outbox",
    ...overrides,
  };
}

describe("session isolation settings", () => {
  it("defaults to off without requiring any path", () => {
    const settings = sessionIsolationSettingsFromEnv({});
    expect(settings.mode).toBe("off");
    expect(settings.pastaPath).toBeNull();
    expect(settings.localMcp).toEqual([]);
    expect(settings.testDatabase).toBeNull();
    expect(settings.testDatabaseUrl).toBeNull();
  });

  it("requires an absolute pasta path when enforced on linux", () => {
    expect(() => sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_MODE: "enforce",
    }, "linux")).toThrow(/SESSION_ISOLATION_PASTA_PATH/);
    expect(() => sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_MODE: "enforce",
      SESSION_ISOLATION_PASTA_PATH: "usr/bin/pasta",
    }, "linux")).toThrow(/absolute path/);
    expect(sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_MODE: "enforce",
      SESSION_ISOLATION_PASTA_PATH: "/usr/bin/pasta",
    }, "linux").pastaPath).toBe("/usr/bin/pasta");
  });

  it("ignores the switch on windows", () => {
    const settings = sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_MODE: "enforce",
    }, "win32");
    expect(settings.mode).toBe("enforce");
    expect(settings.pastaPath).toBeNull();
  });

  it("rejects an unknown mode", () => {
    expect(() => sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_MODE: "on",
    })).toThrow(/off or enforce/);
  });

  it("parses the comma separated local MCP list", () => {
    expect(parseIsolationLocalMcpList("alpha:4100, beta:4200")).toEqual([
      { serverId: "alpha", port: 4100 },
      { serverId: "beta", port: 4200 },
    ]);
    expect(parseIsolationLocalMcpList(undefined)).toEqual([]);
    expect(() => parseIsolationLocalMcpList("alpha")).toThrow(/serverId:port/);
    expect(() => parseIsolationLocalMcpList("alpha:0")).toThrow(/port/);
    expect(() => parseIsolationLocalMcpList(":4100")).toThrow(/serverId:port/);
  });

  it("parses the test database port pair", () => {
    expect(parseIsolationTestDatabasePair("5432:15432")).toEqual({
      hostPort: 5432,
      sandboxPort: 15432,
    });
    expect(parseIsolationTestDatabasePair(undefined)).toBeNull();
    expect(() => parseIsolationTestDatabasePair("5432")).toThrow(/hostPort:sandboxPort/);
    expect(() => parseIsolationTestDatabasePair("5432:70000")).toThrow(/1\.\.65535/);
  });

  it("requires both members of every configured pair", () => {
    expect(() => sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_TEST_DATABASE: "5432:15432",
    })).toThrow(/must be set together/);
    expect(() => sessionIsolationSettingsFromEnv({
      SESSION_ISOLATION_TEST_DATABASE_URL: "postgres://test",
    })).toThrow(/must be set together/);
    expect(() => sessionIsolationSettingsFromEnv({
      ISOLATED_CLAUDE_TOKEN_FILE: "/tmp/token",
    })).toThrow(/must be set together/);
    expect(sessionIsolationSettingsFromEnv({
      ISOLATED_CLAUDE_TOKEN_FILE: "/tmp/token",
      ISOLATED_CLAUDE_ACCOUNT_ID: "account-1",
    }).claudeAccountId).toBe("account-1");
  });
});

describe("config parsing", () => {
  it("keeps the isolation switch off by default", () => {
    const env = parseEnv(baseEnv());
    expect(env.SESSION_ISOLATION_MODE).toBe("off");
    expect(env.SESSION_ISOLATION_PASTA_PATH).toBeUndefined();
  });

  it("rejects an invalid switch value at startup", () => {
    expect(() => parseEnv(baseEnv({ SESSION_ISOLATION_MODE: "true" }))).toThrow();
  });

  it("requires the pasta path when enforced on linux", () => {
    if (process.platform === "win32") return;
    expect(() => parseEnv(baseEnv({ SESSION_ISOLATION_MODE: "enforce" }))).toThrow(
      /SESSION_ISOLATION_PASTA_PATH/,
    );
    expect(() => parseEnv(baseEnv({
      SESSION_ISOLATION_MODE: "enforce",
      SESSION_ISOLATION_PASTA_PATH: "relative/pasta",
    }))).toThrow(/absolute/);
  });

  it("rejects incomplete pairs", () => {
    expect(() => parseEnv(baseEnv({
      HANIEL_DASHBOARD_URL: "http://127.0.0.1:9300",
    }))).toThrow(/must be set together/);
    expect(() => parseEnv(baseEnv({
      HANIEL_ORCH_TOKEN_FILE: "/tmp/orch-token",
    }))).toThrow(/must be set together/);
    expect(() => parseEnv(baseEnv({
      ISOLATED_CLAUDE_TOKEN_FILE: "/tmp/claude-token",
    }))).toThrow(/must be set together/);
  });

  it("rejects malformed isolation lists", () => {
    expect(() => parseEnv(baseEnv({
      SESSION_ISOLATION_LOCAL_MCP: "alpha",
    }))).toThrow(/serverId:port/);
    expect(() => parseEnv(baseEnv({
      SESSION_ISOLATION_TEST_DATABASE: "5432",
    }))).toThrow(/hostPort:sandboxPort/);
  });
});

describe("valid policy merge", () => {
  it("returns the file policy unchanged when there is nothing to add", () => {
    const merged = applyNodeIsolationPolicy(BASE_POLICY, { localMcp: [], testDatabase: null }, "node-a");
    expect(merged).toBe(BASE_POLICY);
    expect(computeIsolationPolicyDigest(merged)).toBe(computeIsolationPolicyDigest(BASE_POLICY));
  });

  it("adds node local MCP servers and test databases with the node id", () => {
    const merged = applyNodeIsolationPolicy(BASE_POLICY, {
      localMcp: [{ serverId: "alpha", port: 4100 }],
      testDatabase: { hostPort: 5432, sandboxPort: 15432 },
    }, "node-a");
    expect(merged.localMcp.optional).toEqual([
      { serverId: "alpha", nodeId: "node-a", port: 4100 },
    ]);
    expect(merged.testDatabases).toEqual([
      { nodeId: "node-a", hostPort: 5432, sandboxPort: 15432 },
    ]);
    expect(computeIsolationPolicyDigest(merged)).not.toBe(
      computeIsolationPolicyDigest(BASE_POLICY),
    );
  });

  it("computes the digest from the merged policy, not the file", () => {
    const filePolicy = JSON.stringify({
      version: 1,
      tools: { add_card_note: { category: "allow" } },
      localMcp: { requiredServerId: "soulstream", optional: [] },
      filesystem: {
        sessionWorktreeRelativeRoot: ".projects/.isolated",
        credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
        isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
        writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
        additionalSensitiveRoots: [],
      },
      testDatabases: [],
      network: {
        mode: "pasta-nft",
        dnsForward4: "192.0.2.53",
        deniedIpv4: [],
        deniedIpv6: [],
      },
    });
    const source = createSessionIsolationPolicySource(
      { localMcp: [{ serverId: "alpha", port: 4100 }], testDatabase: null },
      "node-a",
      { path: "/policy.json", readFile: () => filePolicy },
    );
    const loaded = source.get();
    expect(loaded.digest).toBe(computeIsolationPolicyDigest(loaded.policy));
    expect(loaded.digest).not.toBe(computeIsolationPolicyDigest(BASE_POLICY));
  });
});

describe("restricted auth classification", () => {
  const common = {
    policy: BASE_POLICY,
    claudeTokenFile: null,
    claudeAccountId: null,
  };

  it("uses the codex grant directory under the home directory", () => {
    const preparation = classifyIsolatedAuth({
      ...common,
      backend: "codex",
      homeDirectory: "/home/tester",
    });
    expect(preparation).toEqual({
      kind: "codex-grant",
      canonicalCodexDirectory: join(
        "/home/tester",
        BASE_POLICY.filesystem.credentialRelativeDirectory,
      ),
    });
  });

  it("classifies claude presets with an API key env as apikey-env", () => {
    expect(classifyIsolatedAuth({
      ...common,
      backend: "claude",
      presetEnv: { ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: "http://x" },
    }).kind).toBe("apikey-env");
    expect(classifyIsolatedAuth({
      ...common,
      backend: "claude",
      presetEnv: { ANTHROPIC_AUTH_TOKEN: "placeholder" },
    }).kind).toBe("apikey-env");
  });

  it("requires the isolated token pair for oauth claude sessions", () => {
    expect(() => classifyIsolatedAuth({ ...common, backend: "claude" })).toThrow(
      /ISOLATED_CLAUDE_TOKEN_FILE/,
    );
    try {
      classifyIsolatedAuth({ ...common, backend: "claude" });
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ISOLATION_AUTH_UNAVAILABLE);
    }
    expect(classifyIsolatedAuth({
      ...common,
      backend: "claude",
      claudeTokenFile: "/tmp/token",
      claudeAccountId: "account-1",
    })).toEqual({
      kind: "claude-oauth-token",
      claudeTokenFile: "/tmp/token",
      credentialAccountId: "account-1",
    });
  });

  it("classifies opencode as apikey-env without demanding new keys", () => {
    expect(classifyIsolatedAuth({ ...common, backend: "opencode" })).toEqual({
      kind: "apikey-env",
    });
  });

  it("marks antigravity and unknown backends unavailable", () => {
    expect(classifyIsolatedAuth({ ...common, backend: "antigravity" })).toEqual({
      kind: "unavailable",
    });
    expect(classifyIsolatedAuth({ ...common, backend: "openai-agents" })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("isolation runtime composition", () => {
  it("exposes the fixed host tool paths without a host-side helper path", () => {
    // netns helper는 러너 릴리스 스냅샷 안에 있으므로 호스트 런타임이 경로를
    // 만들지 않는다. 스폰 조립이 release.runnerModuleRoot 기준으로 정한다.
    const runtime = createSessionIsolationRuntime({
      nodeId: "node-a",
      settings: sessionIsolationSettingsFromEnv({
        SESSION_ISOLATION_MODE: "enforce",
        SESSION_ISOLATION_PASTA_PATH: "/usr/bin/pasta",
      }, "linux"),
      policySource: { get: () => ({ policy: BASE_POLICY, digest: "digest-1" }) },
    });
    expect(runtime.mode).toBe("enforce");
    expect(runtime.tools).toMatchObject({
      bwrap: ISOLATION_TOOL_PATHS.bwrap,
      unshare: ISOLATION_TOOL_PATHS.unshare,
      setpriv: ISOLATION_TOOL_PATHS.setpriv,
      nft: ISOLATION_TOOL_PATHS.nft,
      pasta: "/usr/bin/pasta",
    });
    expect(runtime.tools).not.toHaveProperty("netnsHelper");
  });

  it("classifies auth through the runtime using configured credentials", () => {
    const runtime = createSessionIsolationRuntime({
      nodeId: "node-a",
      settings: sessionIsolationSettingsFromEnv({
        ISOLATED_CLAUDE_TOKEN_FILE: "/tmp/token",
        ISOLATED_CLAUDE_ACCOUNT_ID: "account-1",
      }),
      policySource: { get: () => ({ policy: BASE_POLICY, digest: "digest-1" }) },
    });
    expect(runtime.classifyAuth({ backend: "claude" })).toEqual({
      kind: "claude-oauth-token",
      claudeTokenFile: "/tmp/token",
      credentialAccountId: "account-1",
    });
  });
});

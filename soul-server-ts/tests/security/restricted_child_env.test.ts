import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildClaudeAccountPoolEnvironment } from "../../src/engine/claude_account_pool.js";
import { launchIsolatedChild, restrictedChildEnv } from "../../src/engine/isolated_session_launch.js";
import type { RunnerIsolationChildConfig } from "../../src/runner/runner_isolation_config.js";

const mocks = vi.hoisted(() => ({ launchIsolatedSession: vi.fn() }));

vi.mock("../../src/runner/session_netns_helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runner/session_netns_helper.js")>();
  return {
    ...actual,
    launchIsolatedSession: mocks.launchIsolatedSession,
    createIsolationProcessPorts: vi.fn(() => ({})),
  };
});

const isolation: RunnerIsolationChildConfig = {
  spec: {
    version: 1,
    enabled: true,
    sessionId: "session-a",
    backend: "claude",
    workspaceDir: "/workspace",
    scratchWorkspaceDir: "/workspace",
    sandboxDirectory: "/sandbox",
    sessionWorktreeRoot: "/sandbox/worktrees",
    authKind: "claude-oauth-token",
    policyDigest: "digest",
    bindings: [],
    masks: [],
    heavyWorkLockBindings: [],
    hostProcLocksBinding: { source: "/host/lock", destination: "/run/lock", writable: true },
    approvedLocalMcp: [],
    approvedTestDatabase: null,
  },
  resolvConfPath: "/sandbox/resolv.conf",
  wsl: false,
  tools: {
    bwrap: "/usr/bin/bwrap",
    pasta: "/usr/bin/pasta",
    unshare: "/usr/bin/unshare",
    setpriv: "/usr/bin/setpriv",
    nft: "/usr/sbin/nft",
    netnsHelper: "/opt/netns-helper.py",
  },
  envKeys: ["CLAUDE_CONFIG_DIR"],
  contextNotice: "격리 세션",
  attachedWorktreeIds: [],
};

const accountEnv = buildClaudeAccountPoolEnvironment({
  CLAUDE_CODE_MESSAGING_TOKEN: "messaging-token",
  GITHUB_TOKEN: "github-token",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-model",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-model",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-model",
  ENABLE_TOOL_SEARCH: "true",
}, {
  account_id: "account-a",
  config_dir: "/accounts/a",
  available_count: 1,
  credential: { kind: "access-token", access_token: "selected-token" },
});

beforeEach(() => {
  vi.stubEnv("AUTH_BEARER_TOKEN", "restricted-credential");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/sandbox/claude-config");
  mocks.launchIsolatedSession.mockReset();
  mocks.launchIsolatedSession.mockReturnValue({
    child: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    ready: Promise.resolve(),
    dispose: vi.fn(async () => undefined),
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("restricted child environment", () => {
  it("keeps the selected account token only when explicitly allowed", () => {
    const env = restrictedChildEnv(isolation, accountEnv, ["CLAUDE_CODE_OAUTH_TOKEN"]);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-token");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/sandbox/claude-config");
    expect(env).not.toHaveProperty("CLAUDE_CODE_MESSAGING_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(restrictedChildEnv(isolation, accountEnv)).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("keeps the model preset settings", () => {
    expect(restrictedChildEnv(isolation, accountEnv)).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-model",
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("passes an explicit child environment's account token to the launcher", () => {
    launchIsolatedChild({
      isolation, command: "claude", args: [], env: accountEnv, stdio: "pipe",
      logger: { warn: vi.fn() },
    });

    expect(mocks.launchIsolatedSession.mock.calls[0]![0].env.CLAUDE_CODE_OAUTH_TOKEN)
      .toBe("selected-token");
  });

  it("does not pass the host token when the child environment falls back to process.env", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "host-token");
    launchIsolatedChild({
      isolation, command: "claude", args: [], stdio: "pipe", logger: { warn: vi.fn() },
    });

    expect(mocks.launchIsolatedSession.mock.calls[0]![0].env)
      .not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

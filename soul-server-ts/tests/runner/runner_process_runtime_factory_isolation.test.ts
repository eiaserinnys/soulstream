import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { composeSessionIsolation } from
  "../../src/runtime/session_isolation_composition.js";
import type { Env } from "../../src/config.js";
import { createRunnerProcessRuntimeFactory } from
  "../../src/runner/runner_process_runtime_factory.js";
import type { PreparedRunnerIsolation, RunnerIsolationHost } from
  "../../src/runner/runner_process_isolation.js";
import type { SessionIsolationSpec } from
  "../../src/security/session_isolation_contract.js";
import type { Task } from "../../src/task/task_models.js";

const HOST_BEARER = "host-full-bearer-secret";
const HOST_DATABASE_URL = "postgres://host-db-secret";
const HOST_SSH_SOCK = "/run/host-agent-secret.sock";
const RESTRICTED_CREDENTIAL = "ssr1-restricted-credential";
const RESTRICTED_GH_TOKEN = "ghs-restricted-grant";

const agent = {
  id: "claude-restricted",
  name: "Restricted Agent",
  backend: "claude",
  workspace_dir: "/workspace/restricted",
} as AgentProfile;

function runnerEnv() {
  return {
    SOUL_RUNNER_STATE_DIR: "/runner",
    SOUL_RUNNER_ARTIFACT_DIR: "/artifacts",
    SOUL_RUNNER_RELEASES_DIR: "/releases",
    SOUL_RUNNER_TERMINAL_RETENTION_MS: 60_000,
    SOUL_RUNNER_LEASE_TIMEOUT_MS: 90_000,
    INCOMING_FILE_DIR: "/incoming",
    SOULSTREAM_NODE_ID: "node-test",
    CODEX_ADAPTER_MODE: "sdk" as const,
    CLAUDE_SESSION_RUNTIME_V2_ENABLED: true,
    CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 300_000,
    CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 16,
    CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: 1_800_000,
    CODEX_DETACHED_RESULT_RETENTION_MS: 120_000,
    CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: 45_000,
    CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: 135_000,
    MCP_INTERNAL_PORT: 4308,
    MCP_PATH: "/mcp",
    OPENCODE_CLI_PATH: undefined,
  };
}

function makeSpec(): SessionIsolationSpec {
  return {
    version: 1,
    enabled: true,
    sessionId: "session-restricted",
    backend: "claude",
    workspaceDir: "/workspace/restricted",
    scratchWorkspaceDir: "/workspace/restricted",
    sandboxDirectory: "/sandbox/restricted",
    sessionWorktreeRoot: "/sandbox/restricted/worktrees",
    authKind: "apikey-env",
    policyDigest: "digest-1",
    bindings: [],
    masks: [],
    heavyWorkLockBindings: [],
    hostProcLocksBinding: {
      source: "/srv/host/lock",
      destination: "/run/lock",
      writable: true,
    },
    approvedLocalMcp: [],
    approvedTestDatabase: null,
  };
}

function makePrepared(): PreparedRunnerIsolation {
  return {
    plan: {
      spec: makeSpec(),
      sanitizedServers: [],
      env: {
        AUTH_BEARER_TOKEN: RESTRICTED_CREDENTIAL,
        GH_TOKEN: RESTRICTED_GH_TOKEN,
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-restricted",
      },
      resolvConfPath: "/run/systemd/resolve/stub-resolv.conf",
      contextNotice: "격리 세션 안내",
    },
    wsl: false,
    tools: {
      bwrap: "/usr/bin/bwrap",
      pasta: "/usr/bin/pasta",
      unshare: "/usr/bin/unshare",
      setpriv: "/usr/bin/setpriv",
      nft: "/usr/sbin/nft",
      netnsHelper: "/opt/netns-helper.py",
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-restricted",
    prompt: "start",
    status: "pending",
    executionSecurity: {
      sessionId: "session-restricted",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    },
    ...overrides,
  } as Task;
}

function makeFactory(options: {
  task: Task;
  isolationHost?: RunnerIsolationHost;
  childProcessEnv?: NodeJS.ProcessEnv;
  resolvedMcpServers?: readonly unknown[];
}) {
  const spawn = vi.fn(async () => {
    throw new Error("captured isolation spawn input");
  });
  const factory = createRunnerProcessRuntimeFactory({
    env: {
      ...runnerEnv(),
      CLAUDE_ACCOUNT_POOL_ENABLED: true,
      CLAUDE_ACCOUNTS_DIR: "/worker/claude-accounts",
    },
    logger: pino({ level: "silent" }),
    pumpMux: {} as never,
    sessionStore: {} as never,
    claudeAccounts: {
      select: vi.fn(),
      reject: vi.fn(),
      release: vi.fn(),
    },
    mcpConfigService: {
      resolveMcpProfile: vi.fn(() => ({
        mcp_servers: options.resolvedMcpServers ?? [],
      })),
    } as never,
    releasePool: {
      resolveCurrentRelease: vi.fn(async () => ({
        releaseId: "sha-isolation",
        releaseRoot: "/release/sha-isolation",
        runnerModuleRoot: "/release/sha-isolation/soul-server-ts",
      })),
      describe: vi.fn(),
      ensureRelease: vi.fn(async () => undefined),
    },
    buildChildProcessEnv: () => options.childProcessEnv ?? ({}),
    spawner: { adopt: vi.fn(), spawn },
    ...(options.isolationHost ? { isolationHost: options.isolationHost } : {}),
  });
  const runtime = factory(options.task, agent, "claude", {
    persistRunState: vi.fn(async () => undefined),
    persistSessionItems: vi.fn(async () => undefined),
  });
  return { factory, runtime, spawn };
}

describe("runner process factory restricted wiring", () => {
  it("prepares once and replaces env, MCP servers and pool for a restricted turn", async () => {
    const prepared = makePrepared();
    const prepare = vi.fn(async () => prepared);
    const task = makeTask({
      worktreeId: "worktree-1",
    });
    const { runtime, spawn } = makeFactory({
      task,
      isolationHost: { prepare },
      childProcessEnv: {
        PATH: "/usr/bin",
        AUTH_BEARER_TOKEN: HOST_BEARER,
        DATABASE_URL: HOST_DATABASE_URL,
        SSH_AUTH_SOCK: HOST_SSH_SOCK,
        SCCACHE_DIR: "/cache/sccache",
      },
      resolvedMcpServers: [{ type: "stdio" }],
    });

    await expect(runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("captured isolation spawn input");

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({
      task,
      agent,
      backend: "claude",
    });
    const input = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    const childProcessEnv = input.childProcessEnv as Record<string, string | undefined>;
    expect(childProcessEnv.AUTH_BEARER_TOKEN).toBe(RESTRICTED_CREDENTIAL);
    expect(childProcessEnv.GH_TOKEN).toBe(RESTRICTED_GH_TOKEN);
    expect(childProcessEnv.PATH).toBe("/usr/bin");
    expect(childProcessEnv.DATABASE_URL).toBeUndefined();
    expect(childProcessEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(childProcessEnv.SCCACHE_DIR).toBeUndefined();
    expect(input.claudeAccountPool).toBeUndefined();
    expect(input.resolvedMcpServers).toEqual(prepared.plan.sanitizedServers);
    const isolation = input.isolation as {
      envKeys: string[];
      contextNotice: string;
      spec: unknown;
    };
    expect(isolation.spec).toEqual(prepared.plan.spec);
    expect(isolation.envKeys).toEqual([
      "AUTH_BEARER_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GH_TOKEN",
    ]);
    expect(isolation.contextNotice).toBe(prepared.plan.contextNotice);
    // child config에는 값이 없고, 호스트 full 비밀은 childProcessEnv에도 없다.
    const serializedConfig = JSON.stringify(isolation);
    expect(serializedConfig).not.toContain(RESTRICTED_CREDENTIAL);
    expect(serializedConfig).not.toContain(RESTRICTED_GH_TOKEN);
    expect(serializedConfig).not.toContain("claude-oauth-restricted");
    expect(serializedConfig).not.toContain(HOST_BEARER);
    const serializedInput = JSON.stringify({ ...input, childProcessEnv: undefined });
    expect(serializedInput).not.toContain(HOST_BEARER);
    expect(serializedInput).not.toContain(HOST_DATABASE_URL);
    expect(serializedInput).not.toContain(HOST_SSH_SOCK);
    expect(JSON.stringify(childProcessEnv)).not.toContain(HOST_BEARER);
  });

  it("keeps the full baseline untouched and never prepares isolation", async () => {
    const prepare = vi.fn(async () => makePrepared());
    const childProcessEnv = {
      AUTH_BEARER_TOKEN: HOST_BEARER,
      DATABASE_URL: HOST_DATABASE_URL,
      PATH: "/usr/bin",
    };
    const mcpServers = [{ type: "stdio", command: "/mcp" }];
    const { runtime, spawn } = makeFactory({
      task: makeTask({
        executionSecurity: {
          sessionId: "session-restricted",
          tier: "full",
          policyVersion: 1,
          reason: "trusted",
          presetId: "claude-opus",
        },
      }),
      isolationHost: { prepare },
      childProcessEnv,
      resolvedMcpServers: mcpServers,
    });

    await expect(runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("captured isolation spawn input");

    expect(prepare).not.toHaveBeenCalled();
    const input = spawn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.childProcessEnv).toEqual(childProcessEnv);
    expect(input.isolation).toBeUndefined();
    expect(input.resolvedMcpServers).toEqual(mcpServers);
    expect(input.claudeAccountPool).toEqual({
      enabled: true,
      accountsDir: "/worker/claude-accounts",
    });
  });

  it("fails the restricted turn instead of running full when no isolation host is wired", async () => {
    const { runtime, spawn } = makeFactory({ task: makeTask() });

    await expect(runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("SESSION_ISOLATION_UNAVAILABLE: restricted execution requires an isolation host");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails the restricted turn with the preparation error and never spawns", async () => {
    const prepare = vi.fn(async () => {
      throw new Error("policy read failed");
    });
    const { runtime, spawn } = makeFactory({
      task: makeTask(),
      isolationHost: { prepare },
    });

    await expect(runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("policy read failed");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails the restricted turn when the prepared plan has no session credential", async () => {
    const prepared = makePrepared();
    prepared.plan.env = { GH_TOKEN: RESTRICTED_GH_TOKEN };
    const { runtime, spawn } = makeFactory({
      task: makeTask(),
      isolationHost: { prepare: vi.fn(async () => prepared) },
    });

    await expect(runtime.dispatcher.prepareSession("session-restricted")).rejects.toThrow(
      "SESSION_ISOLATION_UNAVAILABLE: prepared isolation plan is missing its restricted credential",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("advertises isolation support only when the host is wired", async () => {
    const withoutHost = makeFactory({ task: makeTask() });
    expect(withoutHost.factory.isolationSupported).toBe(false);
    await expect(withoutHost.runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("SESSION_ISOLATION_UNAVAILABLE: restricted execution requires an isolation host");

    const withHost = makeFactory({
      task: makeTask(),
      isolationHost: { prepare: vi.fn(async () => makePrepared()) },
    });
    expect(withHost.factory.isolationSupported).toBe(true);
    await expect(withHost.runtime.dispatcher.prepareSession("session-restricted"))
      .rejects.toThrow("captured isolation spawn input");
  });
});

describe("session isolation composition switch", () => {
  it("returns nothing for off without parsing isolation settings", () => {
    // off 분기는 설정 파서를 부르지 않으므로 불완전한 env로도 예외가 없다.
    const offEnv = { SESSION_ISOLATION_MODE: "off" } as Env;
    expect(composeSessionIsolation({
      env: offEnv,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
    })).toBeUndefined();
  });

  it("assembles the single runtime and host pair for enforce", () => {
    const enforceEnv = {
      SESSION_ISOLATION_MODE: "enforce",
      SESSION_ISOLATION_PASTA_PATH: "/usr/bin/pasta",
      SOULSTREAM_NODE_ID: "node-test",
    } as unknown as Env;
    const composition = composeSessionIsolation({
      env: enforceEnv,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
    });
    expect(composition?.runtime.mode).toBe("enforce");
    expect(composition?.host.prepare).toBeTypeOf("function");
  });

  it("rejects full turns in the host before reading any host state", async () => {
    const enforceEnv = {
      SESSION_ISOLATION_MODE: "enforce",
      SESSION_ISOLATION_PASTA_PATH: "/usr/bin/pasta",
      SOULSTREAM_NODE_ID: "node-test",
    } as unknown as Env;
    const worktreeService = { list: vi.fn(async () => []) };
    const composition = composeSessionIsolation({
      env: enforceEnv,
      worktreeService: worktreeService as never,
      mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
    });
    await expect(composition!.host.prepare({
      task: makeTask({
        executionSecurity: {
          sessionId: "session-restricted",
          tier: "full",
          policyVersion: 1,
          reason: "trusted",
          presetId: "claude-opus",
        },
      }),
      agent,
      backend: "claude",
    })).rejects.toThrow("SESSION_ISOLATION_UNAVAILABLE: isolation host is used only for restricted turns");
    expect(worktreeService.list).not.toHaveBeenCalled();
  });
});

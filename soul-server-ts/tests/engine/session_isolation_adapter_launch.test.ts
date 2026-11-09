import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchAntigravityProcess } from "../../src/engine/antigravity/process.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";
import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import { createStdioAppServerTransport } from
  "../../src/engine/codex_app_server/stdio_transport.js";
import { launchOpenCodeProcess } from "../../src/engine/opencode/process.js";
import type { RunnerIsolationChildConfig } from
  "../../src/runner/runner_isolation_config.js";
import type { SessionIsolationSpec } from
  "../../src/security/session_isolation_contract.js";

const mocks = vi.hoisted(() => ({
  launchIsolatedSession: vi.fn(),
  spawnNode: vi.fn(),
  spawnClaudeSessionEngine: vi.fn(),
}));

vi.mock("../../src/runner/session_netns_helper.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/runner/session_netns_helper.js")
  >();
  return {
    ...actual,
    launchIsolatedSession: mocks.launchIsolatedSession,
    createIsolationProcessPorts: vi.fn(() => ({})),
  };
});

vi.mock("../../src/engine/session_engine_oom_score.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/engine/session_engine_oom_score.js")
  >();
  return { ...actual, spawnClaudeSessionEngine: mocks.spawnClaudeSessionEngine };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawnNode };
});

const RESTRICTED_CREDENTIAL = "ssr1-adapter-credential";
const RESTRICTED_GH_TOKEN = "ghs-adapter-grant";
const HOST_BEARER = "host-full-bearer-secret";
const HOST_DATABASE_URL = "postgres://host-db-secret";
const logger = pino({ level: "silent" });

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

function makeSpec(): SessionIsolationSpec {
  return {
    version: 1,
    enabled: true,
    sessionId: "session-adapter",
    backend: "claude",
    workspaceDir: "/workspace/agent",
    scratchWorkspaceDir: "/workspace/agent",
    sandboxDirectory: "/sandbox/agent",
    sessionWorktreeRoot: "/sandbox/agent/worktrees",
    authKind: "apikey-env",
    policyDigest: "digest-adapter",
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

function isolationConfig(
  overrides: Partial<RunnerIsolationChildConfig> = {},
): RunnerIsolationChildConfig {
  return {
    spec: makeSpec(),
    resolvConfPath: "/run/systemd/resolve/stub-resolv.conf",
    wsl: false,
    tools: {
      bwrap: "/usr/bin/bwrap",
      pasta: "/usr/bin/pasta",
      unshare: "/usr/bin/unshare",
      setpriv: "/usr/bin/setpriv",
      nft: "/usr/sbin/nft",
      netnsHelper: "/opt/netns-helper.py",
    },
    envKeys: ["GH_TOKEN"],
    contextNotice: "격리 세션 안내",
    attachedWorktreeIds: [],
    ...overrides,
  };
}

function fakeLaunch(child: FakeChild, ready: Promise<void> = Promise.resolve()) {
  return {
    child,
    ready,
    completion: Promise.resolve({ code: 0, signal: null }),
    dispose: vi.fn(async () => undefined),
  };
}

function hostEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin",
    AUTH_BEARER_TOKEN: HOST_BEARER,
    DATABASE_URL: HOST_DATABASE_URL,
    SSH_AUTH_SOCK: "/run/host-agent.sock",
  };
}

function buildClaudeOptions(options: Partial<ClaudeRunOptions>) {
  return buildClaudeSdkOptions({
    options: {
      prompt: "hi",
      workspaceDir: "/workspace/agent",
      ...options,
    } as ClaudeRunOptions,
    abortController: new AbortController(),
    output: { push: () => {}, close: () => {} } as never,
    logger,
    resolveClaudeExecutablePath: () => undefined,
    eventMapper: {} as never,
    runtimeState: {} as never,
    toolPermissionController: { makeCanUseTool: () => () => undefined } as never,
  });
}

const claudeSpawnOptions = {
  command: "/usr/local/bin/claude",
  args: ["--print"],
  cwd: "/workspace/agent",
  env: hostEnv(),
} as never;

beforeEach(() => {
  mocks.launchIsolatedSession.mockReset();
  mocks.spawnNode.mockReset();
  mocks.spawnClaudeSessionEngine.mockReset();
  vi.stubEnv("AUTH_BEARER_TOKEN", RESTRICTED_CREDENTIAL);
  vi.stubEnv("GH_TOKEN", RESTRICTED_GH_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claude adapter isolated launch", () => {
  it("launches once through the isolation path and never spawns the full CLI", () => {
    const child = new FakeChild();
    mocks.launchIsolatedSession.mockReturnValue(fakeLaunch(child));
    const onIsolationFailure = vi.fn();

    const built = buildClaudeOptions({
      isolation: isolationConfig(),
      onIsolationFailure,
    });
    const spawned = built.spawnClaudeCodeProcess!(claudeSpawnOptions);

    expect(spawned).toBe(child);
    expect(mocks.launchIsolatedSession).toHaveBeenCalledTimes(1);
    expect(mocks.spawnClaudeSessionEngine).not.toHaveBeenCalled();
    expect(onIsolationFailure).not.toHaveBeenCalled();
    const input = mocks.launchIsolatedSession.mock.calls[0]![0] as {
      original: { command: string; args: string[] };
      plan: SessionIsolationSpec;
      cwd: string;
      env: Record<string, string>;
      stdio: unknown;
    };
    expect(input.original).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--print"],
    });
    expect(input.plan).toEqual(makeSpec());
    expect(input.cwd).toBe("/workspace/agent");
    expect(input.stdio).toBe("pipe");
    // 호스트 full 자격은 여기서 끝나고, 세션 추가분은 자식 환경에서 다시 합성된다.
    expect(input.env.AUTH_BEARER_TOKEN).toBe(RESTRICTED_CREDENTIAL);
    expect(input.env.GH_TOKEN).toBe(RESTRICTED_GH_TOKEN);
    expect(input.env.PATH).toBe("/usr/bin");
    expect(input.env.DATABASE_URL).toBeUndefined();
    expect(input.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("reports a missing CLI start as an isolation failure without falling back to full", async () => {
    const child = new FakeChild();
    const failure = new Error("pasta exited before the CLI started");
    mocks.launchIsolatedSession.mockReturnValue(
      fakeLaunch(child, Promise.reject(failure)),
    );
    const onIsolationFailure = vi.fn();

    const built = buildClaudeOptions({
      isolation: isolationConfig(),
      onIsolationFailure,
    });
    built.spawnClaudeCodeProcess!(claudeSpawnOptions);

    await vi.waitFor(() => expect(onIsolationFailure).toHaveBeenCalledTimes(1));
    const error = onIsolationFailure.mock.calls[0]![0] as Error;
    expect(error.message).toContain("SESSION_ISOLATION_UNAVAILABLE");
    expect(error.message).toContain("pasta exited before the CLI started");
    expect(mocks.spawnClaudeSessionEngine).not.toHaveBeenCalled();
  });

  it("keeps the off baseline spawn unchanged", () => {
    const child = new FakeChild();
    mocks.spawnClaudeSessionEngine.mockReturnValue(child);

    const built = buildClaudeOptions({});
    const spawned = built.spawnClaudeCodeProcess!(claudeSpawnOptions);

    expect(spawned).toBe(child);
    expect(mocks.spawnClaudeSessionEngine).toHaveBeenCalledTimes(1);
    expect(mocks.spawnClaudeSessionEngine).toHaveBeenCalledWith(
      claudeSpawnOptions,
      logger,
      undefined,
    );
    expect(mocks.launchIsolatedSession).not.toHaveBeenCalled();
  });
});

describe("opencode adapter isolated launch", () => {
  it("launches once through the isolation path and never spawns directly", () => {
    const child = new FakeChild();
    mocks.launchIsolatedSession.mockReturnValue(fakeLaunch(child));
    const env = hostEnv();

    launchOpenCodeProcess({
      executablePath: "/opt/opencode",
      args: ["run", "--print"],
      cwd: "/workspace/agent",
      env,
      input: "{}",
      logger,
      isolation: isolationConfig(),
    });

    expect(mocks.spawnNode).not.toHaveBeenCalled();
    expect(mocks.launchIsolatedSession).toHaveBeenCalledTimes(1);
    const input = mocks.launchIsolatedSession.mock.calls[0]![0] as {
      original: { command: string; args: string[] };
      env: Record<string, string>;
      stdio: unknown;
    };
    expect(input.original).toEqual({
      command: "/opt/opencode",
      args: ["run", "--print"],
    });
    expect(input.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(input.env.AUTH_BEARER_TOKEN).toBe(RESTRICTED_CREDENTIAL);
    expect(input.env.GH_TOKEN).toBe(RESTRICTED_GH_TOKEN);
    expect(input.env.DATABASE_URL).toBeUndefined();
  });

  it("keeps the off baseline spawn unchanged", () => {
    const child = new FakeChild();
    mocks.spawnNode.mockReturnValue(child);
    const env = hostEnv();

    launchOpenCodeProcess({
      executablePath: "/opt/opencode",
      args: ["run", "--print"],
      cwd: "/workspace/agent",
      env,
      input: "{}",
      logger,
    });

    expect(mocks.launchIsolatedSession).not.toHaveBeenCalled();
    expect(mocks.spawnNode).toHaveBeenCalledWith("/opt/opencode", ["run", "--print"], {
      cwd: "/workspace/agent",
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });
});

describe("codex app-server transport isolated launch", () => {
  it("launches once through the isolation path and never calls the injected spawn", () => {
    const child = new FakeChild();
    mocks.launchIsolatedSession.mockReturnValue(fakeLaunch(child));
    const spawnProcess = vi.fn();

    createStdioAppServerTransport({
      spawnProcess,
      applyOomScore: () => {},
      platform: "linux",
      logger,
      isolation: isolationConfig(),
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(mocks.launchIsolatedSession).toHaveBeenCalledTimes(1);
    const input = mocks.launchIsolatedSession.mock.calls[0]![0] as {
      original: { command: string; args: string[] };
      env: Record<string, string>;
      stdio: unknown;
    };
    expect(input.original).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
    });
    expect(input.stdio).toBe("pipe");
    expect(input.env.AUTH_BEARER_TOKEN).toBe(RESTRICTED_CREDENTIAL);
    expect(input.env.GH_TOKEN).toBe(RESTRICTED_GH_TOKEN);
    expect(input.env.DATABASE_URL).toBeUndefined();
    expect(input.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("surfaces a ready rejection as an error and close on the transport", async () => {
    const child = new FakeChild();
    mocks.launchIsolatedSession.mockReturnValue(
      fakeLaunch(child, Promise.reject(new Error("firewall handshake failed"))),
    );
    const transport = createStdioAppServerTransport({
      spawnProcess: vi.fn(),
      applyOomScore: () => {},
      platform: "linux",
      logger,
      isolation: isolationConfig(),
    });
    const onError = vi.fn();
    const onClose = vi.fn();
    transport.onError(onError);
    transport.onClose(onClose);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0]![0] as Error).message)
      .toContain("SESSION_ISOLATION_UNAVAILABLE");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the off baseline spawn unchanged", () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child);
    const env = { PATH: "/usr/bin" };

    createStdioAppServerTransport({
      spawnProcess,
      applyOomScore: () => {},
      platform: "linux",
      logger,
      env,
    });

    expect(mocks.launchIsolatedSession).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      { cwd: undefined, env, stdio: "pipe" },
    );
  });
});

describe("antigravity adapter off baseline", () => {
  it("keeps its direct spawn unchanged", () => {
    const child = new FakeChild();
    mocks.spawnNode.mockReturnValue(child);
    const env = { PATH: "/usr/bin" };

    launchAntigravityProcess({
      executablePath: "/opt/antigravity",
      args: ["--serve"],
      cwd: "/workspace/agent",
      env,
      input: "{}",
      logger,
    });

    expect(mocks.spawnNode).toHaveBeenCalledWith(
      "/opt/antigravity",
      ["--serve"],
      expect.objectContaining({
        cwd: "/workspace/agent",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(mocks.launchIsolatedSession).not.toHaveBeenCalled();
  });
});

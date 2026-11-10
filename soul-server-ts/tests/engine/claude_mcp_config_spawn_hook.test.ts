import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";
import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import type { RunnerIsolationChildConfig } from "../../src/runner/runner_isolation_config.js";
import type { SessionIsolationSpec } from "../../src/security/session_isolation_contract.js";

const mocks = vi.hoisted(() => ({
  launchIsolatedSession: vi.fn(),
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

function fakeLaunch(child: FakeChild) {
  return {
    child,
    ready: Promise.resolve(),
    dispose: vi.fn(async () => undefined),
  };
}

function makeSpec(sandboxDirectory: string): SessionIsolationSpec {
  return {
    version: 1,
    enabled: true,
    sessionId: "session-mcp-config",
    backend: "claude",
    workspaceDir: "/workspace/agent",
    scratchWorkspaceDir: "/workspace/agent",
    sandboxDirectory,
    sessionWorktreeRoot: join(sandboxDirectory, "worktrees"),
    authKind: "apikey-env",
    policyDigest: "digest-mcp-config",
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

function isolationConfig(sandboxDirectory: string): RunnerIsolationChildConfig {
  return {
    spec: makeSpec(sandboxDirectory),
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
    envKeys: [],
    contextNotice: "격리 세션 안내",
    attachedWorktreeIds: [],
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

const MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    atom: {
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer test-secret-value" },
    },
  },
});

function spawnOptions(args: string[]) {
  return {
    command: "/usr/local/bin/claude",
    args,
    cwd: "/workspace/agent",
    env: { PATH: "/usr/bin" },
    signal: new AbortController().signal,
  };
}

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-mcp-hook-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  mocks.launchIsolatedSession.mockReset();
  mocks.spawnClaudeSessionEngine.mockReset();
  vi.stubEnv("AUTH_BEARER_TOKEN", "restricted-test-credential");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("claude sdk options MCP config externalization", () => {
  it("hands the spawn hook a file path instead of inline MCP headers", () => {
    const directory = join(makeRoot(), "session");
    const child = new FakeChild();
    mocks.spawnClaudeSessionEngine.mockReturnValue(child);

    const built = buildClaudeOptions({ mcpConfigDirectory: directory });
    const spawned = built.spawnClaudeCodeProcess!(
      spawnOptions(["--print", "--mcp-config", MCP_CONFIG_JSON]),
    );

    expect(spawned).toBe(child);
    const passed = mocks.spawnClaudeSessionEngine.mock.calls[0]![0] as { args: string[] };
    expect(passed.args.join("\n")).not.toContain("test-secret-value");
    const file = passed.args[passed.args.indexOf("--mcp-config") + 1]!;
    expect(dirname(file)).toBe(directory);
    expect(readFileSync(file, "utf8")).toBe(MCP_CONFIG_JSON);

    child.emit("exit", 0, null);
    expect(existsSync(file)).toBe(false);
  });

  it("places the file under the sandbox directory for isolated launches", () => {
    const root = makeRoot();
    const directory = join(root, "session");
    const sandboxDirectory = join(root, "sandbox");
    const child = new FakeChild();
    mocks.launchIsolatedSession.mockReturnValue(fakeLaunch(child));

    const built = buildClaudeOptions({
      isolation: isolationConfig(sandboxDirectory),
      mcpConfigDirectory: directory,
    });
    built.spawnClaudeCodeProcess!(
      spawnOptions(["--print", "--mcp-config", MCP_CONFIG_JSON]),
    );

    const input = mocks.launchIsolatedSession.mock.calls[0]![0] as {
      original: { args: string[] };
    };
    expect(input.original.args.join("\n")).not.toContain("test-secret-value");
    const file = input.original.args[input.original.args.indexOf("--mcp-config") + 1]!;
    expect(dirname(file)).toBe(sandboxDirectory);
    expect(readFileSync(file, "utf8")).toBe(MCP_CONFIG_JSON);

    child.emit("exit", 0, null);
    expect(existsSync(file)).toBe(false);
  });

  it("removes the file when the spawn call throws", () => {
    const directory = join(makeRoot(), "session");
    mocks.spawnClaudeSessionEngine.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const built = buildClaudeOptions({ mcpConfigDirectory: directory });
    expect(() => built.spawnClaudeCodeProcess!(
      spawnOptions(["--print", "--mcp-config", MCP_CONFIG_JSON]),
    )).toThrow("spawn failed");

    expect(readdirSync(directory)).toEqual([]);
  });
});

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  IsolationHostPorts,
  IsolationLaunchInput,
  IsolationLaunchResult,
  IsolationPolicy,
  IsolationPreparationInput,
  IsolationProcessPorts,
  LaunchIsolatedSession,
  ObservationOptions,
  PrepareIsolationPlan,
  PreparedIsolationPlan,
  SessionCommand,
  SessionIsolationSpec,
  WrapSessionCommand,
} from "../../src/security/session_isolation_contract.js";

const policy: IsolationPolicy = {
  version: 1,
  tools: {
    "list_sessions": { category: "allow" },
    "delete_folder": { category: "deny" },
    "create_card": { category: "guarded", guard: "draft-card" },
    "create_agent_session": { category: "inherit", guard: "create-local-session" },
  },
  localMcp: {
    requiredServerId: "soulstream",
    optional: [{ serverId: "serendipity", nodeId: "node-a", port: 4002 }],
  },
  filesystem: {
    sessionWorktreeRelativeRoot: ".projects/.isolated",
    credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
    isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
    writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
    additionalSensitiveRoots: ["/home/eias/.ssh"],
    readOnlyReexposedPaths: [],
  },
  testDatabases: [{ nodeId: "node-a", hostPort: 5432, sandboxPort: 15432 }],
  network: {
    mode: "pasta-nft",
    dnsForward4: "192.0.2.53",
    deniedIpv4: ["10.0.0.0/8"],
    deniedIpv6: ["fc00::/7"],
  },
};

const spec: SessionIsolationSpec = {
  version: 1,
  enabled: true,
  sessionId: "s1",
  backend: "claude",
  workspaceDir: "/home/eias/workspace",
  scratchWorkspaceDir: "/home/eias/workspace/.local",
  sandboxDirectory: "/run/soulstream/isolated/s1",
  sessionWorktreeRoot: "/home/eias/workspace/.projects/.isolated",
  authKind: "claude-oauth-token",
  policyDigest: "digest-1",
  bindings: [{ source: "/home/eias/workspace", destination: "/home/eias/workspace", writable: true }],
  masks: [{ path: "/home/eias/workspace/.env", kind: "file" }],
  heavyWorkLockBindings: [
    "/tmp/soulstream-heavy-verify.lock",
    "/tmp/soulstream-heavy-verify.lock.slot-1",
    "/tmp/soulstream-heavy-verify.lock.slot-2",
    "/tmp/soulstream-heavy-verify.lock.slot-3",
  ].map((lockPath) => ({ source: lockPath, destination: lockPath, writable: true })),
  hostProcLocksBinding: { source: "/proc/locks", destination: "/proc/locks", writable: false },
  approvedLocalMcp: [{ serverId: "serendipity", hostPort: 4002, sandboxPort: 14002 }],
  approvedTestDatabase: { hostPort: 5432, sandboxPort: 15432 },
};

function observationOptions(): ObservationOptions {
  return { service: "soul-server", include_logs: true, lines: 50, include_pending: true };
}

describe("session isolation contract", () => {
  it("compiles fake B2 plan preparation against the frozen ports", async () => {
    const hostPorts: IsolationHostPorts = {
      ensureDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      resolveRealPath: vi.fn(async (target: string) => `/real${target}`),
      verifyAuthPreparation: vi.fn(async () => {}),
      prepareGitHubCredential: vi.fn(async () => ({ GH_TOKEN: "fake" })),
      issueRestrictedCredential: vi.fn(async (sessionId: string) => `ssr1.${sessionId}`),
      sanitizeMcpServers: vi.fn(async (servers) => servers),
      lstatPath: vi.fn(async () => null),
      listDirectory: vi.fn(async () => []),
      readSymlink: vi.fn(async () => null),
      detectWsl: vi.fn(async () => false),
      ensureLockFile: vi.fn(async () => {}),
      ensureSymlink: vi.fn(async () => {}),
      hashFileSha512: vi.fn(async () => ""),
      resolveGitCommonDir: vi.fn(async (repositoryPath: string) => `${repositoryPath}/.git`),
      resolveNodeId: vi.fn(async () => "node-a"),
      resolveMainPackageStorePath: vi.fn(async () => null),
      resolveAgentCommonFilesDirectory: vi.fn(async () => null),
      resolveServiceEnvironmentDirectory: vi.fn(async () => null),
    };
    const input: IsolationPreparationInput = {
      decision: {
        sessionId: "s1",
        tier: "restricted",
        policyVersion: 1,
        reason: "untrusted-preset",
        presetId: "deepseek-flash-4.1",
      },
      backend: "claude",
      workspaceDir: "/home/eias/workspace",
      sessionDirectory: "/home/eias/workspace/.local/share/soulstream/sessions/s1",
      hostWorkspaceRoot: "/home/eias/workspace",
      incomingRoot: "/home/eias/workspace/.local/incoming",
      homeDirectory: "/home/eias",
      uid: 1000,
      policy,
      policyDigest: "digest-1",
      resolvedServers: [],
      actualInternalMcpUrl: "http://127.0.0.1:3115/mcp/internal",
      ownedWorktrees: [{
        id: "wt-1",
        canonicalPath: "/home/eias/workspace/.projects/soulstream--s1",
        repoId: "soulstream",
        commonDir: "/home/eias/workspace/.projects/soulstream/.git",
      }],
      attachedWorktrees: [],
      registeredRepositories: [{
        repoId: "soulstream",
        canonicalPath: "/home/eias/workspace/.projects/soulstream",
      }],
      authPreparation: { kind: "claude-oauth-token" },
      testDatabaseUrl: "postgres://test:test@127.0.0.1:15432/test_db",
      scratchWorkspaceDir: "/home/eias/workspace/.local",
    };

    const prepareIsolationPlan: PrepareIsolationPlan = async (preparation, ports) => {
      const canonical = await ports.resolveRealPath(preparation.workspaceDir);
      const prepared: PreparedIsolationPlan = {
        spec: {
          ...spec,
          sessionId: preparation.decision.sessionId,
          policyDigest: preparation.policyDigest,
        },
        sanitizedServers: await ports.sanitizeMcpServers(
          preparation.resolvedServers,
          preparation.policy,
        ),
        env: preparation.testDatabaseUrl
          ? { TEST_DATABASE_URL: preparation.testDatabaseUrl }
          : {},
        resolvConfPath: `${canonical}/resolv.conf`,
        contextNotice: "isolated",
      };
      return prepared;
    };

    const prepared = await prepareIsolationPlan(input, hostPorts);

    expect(prepared.spec.sessionId).toBe("s1");
    expect(prepared.sanitizedServers).toEqual([]);
    expect(prepared.env).toHaveProperty("TEST_DATABASE_URL");
    expect(JSON.stringify(prepared.spec)).not.toContain("postgres://");
    expect(observationOptions().lines).toBe(50);
  });

  it("compiles fake B1 launch and command wrapping without real signals", async () => {
    const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => true);
    const processPorts: IsolationProcessPorts = {
      spawn: (_input: {
        command: string;
        args: readonly string[];
        options: SpawnOptions;
      }) => ({}) as ChildProcess,
      awaitNetworkReady: async () => {},
      kill,
    };
    const launchIsolatedSession: LaunchIsolatedSession = (input, ports) => {
      const child = ports.spawn({
        command: input.original.command,
        args: input.original.args,
        options: {
          cwd: input.cwd,
          env: input.env,
          stdio: input.stdio,
        },
      });
      return {
        child,
        ready: ports.awaitNetworkReady(child),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        dispose: async () => {},
      } satisfies IsolationLaunchResult;
    };
    const wrapSessionCommand: WrapSessionCommand = (original, plan) =>
      plan.enabled ? { command: "bwrap", args: original.args } : original;
    const original: SessionCommand = { command: "claude", args: ["--print", "hi"] };
    const launchInput: IsolationLaunchInput = {
      original,
      plan: spec,
      resolvConfPath: "/run/soulstream/isolated/s1/resolv.conf",
      cwd: "/home/eias/workspace",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
      tools: {
        bwrap: "/usr/bin/bwrap",
        pasta: "/usr/bin/pasta",
        unshare: "/usr/bin/unshare",
        setpriv: "/usr/bin/setpriv",
        nft: "/usr/sbin/nft",
        netnsHelper: "/home/eias/workspace/runner/session-netns-helper.py",
      },
    };

    const result = launchIsolatedSession(launchInput, processPorts);
    await result.ready;
    await expect(result.completion).resolves.toEqual({ exitCode: 0, signal: null });
    await result.dispose();
    expect(kill).not.toHaveBeenCalled();
    expect(wrapSessionCommand(original, spec)).toEqual({ command: "bwrap", args: original.args });
    expect(wrapSessionCommand(original, { ...spec, enabled: false })).toEqual(original);
  });

  it("keeps the complete contract importer inventory", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const modules = ["session_execution_policy.js", "session_isolation_contract.js"];
    const importers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(absolute, "utf8");
        if (modules.some((moduleName) => source.includes(`security/${moduleName}"`)
          || source.includes(`./${moduleName}"`))) {
          importers.push(path.relative(sourceRoot, absolute).split(path.sep).join("/"));
        }
      }
    };
    walk(sourceRoot);

    // B3b가 계약 타입을 러너 공장·턴 게이트·조립 경로까지 연결했다. 아래 목록은
    // 계약을 import하는 전체 모듈 인벤토리이며, 새 연결이 생기면 함께 갱신한다.
    expect(importers.sort()).toEqual([
      "engine/protocol.ts",
      "engine/session_isolation.ts",
      "mcp/auth.ts",
      "mcp/isolation_tool_guards.ts",
      "mcp/request_context.ts",
      "mcp/tool_access.ts",
      "mcp/tools/node_services_observation.ts",
      "mcp/transport.ts",
      "runner/frame_protocol.ts",
      "runner/runner_isolation_config.ts",
      "runner/runner_process_isolation.ts",
      "runner/session_auth_preparation.ts",
      "runner/session_filesystem_cache.ts",
      "runner/session_filesystem_git.ts",
      "runner/session_filesystem_locks.ts",
      "runner/session_filesystem_masks.ts",
      "runner/session_filesystem_plan.ts",
      "runner/session_filesystem_policy.ts",
      "runner/session_isolation_host_ports.ts",
      "runner/session_isolation_preflight.ts",
      "runner/session_isolation_process.ts",
      "runner/session_netns_helper.ts",
      "runner/session_network_policy.ts",
      "runtime/session_isolation_composition.ts",
      "security/restricted_mcp_config.ts",
      "security/session_execution_policy.ts",
      "security/session_isolation_policy.ts",
      "security/session_isolation_runtime.ts",
      "security/session_isolation_turn.ts",
      "task/task_executor.ts",
      "task/task_manager.ts",
      "task/task_models.ts",
    ]);
  });
});

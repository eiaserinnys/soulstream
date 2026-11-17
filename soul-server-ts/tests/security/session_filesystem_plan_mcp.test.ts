import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { restrictedChildEnv } from "../../src/engine/isolated_session_launch.js";
import { buildRestrictedRunnerChildEnv, isolationChildConfigFromPlan } from "../../src/runner/runner_process_isolation.js";
import { HEAVY_WORK_LOCK_PATHS } from "../../src/runner/session_filesystem_locks.js";
import { prepareIsolationPlan } from "../../src/runner/session_filesystem_plan.js";
import type { IsolationPreparationInput } from "../../src/security/session_isolation_contract.js";
import { createFakeHostPorts, touch } from "../helpers/session_isolation_host_fakes.js";
import { makeTempDir } from "../helpers/temp_dir.js";

describe("isolated session internal MCP environment", () => {
  it("carries the plan's internal MCP address through both env boundaries without the service token", async () => {
    const root = await makeTempDir("mcp-env-");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const sessionDirectory = join(root, "session");
    const codex = join(home, "credentials");
    for (const dir of [workspace, home, sessionDirectory, codex]) {
      mkdirSync(dir, { recursive: true });
    }
    touch(root, join(codex, "auth.json"), "auth");
    touch(root, join(codex, "auth.lock"), "");
    const lockFilePaths = Object.fromEntries(HEAVY_WORK_LOCK_PATHS.map((path, index) => [
      path, touch(root, `locks/${index}`, ""),
    ]));
    const ports = createFakeHostPorts({
      root,
      nodeId: "node-a",
      lockFilePaths,
      systemFacts: { "/etc/resolv.conf": { kind: "file" }, "/proc/locks": { kind: "file" } },
    });
    const input: IsolationPreparationInput = {
      decision: { sessionId: "s1", tier: "restricted", policyVersion: 1, reason: "untrusted-preset", presetId: "codex" },
      backend: "codex",
      workspaceDir: workspace,
      sessionDirectory,
      hostWorkspaceRoot: workspace,
      incomingRoot: join(root, "incoming"),
      homeDirectory: home,
      uid: 1000,
      policy: {
        version: 1,
        tools: {},
        localMcp: { requiredServerId: "soulstream", optional: [] },
        filesystem: {
          sessionWorktreeRelativeRoot: ".projects/.isolated",
          credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
          isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
          writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
          additionalSensitiveRoots: [], writableSensitiveRoots: [], readOnlyReexposedPaths: [],
        },
        testDatabases: [],
        network: { mode: "pasta-nft", dnsForward4: "192.0.2.53", deniedIpv4: [], deniedIpv6: [] },
      },
      policyDigest: "digest",
      resolvedServers: [],
      actualInternalMcpUrl: "http://127.0.0.1:3115/mcp/internal",
      ownedWorktrees: [], attachedWorktrees: [], registeredRepositories: [],
      authPreparation: { kind: "codex-grant", canonicalCodexDirectory: codex },
      scratchWorkspaceDir: join(workspace, ".local"),
    };
    const plan = await prepareIsolationPlan(input, ports);
    const serviceToken = "host-service-token";
    const runnerEnv = buildRestrictedRunnerChildEnv({
      baseEnv: { AUTH_BEARER_TOKEN: serviceToken }, plan, wsl: false,
    });
    const tools = { bwrap: "/bwrap", pasta: "/pasta", unshare: "/unshare", setpriv: "/setpriv", nft: "/nft", netnsHelper: "/helper" };
    const config = isolationChildConfigFromPlan({ plan, tools, wsl: false, attachedWorktreeIds: [] });
    for (const [key, value] of Object.entries(runnerEnv)) vi.stubEnv(key, value);
    try {
      const env = restrictedChildEnv(config, runnerEnv);
      expect(env.MCP_INTERNAL_PORT).toBe("3115");
      expect(env.MCP_PATH).toBe("/mcp");
      expect(env.AUTH_BEARER_TOKEN).toBe("ssr1.s1.fake-signature");
      expect(Object.values(env)).not.toContain(serviceToken);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

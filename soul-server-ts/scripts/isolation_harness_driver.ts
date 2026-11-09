#!/usr/bin/env node
/**
 * 카드 #1111 restricted 통합 하네스의 드라이버.
 *
 * 운영 코드를 그대로 쓴다: `composeSessionIsolation` → `applyRestrictedRunnerIsolation`
 * → `launchIsolatedSession`. 하네스가 바꾸는 것은 CLI 대신 실행하는 payload뿐이다.
 *
 * stdout에는 `HARNESS {json}` 줄과 payload의 `PAYLOAD_JSON:` 줄만 낸다.
 * 비밀값(토큰, env 값, 인증 파일 내용)은 어떤 줄에도 넣지 않는다. 사실과
 * 개수·boolean만 낸다.
 */

import { readFileSync } from "node:fs";

import type { AgentProfile } from "../src/agent_registry.js";
import type { Env } from "../src/config.js";
import { applyRestrictedRunnerIsolation } from "../src/runner/runner_process_isolation.js";
import type { SpawnRunnerProcessInput } from "../src/runner/runner_process_spawn.js";
import {
  createIsolationProcessPorts,
  launchIsolatedSession,
} from "../src/runner/session_netns_helper.js";
import { composeSessionIsolation } from "../src/runtime/session_isolation_composition.js";
import type { Task } from "../src/task/task_models.js";

interface Job {
  sessionId: string;
  backend: "opencode" | "claude";
  workspaceDir: string;
  hostWorkspaceRoot: string;
  runnerStateDir: string;
  projectsRoot: string;
  pastaPath: string;
  internalMcpPort: number;
  localMcp?: string;
  claudePair?: { tokenFile: string; accountId: string };
  hostBearerToken: string;
  registries: { repoId: string; path: string }[];
  worktrees: Record<string, unknown>[];
  taskWorktreeId?: string;
  mcpServers: unknown[];
  baseEnv: Record<string, string>;
  payload: { program: string; args: string[] };
  prepareOnly?: "prepare" | "assembly";
  prepareRuns?: number;
  abortAfterMs?: number;
  netnsHelperOverride?: string;
  nftOverride?: string;
  readyTimeoutMs?: number;
  runTimeoutMs?: number;
}

function emit(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`HARNESS ${JSON.stringify({ event, ...data })}\n`);
}

/**
 * stdout이 파이프면 쓰기가 비동기다. emit 직후 `process.exit()`를 부르면 큰
 * 줄이 잘린다. 빈 쓰기의 콜백(파이프가 비워진 시점) 뒤에 종료한다.
 */
function exitSoon(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

function describeError(error: unknown): Record<string, unknown> {
  const record = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const message = typeof record?.message === "string" ? record.message : "";
  return {
    name: typeof record?.name === "string" ? record.name : "Unknown",
    code: typeof record?.code === "string" ? record.code : null,
    message: message.slice(0, 240),
  };
}

function sanitizedServerFacts(servers: readonly unknown[]): Record<string, unknown>[] {
  return servers.map((raw) => {
    const server = raw as {
      type?: string;
      name?: string;
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
    };
    let host = null;
    let port = null;
    let path = null;
    if (typeof server.url === "string") {
      try {
        const parsed = new URL(server.url);
        host = parsed.hostname;
        port = parsed.port;
        path = parsed.pathname;
      } catch {
        host = "unparsable";
      }
    }
    return {
      type: server.type ?? null,
      name: typeof server.name === "string" ? server.name : null,
      host,
      port,
      path,
      headerKeys: Object.keys(server.headers ?? {}).sort(),
      hasEnv: server.env !== undefined,
      hasHeaders: server.headers !== undefined,
    };
  });
}

const job = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Job;

const settingsEnv = {
  SESSION_ISOLATION_MODE: "enforce",
  SESSION_ISOLATION_PASTA_PATH: job.pastaPath,
  SESSION_ISOLATION_LOCAL_MCP: job.localMcp,
  SOULSTREAM_NODE_ID: "eiaserinnys",
  AUTH_BEARER_TOKEN: job.hostBearerToken,
  MCP_INTERNAL_PORT: job.internalMcpPort,
  MCP_PATH: "/mcp",
  SOUL_RUNNER_STATE_DIR: job.runnerStateDir,
  WORKTREE_PROJECTS_ROOT: job.projectsRoot,
  ...(job.claudePair
    ? {
        ISOLATED_CLAUDE_TOKEN_FILE: job.claudePair.tokenFile,
        ISOLATED_CLAUDE_ACCOUNT_ID: job.claudePair.accountId,
      }
    : {}),
} as unknown as Env;

const agent = {
  workspace_dir: job.workspaceDir,
  env: null,
} as unknown as AgentProfile;

const task = {
  executionSecurity: {
    sessionId: job.sessionId,
    tier: "restricted",
    policyVersion: 1,
    reason: "untrusted-preset",
    presetId: null,
  },
  worktreeId: job.taskWorktreeId,
  profileWorkspaceDir: job.hostWorkspaceRoot,
} as unknown as Task;

const worktreeService = {
  async list(): Promise<Record<string, unknown>[]> {
    return job.worktrees;
  },
  listRepositoryIds(): string[] {
    return job.registries.map((entry) => entry.repoId);
  },
};

const mcpConfigService = {
  resolveMcpProfile(): { mcp_servers: unknown[]; hosted_tools: never[] } {
    return { mcp_servers: job.mcpServers, hosted_tools: [] };
  },
};

const isolation = composeSessionIsolation({
  env: settingsEnv,
  worktreeService,
  mcpConfigService,
} as never);
if (!isolation) {
  emit("fatal", { reason: "composition unavailable" });
  process.exit(2);
}

const base = {
  backend: job.backend,
  snapshotPath: new URL("./", import.meta.url).pathname.replace(/\/$/, ""),
  childProcessEnv: job.baseEnv,
} as unknown as SpawnRunnerProcessInput;

function prepareFacts(prepared: Awaited<ReturnType<typeof applyRestrictedRunnerIsolation>>) {
  const config = prepared.isolation;
  if (!config) return { isolation: null };
  const spec = config.spec;
  const childEnv = prepared.childProcessEnv ?? {};
  return {
    isolation: {
      backend: spec.backend,
      workspaceDir: spec.workspaceDir,
      scratchWorkspaceDir: spec.scratchWorkspaceDir,
      sandboxDirectory: spec.sandboxDirectory,
      sessionWorktreeRoot: spec.sessionWorktreeRoot,
      sessionId: spec.sessionId,
      authKind: spec.authKind,
      policyDigestLength: spec.policyDigest.length,
      // 전체 목록은 700건을 넘어 파이프 한 줄로 내보내면 잘린다. 개수와
      // 표본만 남긴다(축 판정은 개수와 행위 결과로 한다).
      bindingCount: spec.bindings.length,
      bindingSample: spec.bindings.slice(0, 4),
      maskCount: spec.masks.length,
      maskSample: spec.masks.slice(0, 4),
      heavyWorkLockBindings: spec.heavyWorkLockBindings,
      hostProcLocksBinding: spec.hostProcLocksBinding,
      approvedLocalMcp: spec.approvedLocalMcp,
      approvedTestDatabase: spec.approvedTestDatabase,
      envKeys: [...(config.envKeys ?? [])],
      attachedWorktreeIds: config.attachedWorktreeIds,
      wsl: config.wsl,
      tools: config.tools,
      resolvConfPath: config.resolvConfPath,
      servers: sanitizedServerFacts(prepared.resolvedMcpServers ?? []),
      childEnv: {
        authBearerPrefixOk: (childEnv.AUTH_BEARER_TOKEN ?? "").startsWith("ssr1."),
        databaseUrl: childEnv.DATABASE_URL !== undefined,
        testDatabaseUrl: childEnv.TEST_DATABASE_URL !== undefined,
        sshAuthSock: childEnv.SSH_AUTH_SOCK !== undefined,
        pm2Home: childEnv.PM2_HOME !== undefined,
        sccacheKeys: Object.keys(childEnv).filter((key) => key.startsWith("SCCACHE_")),
        gitConfigCount: childEnv.GIT_CONFIG_COUNT ?? null,
        ghTokenPresent: childEnv.GH_TOKEN !== undefined,
        ghConfigDir: childEnv.GH_CONFIG_DIR ?? null,
        claudeCodeOauthToken: childEnv.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
        codexHome: childEnv.CODEX_HOME ?? null,
        claudeConfigDir: childEnv.CLAUDE_CONFIG_DIR ?? null,
        playwrightBrowsersPath: childEnv.PLAYWRIGHT_BROWSERS_PATH ?? null,
        scratchWorkspaceDir: childEnv.SCRATCH_WORKSPACE_DIR ?? null,
        keyCount: Object.keys(childEnv).length,
      },
    },
  };
}

async function main(): Promise<void> {
  if (job.prepareOnly === "prepare") {
    const runs = job.prepareRuns ?? 1;
    const durations: number[] = [];
    let last: Awaited<ReturnType<typeof applyRestrictedRunnerIsolation>> | null = null;
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      last = await applyRestrictedRunnerIsolation(base, {
        task,
        agent,
        isolationHost: isolation!.host,
      });
      durations.push(Math.round(performance.now() - started));
    }
    emit("prepare_only", { runs: durations, ...prepareFacts(last!) });
    exitSoon(0);
    return;
  }

  if (job.prepareOnly === "assembly") {
    try {
      const prepared = await applyRestrictedRunnerIsolation(base, {
        task,
        agent,
        isolationHost: isolation!.host,
      });
      emit("assembly_ok", prepareFacts(prepared));
      exitSoon(0);
      return;
    } catch (error) {
      emit("assembly_failed", describeError(error));
      exitSoon(5);
      return;
    }
  }

  let prepared;
  try {
    prepared = await applyRestrictedRunnerIsolation(base, {
      task,
      agent,
      isolationHost: isolation!.host,
    });
  } catch (error) {
    emit("prepare_failed", describeError(error));
    exitSoon(6);
    return;
  }
  const config = prepared.isolation!;
  emit("prepared", prepareFacts(prepared));

  const abortController = job.abortAfterMs === undefined ? null : new AbortController();
  if (job.abortAfterMs !== undefined) {
    setTimeout(() => {
      emit("abort", { afterMs: job.abortAfterMs });
      abortController!.abort();
    }, job.abortAfterMs);
  }

  const tools = {
    ...config.tools,
    ...(job.netnsHelperOverride ? { netnsHelper: job.netnsHelperOverride } : {}),
    ...(job.nftOverride ? { nft: job.nftOverride } : {}),
  };
  const launch = launchIsolatedSession(
    {
      original: { command: job.payload.program, args: job.payload.args },
      plan: config.spec,
      resolvConfPath: config.resolvConfPath,
      cwd: config.spec.workspaceDir,
      env: (prepared.childProcessEnv ?? {}) as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
      tools,
      ...(abortController ? { signal: abortController.signal } : {}),
    },
    createIsolationProcessPorts(),
  );

  let payloadLines = 0;
  const stdout = launch.child.stdout;
  if (stdout) {
    stdout.setEncoding("utf8");
    let buffer = "";
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith("PAYLOAD_JSON:")) {
          payloadLines += 1;
          process.stdout.write(`${line}\n`);
        }
        index = buffer.indexOf("\n");
      }
    });
  }
  const stderr = launch.child.stderr;
  if (stderr) stderr.setEncoding("utf8");

  let disposed = false;
  const shutdown = async (code: number): Promise<void> => {
    if (!disposed) {
      disposed = true;
      await launch.dispose().catch(() => undefined);
    }
    exitSoon(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  const readyTimer = new Promise<"ready-timeout">((resolve) => {
    setTimeout(() => resolve("ready-timeout"), job.readyTimeoutMs ?? 120_000);
  });
  let readyOutcome: "ready" | "ready-timeout";
  try {
    readyOutcome = await Promise.race([
      launch.ready.then(() => "ready" as const),
      readyTimer,
    ]);
  } catch (error) {
    emit("ready_failed", {
      reason: "rejected",
      helperPid: launch.child.pid ?? null,
      ...describeError(error),
    });
    await shutdown(7);
    return;
  }
  if (readyOutcome !== "ready") {
    emit("ready_failed", { reason: "timeout", helperPid: launch.child.pid ?? null });
    await shutdown(7);
    return;
  }
  emit("ready", { helperPid: launch.child.pid ?? null, payloadProgram: job.payload.program });

  const runTimer = new Promise<"run-timeout">((resolve) => {
    setTimeout(() => resolve("run-timeout"), job.runTimeoutMs ?? 300_000);
  });
  const outcome = await Promise.race([
    launch.completion.then((value) => ({ kind: "exit" as const, ...value })),
    runTimer,
  ]);
  if (outcome === "run-timeout") {
    emit("run_timeout", { payloadLines });
    await shutdown(8);
    return;
  }
  emit("exit", {
    code: outcome.exitCode,
    signal: outcome.signal,
    payloadLines,
  });
  await shutdown(0);
}

main().catch((error) => {
  emit("fatal", describeError(error));
  exitSoon(9);
});

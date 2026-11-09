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

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentProfile } from "../src/agent_registry.js";
import { ClaudeAccountService } from "../src/claude_accounts/service.js";
import type { ClaudeProfileCredentialRenewer } from "../src/claude_accounts/credential_renewal.js";
import { readProfileCredentialsReadOnly } from "../src/claude_accounts/usage.js";
import type { Env } from "../src/config.js";
import {
  buildClaudeAccountPoolEnvironment,
  type ClaudeAccountTurnSelection,
} from "../src/engine/claude_account_pool.js";
import { applyRunnerHostCall } from "../src/runner/runner_process_runtime_factory.js";
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
  nodeId: string;
  backend: "opencode" | "claude";
  workspaceDir: string;
  hostWorkspaceRoot: string;
  runnerStateDir: string;
  projectsRoot: string;
  pastaPath: string;
  internalMcpPort: number;
  localMcp?: string;
  /**
   * 합성 계정 풀. 실제 계정·자격 파일을 읽지 않는다. `mode`가 select-only면
   * 러너를 띄우지 않고 선택 결과(또는 fail-closed)만 본다.
   */
  claudeAuth?: {
    accountsDir: string;
    homeDir: string;
    model: string;
    excludeIds: string[];
    mode?: "launch" | "select-only";
    renewFails?: boolean;
  };
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
  SOULSTREAM_NODE_ID: job.nodeId,
  AUTH_BEARER_TOKEN: job.hostBearerToken,
  MCP_INTERNAL_PORT: job.internalMcpPort,
  MCP_PATH: "/mcp",
  SOUL_RUNNER_STATE_DIR: job.runnerStateDir,
  WORKTREE_PROJECTS_ROOT: job.projectsRoot,
  ...(job.claudeAuth
    ? {
        CLAUDE_ACCOUNT_POOL_ENABLED: "true",
        CLAUDE_ACCOUNTS_DIR: job.claudeAuth.accountsDir,
      }
    : {}),
} as unknown as Env;

const agent = {
  workspace_dir: job.workspaceDir,
  env: null,
} as unknown as AgentProfile;

const task = {
  agentSessionId: job.sessionId,
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

type PreparedIsolation = Awaited<ReturnType<typeof applyRestrictedRunnerIsolation>>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 합성 계정 풀의 갱신기. 실제 CLI를 실행하지 않고 만료된 자격 파일만 새
 * 토큰으로 바꾼다. `fail`이면 아무것도 바꾸지 않아 갱신 실패를 흉내 낸다.
 */
function syntheticCredentialRenewer(options: {
  fail: boolean;
  calls: Map<string, number>;
}): ClaudeProfileCredentialRenewer {
  return {
    async renew(input: { accountId: string; profileDir: string }): Promise<void> {
      options.calls.set(input.accountId, (options.calls.get(input.accountId) ?? 0) + 1);
      if (options.fail) return;
      const accessToken = `harness-renewed-${randomBytes(18).toString("hex")}`;
      const credentialPath = join(input.profileDir, ".credentials.json");
      writeFileSync(
        credentialPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken,
            refreshToken: "harness-synthetic-refresh",
            expiresAt: Date.now() + 2 * 60 * 60_000,
          },
        }),
        { mode: 0o600 },
      );
      chmodSync(credentialPath, 0o600);
    },
  };
}

interface RestrictedSelectionResult {
  turn: ClaudeAccountTurnSelection;
  tokenSha256: string;
  launchEnv: Record<string, string>;
  facts: Record<string, unknown>;
}

/**
 * 호스트 러너가 restricted Claude 턴에서 하는 선택을 그대로 부른다. 계정
 * 풀 서비스, 자격 판정, config_dir 치환, 턴 환경 합성이 모두 운영 코드다.
 * 토큰 원문은 이 프로세스 밖으로 내보내지 않고 해시·boolean만 남긴다.
 */
async function selectRestrictedClaudeTurn(
  prepared: PreparedIsolation,
  job: Job,
  selection: { excludeIds: string[]; renewFails: boolean },
): Promise<RestrictedSelectionResult> {
  const auth = job.claudeAuth;
  const config = prepared.isolation;
  if (!auth || !config) throw new Error("claudeAuth job requires a prepared restricted runner");
  const configDirectory = join(config.spec.sandboxDirectory, "claude-config");
  mkdirSync(auth.homeDir, { recursive: true, mode: 0o700 });
  const renewCalls = new Map<string, number>();
  const service = new ClaudeAccountService({
    accountsDir: auth.accountsDir,
    homeDir: auth.homeDir,
    now: () => Date.now(),
    credentialRenewer: syntheticCredentialRenewer({
      fail: selection.renewFails,
      calls: renewCalls,
    }),
    // 선택은 네트워크를 쓰지 않는다. 실수로 나가면 실패하게 둔다.
    fetchImpl: async () => {
      throw new Error("harness account pool network disabled");
    },
  });
  const selected = await applyRunnerHostCall(
    {
      correlationId: `harness-selection-${Date.now()}`,
      service: "claude_accounts",
      operation: "select",
      args: [
        job.sessionId,
        {
          session_id: job.sessionId,
          model: auth.model,
          turn_id: "harness-turn",
          exclude_ids: selection.excludeIds,
        },
      ],
    },
    task,
    {
      async persistRunState() {
        return;
      },
      async persistSessionItems() {
        return;
      },
    },
    { claudeAccounts: service } as never,
    () => undefined,
    { configDirectory },
  ) as ClaudeAccountTurnSelection | { pool_exhausted: true };
  if ("pool_exhausted" in selected) {
    throw new Error("restricted Claude selection unexpectedly exhausted the pool");
  }
  const credential = selected.credential;
  if (!credential || credential.kind !== "access-token" || credential.access_token.length === 0) {
    throw new Error("restricted Claude selection returned no access token");
  }
  const profile = readProfileCredentialsReadOnly(
    join(auth.accountsDir, "profiles", selected.account_id),
  );
  const launchEnv = buildClaudeAccountPoolEnvironment(
    (prepared.childProcessEnv ?? {}) as Record<string, string>,
    selected,
  );
  return {
    turn: selected,
    tokenSha256: sha256Hex(credential.access_token),
    launchEnv,
    facts: {
      accountId: selected.account_id,
      configDirInSandbox: selected.config_dir === configDirectory,
      profileTokenMatchesSelection: profile?.accessToken === credential.access_token,
      envTokenMatchesSelection: launchEnv.CLAUDE_CODE_OAUTH_TOKEN === credential.access_token,
      envCredentialKeysAbsent:
        launchEnv.ANTHROPIC_API_KEY === undefined
        && launchEnv.ANTHROPIC_AUTH_TOKEN === undefined
        && launchEnv.CLAUDE_AUTH_TOKEN_PATH === undefined,
      envConfigDirMatches: launchEnv.CLAUDE_CONFIG_DIR === configDirectory,
      renewCalls: Object.fromEntries(renewCalls),
    },
  };
}

function claudeAuthPayloadArgs(
  job: Job,
  selected: RestrictedSelectionResult,
): string[] {
  const args = [...job.payload.args];
  const raw = args[2];
  const parsed = raw === undefined ? {} : JSON.parse(raw) as Record<string, unknown>;
  args[2] = JSON.stringify({
    ...parsed,
    expected_token_sha256: selected.tokenSha256,
    config_dir: selected.turn.config_dir,
    accounts_dir: job.claudeAuth!.accountsDir,
  });
  return args;
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

  let launchEnv = (prepared.childProcessEnv ?? {}) as Record<string, string>;
  let payloadArgs = [...job.payload.args];
  if (job.claudeAuth) {
    if (job.claudeAuth.mode === "select-only") {
      // 후보가 없으면 CLI를 띄우기 전에 닫혀야 한다. 여기서 실패하면
      // payload는 한 줄도 실행되지 않는다.
      try {
        await selectRestrictedClaudeTurn(prepared, job, {
          excludeIds: job.claudeAuth.excludeIds,
          renewFails: job.claudeAuth.renewFails ?? false,
        });
        emit("claude_selection_unexpected", { reason: "selection succeeded" });
        exitSoon(11);
      } catch (error) {
        emit("claude_selection_unavailable", describeError(error));
        exitSoon(0);
      }
      return;
    }
    try {
      const selected = await selectRestrictedClaudeTurn(prepared, job, {
        excludeIds: job.claudeAuth.excludeIds,
        renewFails: job.claudeAuth.renewFails ?? false,
      });
      emit("claude_selection", selected.facts);
      launchEnv = selected.launchEnv;
      payloadArgs = claudeAuthPayloadArgs(job, selected);
    } catch (error) {
      emit("claude_selection_failed", describeError(error));
      exitSoon(12);
      return;
    }
  }

  const abortController = job.abortAfterMs === undefined ? null : new AbortController();

  const tools = {
    ...config.tools,
    ...(job.netnsHelperOverride ? { netnsHelper: job.netnsHelperOverride } : {}),
    ...(job.nftOverride ? { nft: job.nftOverride } : {}),
  };
  const launch = launchIsolatedSession(
    {
      original: { command: job.payload.program, args: payloadArgs },
      plan: config.spec,
      resolvConfPath: config.resolvConfPath,
      cwd: config.spec.workspaceDir,
      env: launchEnv,
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
  stderr?.on("data", (chunk: string) => process.stderr.write(chunk));

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
  if (job.abortAfterMs !== undefined) {
    setTimeout(() => {
      emit("abort", { afterMs: job.abortAfterMs });
      abortController!.abort();
    }, job.abortAfterMs);
  }

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

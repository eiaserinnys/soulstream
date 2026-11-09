import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { IsolationAuthUnavailableError } from "../runner/session_filesystem_errors.js";
import type {
  IsolatedAuthPreparation,
  IsolationBackend,
  IsolationPolicy,
} from "./session_isolation_contract.js";
import {
  computeIsolationPolicyDigest,
  createIsolationPolicyProvider,
  type IsolationPolicyProvider,
  type LoadedIsolationPolicy,
} from "./session_isolation_policy.js";

/**
 * restricted 실행이 쓰는 도구 경로. pasta만 노드 설정에서 받는다.
 * B1이 띄우는 프로세스는 전부 이 상수에서 나온다.
 */
export const ISOLATION_TOOL_PATHS = Object.freeze({
  bwrap: "/usr/bin/bwrap",
  unshare: "/usr/bin/unshare",
  setpriv: "/usr/bin/setpriv",
  nft: "/usr/sbin/nft",
});

export type SessionIsolationMode = "off" | "enforce";

export interface SessionIsolationOptionalMcp {
  serverId: string;
  port: number;
}

export interface SessionIsolationTestDatabase {
  hostPort: number;
  sandboxPort: number;
}

/**
 * `SESSION_ISOLATION_*` 환경 설정의 해석 결과. 값은 로그·직렬화로 나가지
 * 않는다. `testDatabaseUrl`은 준비 입력에만 쓰는 메모리 전용 값이다.
 */
export interface SessionIsolationSettings {
  mode: SessionIsolationMode;
  pastaPath: string | null;
  localMcp: readonly SessionIsolationOptionalMcp[];
  testDatabase: SessionIsolationTestDatabase | null;
  testDatabaseUrl: string | null;
  /** restricted Claude OAuth가 쓸 계정 풀이 켜져 있는지. */
  claudeAccountPoolEnabled: boolean;
  /** 계정 풀의 실제 루트. restricted 자식에서는 mask 대상이다. */
  claudeAccountsDir: string | null;
}

export interface SessionIsolationSettingsEnv {
  SESSION_ISOLATION_MODE?: string | undefined;
  SESSION_ISOLATION_PASTA_PATH?: string | undefined;
  SESSION_ISOLATION_LOCAL_MCP?: string | undefined;
  SESSION_ISOLATION_TEST_DATABASE?: string | undefined;
  SESSION_ISOLATION_TEST_DATABASE_URL?: string | undefined;
  CLAUDE_ACCOUNT_POOL_ENABLED?: string | boolean | undefined;
  CLAUDE_ACCOUNTS_DIR?: string | undefined;
}

export class SessionIsolationConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SessionIsolationConfigError";
  }
}

/** `serverId:port` 쉼표 목록. 형식 오류는 설정 오류다. */
export function parseIsolationLocalMcpList(
  raw: string | undefined,
): SessionIsolationOptionalMcp[] {
  if (raw === undefined) return [];
  const entries: SessionIsolationOptionalMcp[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new SessionIsolationConfigError(
        "SESSION_ISOLATION_LOCAL_MCP entries must be serverId:port",
      );
    }
    const serverId = trimmed.slice(0, separator).trim();
    const port = parsePort(trimmed.slice(separator + 1));
    if (!serverId) {
      throw new SessionIsolationConfigError(
        "SESSION_ISOLATION_LOCAL_MCP entries must be serverId:port",
      );
    }
    if (port === null) {
      throw new SessionIsolationConfigError(
        `SESSION_ISOLATION_LOCAL_MCP port is invalid for server ${serverId}`,
      );
    }
    entries.push({ serverId, port });
  }
  return entries;
}

/** `hostPort:sandboxPort` 한 쌍. 형식 오류는 설정 오류다. */
export function parseIsolationTestDatabasePair(
  raw: string | undefined,
): SessionIsolationTestDatabase | null {
  if (raw === undefined) return null;
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new SessionIsolationConfigError(
      "SESSION_ISOLATION_TEST_DATABASE must be hostPort:sandboxPort",
    );
  }
  const hostPort = parsePort(parts[0]!);
  const sandboxPort = parsePort(parts[1]!);
  if (hostPort === null || sandboxPort === null) {
    throw new SessionIsolationConfigError(
      "SESSION_ISOLATION_TEST_DATABASE ports must be 1..65535",
    );
  }
  return { hostPort, sandboxPort };
}

function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

export function sessionIsolationSettingsFromEnv(
  env: SessionIsolationSettingsEnv,
  platform: NodeJS.Platform = process.platform,
): SessionIsolationSettings {
  const mode = parseMode(env.SESSION_ISOLATION_MODE);
  const pastaPath = env.SESSION_ISOLATION_PASTA_PATH ?? null;
  if (mode === "enforce" && platform !== "win32") {
    if (!pastaPath) {
      throw new SessionIsolationConfigError(
        "SESSION_ISOLATION_PASTA_PATH is required when SESSION_ISOLATION_MODE=enforce",
      );
    }
    if (!isAbsolute(pastaPath)) {
      throw new SessionIsolationConfigError(
        "SESSION_ISOLATION_PASTA_PATH must be an absolute path",
      );
    }
  }
  if (pastaPath !== null && pastaPath.trim() === "") {
    throw new SessionIsolationConfigError("SESSION_ISOLATION_PASTA_PATH must not be empty");
  }
  assertPair(
    env.SESSION_ISOLATION_TEST_DATABASE,
    env.SESSION_ISOLATION_TEST_DATABASE_URL,
    "SESSION_ISOLATION_TEST_DATABASE",
    "SESSION_ISOLATION_TEST_DATABASE_URL",
  );
  return {
    mode,
    pastaPath: env.SESSION_ISOLATION_PASTA_PATH ?? null,
    localMcp: parseIsolationLocalMcpList(env.SESSION_ISOLATION_LOCAL_MCP),
    testDatabase: parseIsolationTestDatabasePair(env.SESSION_ISOLATION_TEST_DATABASE),
    testDatabaseUrl: env.SESSION_ISOLATION_TEST_DATABASE_URL ?? null,
    claudeAccountPoolEnabled:
      env.CLAUDE_ACCOUNT_POOL_ENABLED === true
      || env.CLAUDE_ACCOUNT_POOL_ENABLED === "true",
    claudeAccountsDir:
      env.CLAUDE_ACCOUNTS_DIR !== undefined && env.CLAUDE_ACCOUNTS_DIR !== ""
        ? env.CLAUDE_ACCOUNTS_DIR
        : null,
  };
}

function parseMode(raw: string | undefined): SessionIsolationMode {
  if (raw === undefined || raw === "") return "off";
  if (raw === "off" || raw === "enforce") return raw;
  throw new SessionIsolationConfigError(
    "SESSION_ISOLATION_MODE must be off or enforce",
  );
}

function assertPair(
  left: string | undefined,
  right: string | undefined,
  leftKey: string,
  rightKey: string,
): void {
  const hasLeft = left !== undefined && left !== "";
  const hasRight = right !== undefined && right !== "";
  if (hasLeft !== hasRight) {
    throw new SessionIsolationConfigError(`${leftKey} and ${rightKey} must be set together`);
  }
}

/**
 * 유효 정책 = 정책 파일 + 노드 env 병합. digest는 병합 결과로 계산한다.
 * 더할 것이 없으면 파일 정책 객체를 그대로 돌려주어 digest도 같다.
 */
export function applyNodeIsolationPolicy(
  base: IsolationPolicy,
  settings: Pick<SessionIsolationSettings, "localMcp" | "testDatabase">,
  nodeId: string,
): IsolationPolicy {
  const extraServers = settings.localMcp.map((entry) => ({
    serverId: entry.serverId,
    nodeId,
    port: entry.port,
  }));
  const extraDatabases = settings.testDatabase
    ? [{ nodeId, ...settings.testDatabase }]
    : [];
  if (extraServers.length === 0 && extraDatabases.length === 0) return base;
  return {
    ...base,
    localMcp: {
      ...base.localMcp,
      optional: [...base.localMcp.optional, ...extraServers],
    },
    testDatabases: [...base.testDatabases, ...extraDatabases],
  };
}

export interface SessionIsolationPolicySource {
  get(): LoadedIsolationPolicy;
}

export interface SessionIsolationPolicySourceDeps {
  provider?: IsolationPolicyProvider;
  path?: string;
  readFile?: (path: string) => string;
}

export function createSessionIsolationPolicySource(
  settings: Pick<SessionIsolationSettings, "localMcp" | "testDatabase">,
  nodeId: string,
  deps: SessionIsolationPolicySourceDeps = {},
): SessionIsolationPolicySource {
  const provider = deps.provider ?? createIsolationPolicyProvider(
    deps.path !== undefined
      ? { path: deps.path, ...(deps.readFile ? { readFile: deps.readFile } : {}) }
      : (deps.readFile ? { readFile: deps.readFile } : {}),
  );
  let cached: LoadedIsolationPolicy | undefined;
  return {
    get(): LoadedIsolationPolicy {
      if (cached) return cached;
      const base = provider.get();
      const policy = applyNodeIsolationPolicy(base.policy, settings, nodeId);
      cached = policy === base.policy
        ? base
        : { policy, digest: computeIsolationPolicyDigest(policy) };
      return cached;
    },
  };
}

export interface IsolationAuthClassificationInput {
  backend: IsolationBackend | string;
  presetEnv?: Record<string, string> | null;
  homeDirectory?: string;
  policy: IsolationPolicy;
  claudeAccountPoolEnabled: boolean;
  claudeAccountsDir: string | null;
}

/**
 * restricted 자식이 받을 자격 증명 종류를 고른다. 프리셋 ID를 하드코딩하지
 * 않고 프리셋 env와 backend만 본다. 값은 담지 않는다.
 */
export function classifyIsolatedAuth(
  input: IsolationAuthClassificationInput,
): IsolatedAuthPreparation {
  const backend = input.backend;
  if (backend === "codex") {
    const home = input.homeDirectory ?? homedir();
    return {
      kind: "codex-grant",
      canonicalCodexDirectory: join(
        home,
        input.policy.filesystem.credentialRelativeDirectory,
      ),
    };
  }
  if (backend === "opencode") {
    return { kind: "apikey-env" };
  }
  if (backend === "claude") {
    if (hasAnthropicApiKeyEnv(input.presetEnv)) {
      return { kind: "apikey-env" };
    }
    if (!input.claudeAccountPoolEnabled || !input.claudeAccountsDir) {
      throw new IsolationAuthUnavailableError(
        "격리 Claude OAuth 실행에는 Claude 계정 풀이 필요합니다.",
      );
    }
    return { kind: "claude-oauth-token" };
  }
  // antigravity 등 격리 불가 backend. 호출부가 이 값으로 그 턴을 거부한다.
  return { kind: "unavailable" };
}

function hasAnthropicApiKeyEnv(env: Record<string, string> | null | undefined): boolean {
  if (!env) return false;
  return Boolean(env.ANTHROPIC_API_KEY) || Boolean(env.ANTHROPIC_AUTH_TOKEN);
}

export interface SessionIsolationRuntime {
  mode: SessionIsolationMode;
  settings: SessionIsolationSettings;
  nodeId: string;
  tools: typeof ISOLATION_TOOL_PATHS & { pasta: string | null };
  policySource: SessionIsolationPolicySource;
  classifyAuth(
    input: Omit<
      IsolationAuthClassificationInput,
      "policy" | "claudeAccountPoolEnabled" | "claudeAccountsDir"
    >,
  ): IsolatedAuthPreparation;
}

export interface CreateSessionIsolationRuntimeOptions {
  nodeId: string;
  settings: SessionIsolationSettings;
  policySource?: SessionIsolationPolicySource;
  policyPath?: string;
  readPolicyFile?: (path: string) => string;
  platform?: NodeJS.Platform;
}

export function createSessionIsolationRuntime(
  options: CreateSessionIsolationRuntimeOptions,
): SessionIsolationRuntime {
  const policySource = options.policySource
    ?? createSessionIsolationPolicySource(options.settings, options.nodeId, {
      ...(options.policyPath !== undefined ? { path: options.policyPath } : {}),
      ...(options.readPolicyFile ? { readFile: options.readPolicyFile } : {}),
    });
  const runtime: SessionIsolationRuntime = {
    mode: options.settings.mode,
    settings: options.settings,
    nodeId: options.nodeId,
    tools: {
      ...ISOLATION_TOOL_PATHS,
      pasta: options.settings.pastaPath,
    },
    policySource,
    classifyAuth(input) {
      const { policy } = policySource.get();
      return classifyIsolatedAuth({
        ...input,
        policy,
        claudeAccountPoolEnabled: options.settings.claudeAccountPoolEnabled,
        claudeAccountsDir: options.settings.claudeAccountsDir,
      });
    },
  };
  return runtime;
}

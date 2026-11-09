import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { Logger } from "pino";

import type { RunnerIsolationChildConfig } from "../runner/runner_isolation_config.js";
import { buildRestrictedSessionEnv } from "../runner/session_env.js";
import { SessionIsolationUnavailableError } from "../runner/session_filesystem_errors.js";
import {
  createIsolationProcessPorts,
  launchIsolatedSession,
} from "../runner/session_netns_helper.js";

/**
 * 자식 쪽 마지막 경계. 러너 프로세스 환경에 이미 들어 있는 세션 추가분을
 * 키 이름으로만 골라 CLI 환경에 다시 합성하고, RESTRICTED_ENV_REMOVED_KEYS는
 * 이 자리에서 한 번 더 지운다.
 */
export function restrictedChildEnv(
  isolation: RunnerIsolationChildConfig,
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const additions: Record<string, string> = {};
  for (const key of isolation.envKeys) {
    const value = process.env[key];
    if (value !== undefined) additions[key] = value;
  }
  const restrictedCredential = process.env.AUTH_BEARER_TOKEN;
  if (!restrictedCredential) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: restricted runner is missing its session credential",
    );
  }
  return buildRestrictedSessionEnv({
    baseEnv,
    additions,
    restrictedCredential,
    fullSecrets: [],
    wsl: isolation.wsl,
  });
}

/** 어댑터 셋이 모두 stdio=pipe로 띄우므로 스트림이 반드시 있다. */
export type IsolatedChildProcess = ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export interface IsolatedChildLaunch {
  child: IsolatedChildProcess;
  ready: Promise<void>;
  dispose(): Promise<void>;
  /** ready가 거부됐으면 그 오류. CLI 종료 뒤 어댑터가 턴 오류로 쓴다. */
  failure(): Error | undefined;
}

export interface LaunchIsolatedChildInput {
  isolation: RunnerIsolationChildConfig;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdio: SpawnOptions["stdio"];
  signal?: AbortSignal;
  logger: Pick<Logger, "warn">;
}

/** 어댑터 셋이 공유하는 유일한 실제 프로세스 생성 경로. */
export function launchIsolatedChild(input: LaunchIsolatedChildInput): IsolatedChildLaunch {
  let result: ReturnType<typeof launchIsolatedSession>;
  try {
    result = launchIsolatedSession({
      original: { command: input.command, args: [...input.args] },
      plan: input.isolation.spec,
      resolvConfPath: input.isolation.resolvConfPath,
      cwd: input.cwd ?? process.cwd(),
      env: restrictedChildEnv(input.isolation, input.env ?? process.env),
      stdio: input.stdio,
      ...(input.signal ? { signal: input.signal } : {}),
      tools: input.isolation.tools,
    }, createIsolationProcessPorts());
  } catch (error) {
    throw isolationError(error);
  }
  let failure: Error | undefined;
  const ready = result.ready.catch((error: unknown) => {
    failure = isolationError(error);
    input.logger.warn({ err: failure }, "isolated session failed before its CLI started");
    throw failure;
  });
  // B1이 ready 실패에서 이미 dispose한다. 이 거부는 여기서 관측만 유지한다.
  void ready.catch(() => undefined);
  return {
    child: requirePipedChild(result.child),
    ready,
    dispose: result.dispose,
    failure: () => failure,
  };
}

function requirePipedChild(child: ChildProcess): IsolatedChildProcess {
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: isolated child was spawned without piped stdio",
    );
  }
  return Object.assign(child, { stdin, stdout, stderr });
}

/** 턴 실패 메시지에 코드가 남도록 항상 SESSION_ISOLATION_UNAVAILABLE을 붙인다. */
export function isolationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("SESSION_ISOLATION_UNAVAILABLE")) {
    return error instanceof Error ? error : new SessionIsolationUnavailableError(message, error);
  }
  return new SessionIsolationUnavailableError(`SESSION_ISOLATION_UNAVAILABLE: ${message}`, error);
}

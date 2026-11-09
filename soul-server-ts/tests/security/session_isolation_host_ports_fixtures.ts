import { join } from "node:path";

import type { IsolationHostPortDependencies } from "../../src/runner/session_isolation_host_ports.js";

/**
 * 실제 호스트 포트 시험용 의존성. 외부 명령(gh, git, pnpm, codex)은 언제나
 * 가짜 runCommand로만 부르며, 등록하지 않은 명령은 실행 대신 즉시 실패한다.
 * 파일 시험은 호출한 시험이 만든 임시 디렉터리 안에서만 한다.
 */

export const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const OTHER_SESSION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const HOST_BEARER_TOKEN = "host-bearer-token-for-test";
export const INTERNAL_MCP_URL = "http://127.0.0.1:3115/mcp/internal";

export type RunCommand = NonNullable<IsolationHostPortDependencies["runCommand"]>;
export type RunCommandResult = Awaited<ReturnType<RunCommand>>;
export type RunCommandOptions = Parameters<RunCommand>[2];

export interface RecordedCommand {
  command: string;
  args: readonly string[];
  options: RunCommandOptions;
}

export interface RecordingRunCommand {
  runCommand: RunCommand;
  calls: RecordedCommand[];
}

/** handler가 없으면 어떤 외부 명령도 실행하지 않고 즉시 실패한다. */
export function createRecordingRunCommand(
  handler?: (command: string, args: readonly string[]) => RunCommandResult,
): RecordingRunCommand {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    async runCommand(command, args, options) {
      calls.push({ command, args, options });
      if (!handler) {
        throw new Error(`테스트에 등록되지 않은 외부 명령입니다: ${command}`);
      }
      return handler(command, args);
    },
  };
}

export function createDeps(
  root: string,
  overrides: Partial<IsolationHostPortDependencies> = {},
): IsolationHostPortDependencies {
  const defaults: IsolationHostPortDependencies = {
    sessionId: SESSION_ID,
    nodeId: "node-a",
    hostBearerToken: HOST_BEARER_TOKEN,
    actualInternalMcpUrl: INTERNAL_MCP_URL,
    homeDirectory: join(root, "home"),
    uid: process.getuid?.() ?? 1000,
    agentCommonFilesDirectory: null,
    serviceEnvironmentDirectory: null,
    codexExecutable: null,
    osreleasePath: join(root, "proc-sys-kernel-osrelease"),
    runCommand: createRecordingRunCommand().runCommand,
  };
  return {
    ...defaults,
    ...overrides,
    runCommand: overrides.runCommand ?? defaults.runCommand,
    osreleasePath: overrides.osreleasePath ?? defaults.osreleasePath,
  };
}

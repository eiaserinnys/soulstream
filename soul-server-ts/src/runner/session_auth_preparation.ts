import { isAbsolute, join } from "node:path";

import type {
  IsolatedAuthPreparation,
  IsolationHostPorts,
  IsolationMask,
  IsolationPreparationInput,
  MountBinding,
  RestrictedAuthKind,
} from "../security/session_isolation_contract.js";
import {
  IsolationAuthUnavailableError,
  IsolationPreparationPolicyError,
} from "./session_filesystem_errors.js";

export interface RestrictedAuthPlan {
  kind: RestrictedAuthKind;
  env: Record<string, string>;
  bindings: MountBinding[];
  masks: IsolationMask[];
}

function requireAbsolute(path: string | undefined, label: string): string {
  if (!path || !isAbsolute(path)) {
    throw new IsolationAuthUnavailableError(`${label} 경로가 준비되지 않았습니다`);
  }
  return path;
}

function preparationFor(
  preparation: IsolatedAuthPreparation,
  expected: RestrictedAuthKind,
): IsolatedAuthPreparation {
  if (preparation.kind !== expected) {
    throw new IsolationAuthUnavailableError(
      `인증 준비 종류가 backend와 맞지 않습니다: ${preparation.kind}`,
    );
  }
  return preparation;
}

async function prepareCodexGrant(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  sandboxDirectory: string,
): Promise<RestrictedAuthPlan> {
  const preparation = preparationFor(input.authPreparation, "codex-grant");
  const canonicalDirectory = requireAbsolute(
    preparation.canonicalCodexDirectory,
    "canonical Codex 인증 디렉터리",
  );
  await ports.verifyAuthPreparation(preparation);

  const codexHome = join(sandboxDirectory, "codex-home");
  await ports.ensureDirectory(codexHome, 0o700);
  const canonicalAuthJson = join(canonicalDirectory, "auth.json");
  const canonicalAuthLock = join(canonicalDirectory, "auth.lock");
  await ports.ensureSymlink(canonicalAuthJson, join(codexHome, "auth.json"));
  await ports.ensureSymlink(canonicalAuthLock, join(codexHome, "auth.lock"));

  const [linkedAuthJson, linkedAuthLock] = await Promise.all([
    ports.readSymlink(join(codexHome, "auth.json")),
    ports.readSymlink(join(codexHome, "auth.lock")),
  ]);
  if (linkedAuthJson !== canonicalAuthJson || linkedAuthLock !== canonicalAuthLock) {
    throw new IsolationAuthUnavailableError(
      "전용 CODEX_HOME의 인증 symlink가 canonical 파일을 가리키지 않습니다",
    );
  }

  return {
    kind: "codex-grant",
    env: { CODEX_HOME: codexHome },
    bindings: [{
      source: canonicalDirectory,
      destination: canonicalDirectory,
      writable: true,
    }],
    masks: [],
  };
}

async function prepareClaude(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  sandboxDirectory: string,
): Promise<RestrictedAuthPlan> {
  // restricted Claude의 설정 디렉터리는 sandbox 안에 두고 RW로 다시 연다.
  // 계정이 바뀌어도 이 경로는 그대로이며, CLI가 쓰는 projects/를 미리 만든다.
  const configDirectory = join(sandboxDirectory, "claude-config");
  await ports.ensureDirectory(configDirectory, 0o700);
  await ports.ensureDirectory(join(configDirectory, "projects"), 0o700);
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDirectory };

  if (input.authPreparation.kind === "apikey-env") {
    // 기존 preset/provider API key env는 B3가 원본 환경에서 그대로 넘긴다.
    return { kind: "apikey-env", env, bindings: [], masks: [] };
  }

  // OAuth 접근 토큰은 시작 env에 넣지 않는다. 턴마다 계정 풀 선택 응답으로만
  // 자식 환경에 들어가고, refreshToken·프로필 원본은 상자에 들어가지 않는다.
  preparationFor(input.authPreparation, "claude-oauth-token");
  return { kind: "claude-oauth-token", env, bindings: [], masks: [] };
}

function prepareOpenCodeApiKey(): RestrictedAuthPlan {
  // OpenCode free는 무인증 provider 동작을 유지한다. 없는 key를 요구하지 않는다.
  return { kind: "apikey-env", env: {}, bindings: [], masks: [] };
}

/** backend별 restricted 인증 재료를 준비한다. 값은 env에만 담는다. */
export async function prepareRestrictedAuth(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  sandboxDirectory: string,
): Promise<RestrictedAuthPlan> {
  switch (input.backend) {
    case "codex":
      return prepareCodexGrant(input, ports, sandboxDirectory);
    case "claude":
      return prepareClaude(input, ports, sandboxDirectory);
    case "opencode":
      return prepareOpenCodeApiKey();
    case "antigravity":
      throw new IsolationAuthUnavailableError(
        "restricted Antigravity 세션은 지원하지 않습니다",
      );
    default:
      throw new IsolationPreparationPolicyError(
        `알 수 없는 isolation backend입니다: ${String(input.backend)}`,
      );
  }
}

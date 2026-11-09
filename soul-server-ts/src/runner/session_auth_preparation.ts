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

async function maskedSecretFile(
  ports: IsolationHostPorts,
  tokenFile: string,
): Promise<IsolationMask[]> {
  const fact = await ports.lstatPath(tokenFile);
  if (!fact || (fact.kind !== "file" && fact.kind !== "symlink")) {
    throw new IsolationAuthUnavailableError("Claude token 파일이 일반 파일이 아닙니다");
  }
  // bwrap은 symlink destination에 mount하지 못한다. token이 symlink면
  // 실경로만 가린다(실경로가 가려지면 alias로도 읽히지 않는다).
  let real: string;
  try {
    real = await ports.resolveRealPath(tokenFile);
  } catch {
    throw new IsolationAuthUnavailableError("Claude token symlink의 실경로가 없습니다");
  }
  const realFact = await ports.lstatPath(real);
  if (!realFact || realFact.kind !== "file") {
    throw new IsolationAuthUnavailableError("Claude token 실경로가 일반 파일이 아닙니다");
  }
  return [{ path: real, kind: "file" }];
}

async function prepareClaude(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  sandboxDirectory: string,
): Promise<RestrictedAuthPlan> {
  const configDirectory = join(sandboxDirectory, "claude-config");
  await ports.ensureDirectory(configDirectory, 0o700);
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDirectory };

  if (input.authPreparation.kind === "apikey-env") {
    // 기존 preset/provider API key env는 B3가 원본 환경에서 그대로 넘긴다.
    return { kind: "apikey-env", env, bindings: [], masks: [] };
  }

  const preparation = preparationFor(input.authPreparation, "claude-oauth-token");
  const tokenFile = requireAbsolute(preparation.claudeTokenFile, "Claude token 파일");
  await ports.verifyAuthPreparation(preparation);
  const token = await ports.readClaudeOauthToken();
  if (token.length === 0) {
    throw new IsolationAuthUnavailableError("Claude OAuth token이 비어 있습니다");
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = token;

  return {
    kind: "claude-oauth-token",
    env,
    bindings: [],
    masks: await maskedSecretFile(ports, tokenFile),
  };
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

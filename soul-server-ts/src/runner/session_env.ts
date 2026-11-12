import { join } from "node:path";

import { IsolationPreparationPolicyError } from "./session_filesystem_errors.js";

/**
 * §11: host 관리 환경에서 restricted CLI로 넘기지 않는 키.
 * AUTH_BEARER_TOKEN과 TEST_DATABASE_URL은 제거 뒤 승인된 값으로 다시 넣는다.
 */
export const RESTRICTED_ENV_REMOVED_KEYS = [
  "AUTH_BEARER_TOKEN",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "PM2_HOME",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
] as const;

/** host cache launcher가 남기는 접두사. 값은 읽지 않고 키만 지운다. */
export const RESTRICTED_ENV_REMOVED_KEY_PREFIXES = ["SCCACHE_"] as const;

/** §8: 세션 git이 원본 저장소를 유지보수하지 않도록 합치는 설정. */
const RESTRICTED_GIT_CONFIGURATION: readonly (readonly [string, string])[] = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["fetch.writeCommitGraph", "false"],
];

export interface RestrictedSessionEnvInput {
  /** 원본 세션 환경. 수정하지 않는다. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** B2가 만든 세션 추가분(모델 인증, GH, ssr1, 승인 시험 DB, 캐시). */
  additions: Readonly<Record<string, string>>;
  /** 현재 세션의 ssr1. AUTH_BEARER_TOKEN 자리를 대체한다. */
  restrictedCredential: string;
  /** host full 비밀값. 다른 키에 복제되었는지 값 비교에만 쓴다. */
  fullSecrets: readonly string[];
  wsl: boolean;
}

function isRemovedKey(key: string): boolean {
  if ((RESTRICTED_ENV_REMOVED_KEYS as readonly string[]).includes(key)) return true;
  return RESTRICTED_ENV_REMOVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function mergeRestrictedGitConfiguration(env: Record<string, string>): void {
  const rawCount = env.GIT_CONFIG_COUNT;
  let count = 0;
  if (rawCount !== undefined && rawCount !== "") {
    const parsed = Number(rawCount);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new IsolationPreparationPolicyError("GIT_CONFIG_COUNT 형식이 잘못되었습니다");
    }
    count = parsed;
    for (let index = 0; index < count; index += 1) {
      if (env[`GIT_CONFIG_KEY_${index}`] === undefined) {
        throw new IsolationPreparationPolicyError(
          `GIT_CONFIG_KEY_${index}가 없습니다`,
        );
      }
    }
  }

  for (const [key, value] of RESTRICTED_GIT_CONFIGURATION) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
}

/**
 * 서비스 PATH에는 ~/.cargo/bin이 없고 상자 안 CLI는 로그인 셸을 거치지 않아
 * rustup이 넣은 cargo/rustc를 찾지 못한다. HOME 기준으로 보강한다(카드 #1244).
 * 이 함수는 서버, 상자 안 runner, Codex 전송에서 여러 번 거치므로 이미 있으면 그대로 둔다.
 */
function prependCargoBinToPath(env: Record<string, string>): void {
  const home = env.HOME;
  const path = env.PATH;
  if (!home || !path) return;
  const cargoBin = join(home, ".cargo", "bin");
  if (path.split(":").includes(cargoBin)) return;
  env.PATH = `${cargoBin}:${path}`;
}

/**
 * §11 restricted env의 최종 경계. 원본 세션 환경에서 관리 자격을 지우고
 * 목적별 예외만 더한 뒤, full 비밀값이 다른 키로 복제되었는지 값으로 확인한다.
 * 비밀값은 오류 메시지에 넣지 않는다.
 */
export function buildRestrictedSessionEnv(
  input: RestrictedSessionEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(input.additions)) {
    env[key] = value;
  }

  // base와 additions를 합친 결과 전체에 §11 제거 정책을 다시 적용한다.
  // additions로 관리 자격이 되살아나지 않게 하는 경계다. 예외는 승인된
  // 시험 DB와 격리 캐시의 SCCACHE_DIR 둘이고, 둘 다 additions가 제공한 경우에만 남긴다.
  const keepsTestDatabase = Object.prototype.hasOwnProperty.call(
    input.additions,
    "TEST_DATABASE_URL",
  );
  // 노드 cargo 설정이 sccache를 걸 때 상자 안 cargo가 읽기 전용 노드 캐시 대신
  // 쓰기 가능한 격리 캐시를 쓰도록, additions가 준 SCCACHE_DIR 하나만 남긴다(카드 #1232).
  const keepsSccacheDirectory = Object.prototype.hasOwnProperty.call(
    input.additions,
    "SCCACHE_DIR",
  );
  for (const key of Object.keys(env)) {
    if (!isRemovedKey(key)) continue;
    if (key === "TEST_DATABASE_URL" && keepsTestDatabase) continue;
    if (key === "SCCACHE_DIR" && keepsSccacheDirectory) continue;
    delete env[key];
  }

  env.AUTH_BEARER_TOKEN = input.restrictedCredential;
  if (input.wsl) delete env.WSL_INTEROP;

  mergeRestrictedGitConfiguration(env);

  // 보강된 PATH도 아래 full 비밀값 검사를 거치도록 검사 앞에 둔다.
  prependCargoBinToPath(env);

  const forbidden = new Set(input.fullSecrets.filter((value) => value.length > 0));
  if (forbidden.has(input.restrictedCredential)) {
    throw new IsolationPreparationPolicyError(
      "restricted 자격 증명이 host full 비밀값과 같습니다",
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (!forbidden.has(value)) continue;
    throw new IsolationPreparationPolicyError(
      `환경변수 ${key}에 host full 비밀값이 복제되었습니다`,
    );
  }

  return env;
}
